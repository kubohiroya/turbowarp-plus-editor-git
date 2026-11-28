import * as git from 'isomorphic-git';
import type {GitProxySession} from '@kubohiroya/turbowarp-plus-editor-auth';
import {createReadOnlyFs, fileError, pathParts} from './filesystem.js';
import {withGitMutationLock} from './local-operations.js';
import {checkConnection, remoteUrl} from './smart-http.js';

/**
 * Renames the GitHub repository of a project through the connection's proxy (the keybroker Worker or the Desktop
 * loopback proxy, `POST /v1/github/<owner>/<repo>/name`), then rewrites the project's `origin` to the new name. The
 * proxy keeps the GitHub token; this client sends only the new name.
 */

const proxyCodes = {
    400: ['BAD_REQUEST'],
    401: ['SESSION_REQUIRED', 'SESSION_EXPIRED', 'REAUTH_REQUIRED'],
    403: ['FORBIDDEN', 'ADMINISTRATION_PERMISSION_REQUIRED'],
    // A proxy without the route group answers 404 too, so an unnamed 404 means the route is unavailable.
    404: ['GITHUB_API_UNAVAILABLE'],
    409: ['REPOSITORY_NAME_UNAVAILABLE', 'REDIRECT_REJECTED'],
    429: ['RATE_LIMITED'],
    500: ['GITHUB_API_MISCONFIGURED'],
    502: ['UPSTREAM_FAILURE'],
    504: ['UPSTREAM_TIMEOUT']
} as const;

type ProxyCode = (typeof proxyCodes)[keyof typeof proxyCodes][number];
export type RepositoryRenameErrorCode = ProxyCode | 'INVALID_NAME' | 'INVALID_REMOTE' | 'INVALID_CONNECTION' |
    'INVALID_SESSION' | 'SESSION_UNAVAILABLE' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' | 'ORIGIN_CHANGED';

// Codes after which GitHub may or may not have renamed the repository. Retrying with the same name completes it.
const unknownCodes: readonly RepositoryRenameErrorCode[] = ['UPSTREAM_FAILURE', 'UPSTREAM_TIMEOUT', 'NETWORK_ERROR',
    'INVALID_RESPONSE'];

export class RepositoryRenameError extends Error {
    constructor(readonly code: RepositoryRenameErrorCode, readonly options: {
        status?: number; requestId?: string; retryAfter?: number;
    } = {}) {
        super(code);
        this.name = 'RepositoryRenameError';
    }
    /** The request was sent and GitHub may have renamed the repository. */
    get unknown() {return unknownCodes.includes(this.code);}
    get retryAfter() {return this.options.retryAfter;}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const requestIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const ownerPattern = /^[A-Za-z0-9][A-Za-z0-9-]*$/u;

/**
 * Whether GitHub accepts `name` as a repository name: letters, digits, `-`, `_` and `.`, at most 100 characters,
 * not `.` or `..`, without the `.git` suffix. The project's save name follows the same rule.
 */
export function isRepositoryName(name: string) {
    return name.length > 0 && name.length <= 100 && /^[A-Za-z0-9_.-]+$/u.test(name) && name !== '.' && name !== '..' &&
        !name.toLowerCase().endsWith('.git');
}

/** The owner and name of a GitHub remote. */
export function remoteRepository(remote: string) {
    const normalized = remoteUrl(remote);
    const [owner, repo] = normalized.slice('https://github.com/'.length, -'.git'.length).split('/');
    return {owner, repo, remote: normalized};
}

export interface RenamedRepository {
    /** The normalised new remote, `https://github.com/<owner>/<repo>.git`. */
    readonly remote: string;
    readonly owner: string;
    readonly repo: string;
    readonly repositoryId: number;
}

export interface RepositoryRenameOptions {
    /** The repository's current GitHub HTTPS remote, as the connection was made for it. */
    readonly remote: string;
    readonly name: string;
    /** The connection's write session for `remote`. */
    readonly getSession: (remote: string, write: boolean) => Promise<GitProxySession | null>;
    readonly fetch?: typeof fetch;
    readonly signal?: AbortSignal;
}

/** Asks the connection's proxy to rename the repository. The proxy binds the session to the new name. */
export async function renameRemoteRepository({remote, name, getSession, fetch: send = (...args) => fetch(...args),
    signal}: RepositoryRenameOptions): Promise<RenamedRepository> {
    if (!isRepositoryName(name)) throw new RepositoryRenameError('INVALID_NAME');
    let current: ReturnType<typeof remoteRepository>;
    try {
        current = remoteRepository(remote);
    } catch {
        throw new RepositoryRenameError('INVALID_REMOTE');
    }
    let session: GitProxySession | null;
    try {
        session = await getSession(remote, true);
    } catch {
        throw new RepositoryRenameError('SESSION_UNAVAILABLE');
    }
    if (!session) throw new RepositoryRenameError('SESSION_REQUIRED');
    if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now())
        throw new RepositoryRenameError('SESSION_EXPIRED');
    try {
        checkConnection(session.connection);
    } catch {
        throw new RepositoryRenameError('INVALID_CONNECTION');
    }
    if (typeof session.bearer !== 'string' || !/^[A-Za-z0-9._~+\/-]+=*$/u.test(session.bearer))
        throw new RepositoryRenameError('INVALID_SESSION');
    let response: Response;
    try {
        response = await send(`${session.connection.proxyOrigin}/v1/github/${current.owner}/${current.repo}/name`, {
            method: 'POST', signal, body: JSON.stringify({name}),
            headers: {Authorization: 'Bearer ' + session.bearer, Accept: 'application/json', 'Content-Type': 'application/json'},
            credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer'
        });
    } catch {
        throw new RepositoryRenameError('NETWORK_ERROR');
    }
    const json = response.headers.get('content-type')?.split(';')[0].trim() === 'application/json';
    let parsed: unknown = null;
    try {
        parsed = json ? JSON.parse(await response.text()) : null;
    } catch {
        // An untrusted body never becomes part of a client error.
    }
    if (response.status !== 200) {
        const allowed: readonly ProxyCode[] | undefined = proxyCodes[response.status as keyof typeof proxyCodes];
        let code: RepositoryRenameErrorCode = allowed?.[0] ?? 'UPSTREAM_FAILURE';
        let requestId: string | undefined, retryAfter: number | undefined;
        if (isRecord(parsed)) {
            if (allowed?.includes(parsed.code as ProxyCode)) code = parsed.code as ProxyCode;
            if (typeof parsed.requestId === 'string' && requestIdPattern.test(parsed.requestId)) requestId = parsed.requestId;
            if (Number.isSafeInteger(parsed.retryAfter) && Number(parsed.retryAfter) >= 0) retryAfter = Number(parsed.retryAfter);
        }
        throw new RepositoryRenameError(code, {status: response.status, requestId, retryAfter});
    }
    if (!isRecord(parsed) || typeof parsed.owner !== 'string' || !ownerPattern.test(parsed.owner) ||
        parsed.owner.toLowerCase() !== current.owner.toLowerCase() || typeof parsed.repo !== 'string' ||
        parsed.repo.toLowerCase() !== name.toLowerCase() || !isRepositoryName(parsed.repo) ||
        !Number.isSafeInteger(parsed.repositoryId) || Number(parsed.repositoryId) <= 0)
        throw new RepositoryRenameError('INVALID_RESPONSE');
    return {remote: `https://github.com/${parsed.owner}/${parsed.repo}.git`, owner: parsed.owner, repo: parsed.repo,
        repositoryId: Number(parsed.repositoryId)};
}

/**
 * The granted repository's `remote.origin.url` as Git config holds it, the value the panel connects with, or
 * `undefined` when there is no repository or origin.
 */
export async function readOriginUrl(root: FileSystemDirectoryHandle): Promise<string | undefined> {
    try {await root.getDirectoryHandle('.git');} catch (error) {
        if (['NotFoundError', 'TypeMismatchError'].includes((error as {name?: string}).name ?? '')) return undefined;
        throw error;
    }
    const value = await git.getConfig({fs: createReadOnlyFs(root), dir: '/', gitdir: '/.git', path: 'remote.origin.url'});
    return typeof value === 'string' && value ? value : undefined;
}

/**
 * Rewrites `remote.origin.url` of the granted repository from `from` to `to`, and nothing else in `.git/config`.
 * The current value is checked under the Git mutation lock first; a different origin is left alone
 * (`ORIGIN_CHANGED`). This is the only write to `.git/config` that the panel makes.
 */
export function writeOriginUrl(root: FileSystemDirectoryHandle, {from, to}: {from: string; to: string}) {
    let expected: string, next: string;
    try {
        expected = remoteUrl(from);
        next = remoteUrl(to);
    } catch {
        return Promise.reject(new RepositoryRenameError('INVALID_REMOTE'));
    }
    return withGitMutationLock(async () => {
        const read = createReadOnlyFs(root);
        const options = {dir: '/', gitdir: '/.git'};
        const currentValue = await git.getConfig({fs: read, ...options, path: 'remote.origin.url'});
        let current: string | undefined;
        try {current = typeof currentValue === 'string' ? remoteUrl(currentValue) : undefined;} catch {current = undefined;}
        if (current !== expected) throw new RepositoryRenameError('ORIGIN_CHANGED');
        if (currentValue === next) return;
        let written: Uint8Array | undefined;
        const writeFile = async (path: string, data: string | Uint8Array) => {
            if (pathParts(path).join('/') !== '.git/config') throw fileError('EACCES', path);
            written = typeof data === 'string' ? new TextEncoder().encode(data) : Uint8Array.from(data);
        };
        // Isomorphic Git edits the configuration text; only its single write of `.git/config` is kept.
        const fs = {promises: {...read.promises, writeFile}};
        await git.setConfig({fs, ...options, path: 'remote.origin.url', value: next});
        if (!written) throw new RepositoryRenameError('INVALID_RESPONSE');
        const config = await (await root.getDirectoryHandle('.git')).getFileHandle('config');
        // Nothing else may have changed the configuration since it was read.
        await read.checkReads();
        const writable = await config.createWritable();
        try {
            await writable.write(written as Uint8Array<ArrayBuffer>);
            await writable.close();
        } catch (error) {
            await writable.abort().catch(() => {});
            throw error;
        }
    });
}
