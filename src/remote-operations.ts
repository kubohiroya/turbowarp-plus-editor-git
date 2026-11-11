import * as git from 'isomorphic-git';
import {GitPanelError} from './filesystem.js';
import {createMutationFs} from './mutation-fs.js';
import {createGitSmartHttp, GitSmartHttpError} from './smart-http.js';
import type {GitSmartHttpOptions} from './smart-http.js';

export type RemoteOperation = 'fetch' | 'pull' | 'push';
export type RemoteSession = NonNullable<Awaited<ReturnType<GitSmartHttpOptions['getSession']>>>;
export type GetRemoteSession = (remote: string, write: boolean, review?: boolean) => Promise<RemoteSession | null>;

type GitOptions = {fs: ReturnType<typeof createMutationFs>['fs']; dir: string; gitdir: string; cache: object};
const sessionCodes = ['SESSION_REQUIRED', 'SESSION_UNAVAILABLE', 'SESSION_EXPIRED', 'REAUTH_REQUIRED', 'INVALID_SESSION'];

// Fetch writes remote-tracking refs through these refspecs; anything else could land a ref outside refs/remotes/origin.
async function checkRefspecs(options: GitOptions) {
    const refspecs = await git.getConfigAll({...options, path: 'remote.origin.fetch'});
    if (refspecs.some(spec => !/^\+?refs\/heads\/[^:\s]+:refs\/remotes\/origin\/[^:\s]+$/u.test(spec)))
        throw new GitPanelError('unsupported');
}

/**
 * Where a fetched pull request head is kept: outside `refs/heads`, `refs/remotes` and `refs/tags`, so Git CLI lists it
 * with `git for-each-ref refs/pull` and `git log --all` but not as a branch or tag, `git fetch --prune` leaves it alone,
 * and `git gc` keeps its objects. Each fetch of the same pull request replaces it.
 */
export const pullRequestRef = (number: number) => `refs/pull/origin/${number}/head`;

export interface PullRequestFetch {
    readonly number: number;
    /** The commit at GitHub's `refs/pull/<number>/head`, kept locally at `ref`. */
    readonly head: string;
    readonly ref: string;
    /** GitHub's default branch, from the advertised `HEAD`, or `null` when it is not advertised. */
    readonly defaultBranch: string | null;
    /** The branches on GitHub, as `refs/remotes/origin/<name>` after this fetch. */
    readonly branches: readonly string[];
}

/**
 * Fetches GitHub's `refs/pull/<number>/head` together with every branch, over the connection's Git Smart HTTP, like
 * `git fetch origin refs/pull/<number>/head`. The branches update `refs/remotes/origin/*` as fetch does, and the head
 * is kept at `pullRequestRef(number)`. The work tree, the index, HEAD and `.git/config` are never written. The writes
 * are staged first and applied together, under the same lock as fetch, pull and push.
 */
export async function runPullRequestFetch(root: FileSystemDirectoryHandle, number: number,
    getSession: GetRemoteSession, guard: () => void, signal?: AbortSignal): Promise<PullRequestFetch> {
    if (!Number.isSafeInteger(number) || number < 1) throw new GitPanelError('pullRequestNotFound');
    const execute = async () => {
        guard();
        const transaction = createMutationFs(root, false);
        const options = {fs: transaction.fs, dir: '/', gitdir: '/.git', cache: {}};
        const remote = await git.getConfig({...options, path: 'remote.origin.url'});
        if (typeof remote !== 'string') throw new GitPanelError('session');
        await checkRefspecs(options);
        const session = await getSession(remote, false);
        if (!session) throw new GitPanelError('session');
        guard();
        const transport = createGitSmartHttp({remote, connection: session.connection,
            getSession: () => getSession(remote, false), signal});
        const source = `refs/pull/${number}/head`;
        let result: Awaited<ReturnType<typeof git.fetch>>;
        try {
            result = await git.fetch({...options, ...transport, remote: 'origin', remoteRef: source, tags: false});
        } catch (error) {
            const {code, data} = error as {code?: string; data?: {what?: string}};
            // isomorphic-git resolves the wanted ref against the advertisement before it sends any request for objects.
            if (code === 'NotFoundError' && data?.what === source) throw new GitPanelError('pullRequestNotFound');
            throw remoteError(error);
        }
        const head = result.fetchHead;
        if (!head || !/^[0-9a-f]{40}$/u.test(head)) throw new GitPanelError('remoteFailed');
        const ref = pullRequestRef(number);
        await git.writeRef({...options, ref, value: head, force: true});
        const branches = (await git.listBranches({...options, remote: 'origin'})).filter(name => name !== 'HEAD').sort();
        const advertised = result.defaultBranch?.startsWith('refs/heads/') ? result.defaultBranch.slice(11) : null;
        await transaction.commit(guard);
        return {number, head, ref, defaultBranch: advertised && branches.includes(advertised) ? advertised : null, branches};
    };
    return globalThis.navigator?.locks ? navigator.locks.request('tw-plus-git-mutation', execute) : execute();
}

/** Maps a failed read from GitHub to what the person can act on: the connection, access, or the network. */
function remoteError(error: unknown) {
    if (error instanceof GitPanelError) return error;
    if (error instanceof GitSmartHttpError) {
        if (sessionCodes.includes(error.code)) return new GitPanelError('session');
        if (error.code === 'FORBIDDEN') return new GitPanelError('forbidden');
        if (['NETWORK_ERROR', 'UPSTREAM_FAILURE', 'UPSTREAM_TIMEOUT', 'RATE_LIMITED'].includes(error.code))
            return new GitPanelError('network');
    }
    return new GitPanelError('remoteFailed');
}

export async function runRemoteOperation(root: FileSystemDirectoryHandle, operation: RemoteOperation,
    getSession: GetRemoteSession, guard: () => void, signal?: AbortSignal) {
    const execute = async () => {
        guard();
        const transaction = createMutationFs(root, operation === 'pull');
        const options = {fs: transaction.fs, dir: '/', gitdir: '/.git', cache: {}};
        const ref = await git.currentBranch(options);
        if (!ref) throw new GitPanelError('unsupported');
        const config = (path: string) => git.getConfig({...options, path});
        const remote = await config('remote.origin.url');
        if (typeof remote !== 'string') throw new GitPanelError('session');
        const trackingRemote = await config('branch.' + ref + '.remote');
        const trackingRef = await config('branch.' + ref + '.merge');
        if ((trackingRemote && trackingRemote !== 'origin') || (trackingRef && !trackingRef.startsWith('refs/heads/')))
            throw new GitPanelError('unsupported');
        await checkRefspecs(options);
        if (operation === 'pull') {
            if ((await git.statusMatrix({...options, refresh: false})).some(([, head, worktree, stage]) =>
                head !== worktree || head !== stage)) throw new GitPanelError('pullUnsafe');
            await git.walk({...options, trees: [git.STAGE()], map: async (_path, [entry]) => {
                if (entry && await entry.type() !== 'tree' && await entry.mode() !== 0o100644)
                    throw new GitPanelError('unsupported');
            }});
        }
        const write = operation === 'push';
        const session = await getSession(remote, write);
        if (!session) throw new GitPanelError('session');
        guard();
        const transport = createGitSmartHttp({remote, connection: session.connection,
            getSession: () => getSession(remote, write), signal});
        let receivedPushResponse = false;
        let pushResponseFailed = false;
        const http = {async request(request: Parameters<typeof transport.http.request>[0]) {
            const response = await transport.http.request(request);
            if (!write || request.method !== 'POST' || !response.body) return response;
            receivedPushResponse = true;
            const body = response.body;
            // isomorphic-git stops at the report-status and drops later read errors, so record them here.
            return {...response, body: (async function* () {
                try {
                    yield* body;
                } catch (error) {
                    pushResponseFailed = true;
                    throw error;
                }
            })()};
        }};
        const args = {...options, ...transport, http, remote: 'origin', ref,
            remoteRef: trackingRef || `refs/heads/${ref}`};
        try {
            if (operation === 'fetch') await git.fetch({...args, tags: false});
            else if (operation === 'pull') await git.fastForward(args);
            else {
                await git.push({...args, force: false, signal});
                if (pushResponseFailed) throw new GitPanelError('pushUnknown');
            }
        } catch (error) {
            if (error instanceof GitSmartHttpError) {
                if (error.code === 'PUSH_OUTCOME_UNKNOWN') throw new GitPanelError('pushUnknown');
                if (['SESSION_REQUIRED', 'SESSION_UNAVAILABLE', 'SESSION_EXPIRED', 'REAUTH_REQUIRED'].includes(error.code))
                    throw new GitPanelError('session');
            }
            const code = (error as {code?: string})?.code;
            if (code === 'FastForwardError') throw new GitPanelError('diverged');
            if (receivedPushResponse && !(error instanceof GitSmartHttpError) && code !== 'GitPushError')
                throw new GitPanelError('pushUnknown');
            if (error instanceof GitPanelError) throw error;
            throw new GitPanelError('remoteFailed');
        }
        try {
            await transaction.commit(guard);
        } catch (error) {
            if (write) throw new GitPanelError('pushRefresh');
            throw error;
        }
    };
    return globalThis.navigator?.locks ? navigator.locks.request('tw-plus-git-mutation', execute) : execute();
}
