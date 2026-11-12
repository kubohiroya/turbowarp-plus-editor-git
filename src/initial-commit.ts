import * as git from 'isomorphic-git';
import type {GitProxySession} from '@kubohiroya/turbowarp-plus-editor-auth';
import {GitPanelError, pathParts} from './filesystem.js';
import {
    getInitialDirectoryPublication, lockInitialRepository, prepareInitialDirectory, validateInitialOperation
} from './initial-commit-directory.js';
import {createInitialCommitFs} from './initial-commit-fs.js';
import type {GitAuthor} from './local-operations.js';
import {createMutationFs} from './mutation-fs.js';
import {pushWithoutForce, remoteError} from './remote-operations.js';
import {createGitSmartHttp, remoteUrl} from './smart-http.js';

const branch = 'main';
const ref = 'refs/heads/' + branch;
const trackingRef = 'refs/remotes/origin/' + branch;
const unborn = '0000000000000000000000000000000000000000';

export interface InitialCommitTarget {
    remote: string;
    repositoryId: number;
}

/** A normal write grant, bound by the host to the repository ID returned by repository creation. */
export interface InitialCommitGrant extends InitialCommitTarget {
    session: GitProxySession & {readonly repositoryId?: number};
}

interface InitialCommitSeed {
    files: readonly {path: string; bytes: Uint8Array}[];
    author: GitAuthor;
    /** Unix time in seconds, retained with the seed so a retry produces the same commit. */
    timestamp: number;
}

interface InitialCommitTransport extends InitialCommitTarget {
    getWriteGrant(target: InitialCommitTarget): Promise<InitialCommitGrant | null>;
    signal?: AbortSignal;
    fetch?: typeof fetch;
}

export interface PublishInitialCommitOptions extends InitialCommitSeed, InitialCommitTransport {
    /** Persist or compare the proposed OID before any network request. */
    prepared(oid: string): Promise<void>;
}

interface InitialRepositoryLocation extends InitialCommitTarget {
    directory: FileSystemDirectoryHandle;
    operationId: string;
    signal?: AbortSignal;
}

export interface PrepareInitialRepositoryOptions extends InitialCommitSeed, InitialRepositoryLocation {}

export interface PushInitialRepositoryOptions extends InitialRepositoryLocation, InitialCommitTransport {
    oid: string;
}

export interface PreparedInitialRepository {
    oid: string;
    branch: typeof branch;
}

function targetOf({remote, repositoryId}: InitialCommitTarget) {
    if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) throw new GitPanelError('invalid');
    return {remote: remoteUrl(remote), repositoryId};
}

function repositoryOptions(fs: Parameters<typeof git.push>[0]['fs']) {
    return {fs, dir: '/', gitdir: '/.git', cache: {}};
}

function validateFilePath(path: string) {
    const parts = pathParts(path);
    if (!parts.length || parts.join('/') !== path || path.includes('\\') ||
        parts.some(part => part.toLowerCase() === '.git')) throw new GitPanelError('invalid');
}

async function buildInitialCommit({files, author, timestamp}: InitialCommitSeed, signal?: AbortSignal, origin?: string) {
    if (!files.length || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new GitPanelError('invalid');
    const identity = {name: author.name.trim(), email: author.email.trim(), timestamp, timezoneOffset: 0};
    if ([identity.name, identity.email].some(value => !value || /[\u0000\r\n<>]/u.test(value)))
        throw new GitPanelError('author');
    signal?.throwIfAborted();
    const {fs, add, entries} = createInitialCommitFs();
    const options = repositoryOptions(fs);
    // Copy all supplied bytes before yielding, so later edits cannot change the published tree.
    const paths = files.map(({path, bytes}) => {
        validateFilePath(path);
        add(path, bytes);
        return path;
    });
    await git.init({...options, defaultBranch: branch});
    if (origin) {
        await git.addRemote({...options, remote: 'origin', url: origin});
        await git.setConfig({...options, path: 'branch.main.remote', value: 'origin'});
        await git.setConfig({...options, path: 'branch.main.merge', value: ref});
        await git.setConfig({...options, path: 'user.name', value: identity.name});
        await git.setConfig({...options, path: 'user.email', value: identity.email});
    }
    // The seed is an explicit list, including any files its ignore rules match.
    await git.add({...options, filepath: paths, force: true});
    const oid = await git.commit({...options, author: identity, committer: identity,
        message: 'Import project from TurboWarp Plus Editor\n'});
    return {options, oid, entries};
}

/**
 * Commit the immutable seed in memory and send it through the repository's write grant. A retry
 * reads the advertised refs before it sends anything and accepts only the exact recorded commit.
 */
export async function publishInitialCommit(input: PublishInitialCommitOptions): Promise<{oid: string}> {
    const target = targetOf(input);
    const {options, oid} = await buildInitialCommit(input, input.signal);
    await input.prepared(oid);
    await sendInitialCommit(options, oid, target, input, false);
    return {oid};
}

async function verifyLocalInitialCommit(options: ReturnType<typeof repositoryOptions>, oid: string, remote: string) {
    const [currentBranch, currentOid, origin] = await Promise.all([
        git.currentBranch(options),
        git.resolveRef({...options, ref: 'HEAD'}),
        git.getConfig({...options, path: 'remote.origin.url'})
    ]).catch(() => {throw new GitPanelError('changed');});
    if (currentBranch !== branch || currentOid !== oid || origin !== remote)
        throw new GitPanelError('changed');
}

/** Materializes the initial commit in the selected root and resumes only its own incomplete initialization. */
export async function prepareInitialRepository(input: PrepareInitialRepositoryOptions): Promise<PreparedInitialRepository> {
    const {directory, operationId, signal} = input;
    const target = targetOf(input);
    validateInitialOperation(operationId);
    const {oid, entries} = await buildInitialCommit(input, signal, target.remote);
    return lockInitialRepository(async () => {
        await prepareInitialDirectory(directory, entries(), {...target, operationId, oid}, signal);
        const options = repositoryOptions(createMutationFs(directory, false).fs);
        await verifyLocalInitialCommit(options, oid, target.remote);
        return {oid, branch};
    }, signal);
}

/** Publishes the recorded local commit through its repository-bound write grant. */
export async function pushInitialRepository(input: PushInitialRepositoryOptions): Promise<PreparedInitialRepository> {
    const {directory, operationId, oid, signal} = input;
    const target = targetOf(input);
    validateInitialOperation(operationId, oid);
    return lockInitialRepository(async () => {
        signal?.throwIfAborted();
        const publication = await getInitialDirectoryPublication(directory, {...target, operationId, oid});
        const transaction = createMutationFs(directory, false);
        const options = repositoryOptions(transaction.fs);
        await verifyLocalInitialCommit(options, oid, target.remote);
        const remoteTracking = await git.listBranches({...options, remote: 'origin'});
        if (remoteTracking.includes(branch) && await git.resolveRef({...options, ref: trackingRef}) !== oid)
            throw new GitPanelError('changed');
        await sendInitialCommit(options, oid, target, input, publication.published);
        try {
            // Persist the known upstream outcome even if refreshing the local tracking ref fails.
            await publication.markPublished();
            await git.writeRef({...options, ref: trackingRef, value: oid, force: true});
            await transaction.commit(() => signal?.throwIfAborted());
        } catch {
            throw new GitPanelError('pushRefresh');
        }
        return {oid, branch};
    }, signal);
}

async function sendInitialCommit(options: ReturnType<typeof repositoryOptions>, oid: string, target: InitialCommitTarget,
    {getWriteGrant, signal, fetch}: InitialCommitTransport, published: boolean) {
    signal?.throwIfAborted();

    const getSession = async () => {
        const grant = await getWriteGrant({...target});
        if (!grant || grant.repositoryId !== target.repositoryId || remoteUrl(grant.remote) !== target.remote) return null;
        if (grant.session.repositoryId !== undefined && grant.session.repositoryId !== target.repositoryId) return null;
        return grant.session;
    };
    const session = await getSession();
    if (!session) throw new GitPanelError('session');
    const transport = createGitSmartHttp({remote: target.remote, connection: session.connection, getSession, signal, fetch});
    let refs;
    try {
        refs = await git.listServerRefs({http: transport.http, url: transport.url, forPush: true, protocolVersion: 1, symrefs: false});
    } catch (error) {
        throw remoteError(error);
    }
    if (refs.some(entry => entry.ref === ref && entry.oid === oid)) return;
    if (refs.length || published) throw new GitPanelError('diverged');

    const pushed = await pushWithoutForce({...options, ...transport, ref, remoteRef: ref, signal,
        onPrePush({localRef, remoteRef}) {
            if (localRef.ref !== ref || localRef.oid !== oid) throw new GitPanelError('changed');
            // The second advertisement may differ from the first. Only create the empty ref.
            if (remoteRef.ref !== ref || remoteRef.oid !== unborn) throw new GitPanelError('diverged');
            return true;
        }
    });
    if (!pushed.refs[ref]?.ok) throw new GitPanelError('pushUnknown');
}
