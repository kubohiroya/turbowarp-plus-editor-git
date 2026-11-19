import * as git from 'isomorphic-git';
import type {GitProgressEvent} from 'isomorphic-git';
import {createReadOnlyFs, GitPanelError} from './filesystem.js';
import {lockInitialRepository, writeSnapshotToEmptyDirectory} from './initial-commit-directory.js';
import {createInitialCommitFs} from './initial-commit-fs.js';
import type {InitialCommitEntry} from './initial-commit-fs.js';
import {remoteError} from './remote-operations.js';
import type {GetRemoteSession} from './remote-operations.js';
import {createGitSmartHttp, remoteUrl} from './smart-http.js';

/** The files at the root of a branch that make it a TurboWarp Plus Editor project. */
export const PROJECT_ROOT_FILES = ['project.source.json', 'sb3-source.json'] as const;

/** Read the saved origin without connecting or authenticating. Missing repositories have no remote. */
export async function readProjectRemote(root: FileSystemDirectoryHandle): Promise<string | undefined> {
    try {await root.getDirectoryHandle('.git');} catch (error) {
        if (['NotFoundError', 'TypeMismatchError'].includes((error as {name?: string}).name ?? '')) return undefined;
        throw error;
    }
    const remote = await git.getConfig({fs: createReadOnlyFs(root), dir: '/', path: 'remote.origin.url'});
    if (!remote) return undefined;
    // Catalogs display the URL, never credentials that a Git client might have stored in it.
    try {return remoteUrl(remote);} catch {return undefined;}
}

/** A repository cloned in memory, ready for `writeClonedProject`. */
export interface ClonedProject {
    /** The normalised remote, `https://github.com/<owner>/<repo>.git`, kept as `remote.origin.url`. */
    readonly remote: string;
    /** The remote's default branch, checked out and tracking `origin/<branch>`. */
    readonly branch: string;
    /** The commit at the tip of `branch`. */
    readonly head: string;
    /** Every directory and file of the repository, `.git` included, as absolute paths in the in-memory tree. */
    readonly entries: readonly InitialCommitEntry[];
}

export type CloneFailureReason =
    /** The URL is not `https://github.com/<owner>/<repo>[.git]`. */
    | 'invalid-remote'
    /** The default branch has no project at its root, or the repository is empty. Nothing was checked out. */
    | 'not-project'
    /** The branch has a symbolic link, an executable file, a submodule or a path the browser cannot write. */
    | 'unsupported'
    /** No session for the remote, or the session expired. */
    | 'auth'
    /** The connection cannot read the repository. */
    | 'forbidden'
    | 'network'
    | 'failed';

export type CloneRemoteProjectResult =
    | {ok: true; snapshot: ClonedProject}
    | {ok: false; reason: CloneFailureReason; path?: string};

export interface CloneRemoteProjectOptions {
    /** `https://github.com/<owner>/<repo>` or the same with `.git`. */
    remote: string;
    /** Called with the normalised `.git` remote and `write: false`, as `GitConnectionSettings.getSession`. */
    getSession: GetRemoteSession;
    signal?: AbortSignal;
    onProgress?(event: GitProgressEvent): void;
    fetch?: typeof fetch;
}

type Options = {fs: ReturnType<typeof createInitialCommitFs>['fs']; dir: string; gitdir: string; cache: object};

// The first unsupported entry of a tree, as a path, or null when every entry is a regular file or a directory whose
// path the File System Access API can hold on a case-insensitive filesystem.
async function unsupportedEntry(options: Options, oid: string, signal?: AbortSignal) {
    const seen = new Set<string>();
    const visit = async (tree: string, prefix: string): Promise<string | null> => {
        signal?.throwIfAborted();
        for (const entry of (await git.readTree({...options, oid: tree})).tree) {
            const path = prefix + entry.path;
            const key = path.normalize('NFC').toLowerCase();
            if (seen.has(key) || /[. ]$/u.test(entry.path) || entry.path.toLowerCase() === '.git' ||
                /[\\:*?"<>|\u0000-\u001f]/u.test(entry.path)) return path;
            seen.add(key);
            if (entry.type === 'tree' && entry.mode === '040000') {
                const found = await visit(entry.oid, path + '/');
                if (found) return found;
            } else if (entry.type !== 'blob' || entry.mode !== '100644') return path;
        }
        return null;
    };
    return visit(oid, '');
}

function failureOf(error: unknown): CloneFailureReason {
    const code = remoteError(error).code;
    return code === 'session' ? 'auth' : code === 'forbidden' ? 'forbidden' : code === 'network' ? 'network' : 'failed';
}

/**
 * Clones the default branch of a GitHub repository in memory over the connection's Git Smart HTTP: `init`, `origin`
 * with `+refs/heads/*:refs/remotes/origin/*`, the full history of the branch the remote's HEAD names (no tags), and
 * `branch.<name>.remote`/`merge`. Only when the root of that branch has `project.source.json` and `sb3-source.json`
 * is the work tree checked out. Nothing is written outside memory; `writeClonedProject` writes the result.
 *
 * Aborting `signal` rejects with its reason.
 */
export async function cloneRemoteProject({remote, getSession, signal, onProgress, fetch}: CloneRemoteProjectOptions):
Promise<CloneRemoteProjectResult> {
    let url: string;
    try {
        url = remoteUrl(remote);
    } catch {
        return {ok: false, reason: 'invalid-remote'};
    }
    signal?.throwIfAborted();
    const session = await getSession(url, false);
    signal?.throwIfAborted();
    if (!session) return {ok: false, reason: 'auth'};
    let transport: ReturnType<typeof createGitSmartHttp>;
    try {
        transport = createGitSmartHttp({remote: url, connection: session.connection, getSession: () => getSession(url, false),
            signal, fetch});
    } catch {
        return {ok: false, reason: 'auth'};
    }
    const memory = createInitialCommitFs();
    const options: Options = {fs: memory.fs, dir: '/', gitdir: '/.git', cache: {}};
    const progress = onProgress && ((event: GitProgressEvent) => {onProgress(event);});
    try {
        // Without a checkout, clone still creates the local branch, its tracking config and HEAD.
        await git.clone({...options, http: transport.http, url: transport.url, corsProxy: undefined, remote: 'origin',
            singleBranch: true, noTags: true, noCheckout: true, onProgress: progress});
    } catch (error) {
        signal?.throwIfAborted();
        return {ok: false, reason: failureOf(error)};
    }
    signal?.throwIfAborted();
    let head: string;
    let branch: string | void;
    try {
        head = await git.resolveRef({...options, ref: 'HEAD'});
        branch = await git.currentBranch({...options, fullname: false});
    } catch {
        // An empty repository has no branch to check out.
        return {ok: false, reason: 'not-project'};
    }
    if (!branch) return {ok: false, reason: 'not-project'};
    const {commit} = await git.readCommit({...options, oid: head});
    const root = (await git.readTree({...options, oid: commit.tree})).tree;
    if (!PROJECT_ROOT_FILES.every(name => root.some(entry => entry.path === name && entry.type === 'blob')))
        return {ok: false, reason: 'not-project'};
    const unsupported = await unsupportedEntry(options, commit.tree, signal);
    if (unsupported !== null) return {ok: false, reason: 'unsupported', path: unsupported};
    signal?.throwIfAborted();
    await git.checkout({...options, ref: branch, force: true, onProgress: progress});
    signal?.throwIfAborted();
    return {ok: true, snapshot: {remote: url, branch, head, entries: memory.entries()}};
}

/**
 * Writes a cloned project into an empty folder (refs last) under the Git mutation lock, then checks that the folder's
 * HEAD is the cloned commit. Throws `GitPanelError('notEmpty')` without writing when the folder has any entry.
 */
export function writeClonedProject(destination: FileSystemDirectoryHandle, snapshot: ClonedProject,
    {signal}: {signal?: AbortSignal} = {}): Promise<{branch: string; head: string}> {
    return lockInitialRepository(async () => {
        await writeSnapshotToEmptyDirectory(destination, [...snapshot.entries], signal);
        const options = {fs: createReadOnlyFs(destination), dir: '/', gitdir: '/.git'};
        const [branch, head] = await Promise.all([
            git.currentBranch(options), git.resolveRef({...options, ref: 'HEAD'})
        ]).catch(() => {throw new GitPanelError('changed');});
        if (branch !== snapshot.branch || head !== snapshot.head) throw new GitPanelError('changed');
        return {branch, head};
    }, signal);
}
