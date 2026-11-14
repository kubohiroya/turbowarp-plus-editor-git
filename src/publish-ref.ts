import * as git from 'isomorphic-git';
import {errorCode, GitPanelError} from './filesystem.js';
import {createMutationFs} from './mutation-fs.js';
import {pushWithoutForce, remoteError} from './remote-operations.js';
import type {GetRemoteSession} from './remote-operations.js';
import type {Commit} from './repository.js';
import {createGitSmartHttp, remoteUrl} from './smart-http.js';

const emptyOid = '0'.repeat(40);

export interface PublicationRepository {
    remote: string;
    defaultBranch: string | null;
    branches: readonly {name: string; oid: string}[];
}

export interface PublicationBase {name: string; oid: string}

/** Read the local branch's first-parent commits outside the chosen remote base. */
export async function publicationCommits(root: FileSystemDirectoryHandle, head: string, base: PublicationBase,
    getSession: GetRemoteSession, guard: () => void): Promise<Commit[]> {
    const execute = async () => {
        const transaction = createMutationFs(root, false);
        const options = {fs: transaction.fs, dir: '/', gitdir: '/.git', cache: {}};
        try {
            await git.readCommit({...options, oid: base.oid});
        } catch (error) {
            if (errorCode(error) !== 'NotFoundError') throw error;
            const remote = await git.getConfig({...options, path: 'remote.origin.url'});
            if (!remote) throw new GitPanelError('session');
            const session = await getSession(remote, false);
            if (!session) throw new GitPanelError('session');
            const transport = createGitSmartHttp({remote, connection: session.connection, getSession: () => getSession(remote, false)});
            const ref = 'refs/heads/' + base.name;
            const fetched = await git.fetch({...options, ...transport, remote: 'origin', ref, remoteRef: ref, tags: false});
            if (fetched.fetchHead !== base.oid) throw new GitPanelError('changed');
            await transaction.commit(guard, true);
        }
        if (head === base.oid) return [];
        const commits: Commit[] = [];
        for (let oid = head; oid !== base.oid;) {
            guard();
            if (await git.isDescendent({...options, oid: base.oid, ancestor: oid})) break;
            const {commit} = await git.readCommit({...options, oid});
            if (commit.parent.length === 1) commits.push({oid, message: commit.message.split('\n')[0],
                author: commit.author.name, timestamp: commit.author.timestamp});
            if (!commit.parent.length) break;
            oid = commit.parent[0];
        }
        return commits;
    };
    return globalThis.navigator?.locks ? navigator.locks.request('tw-plus-git-mutation', execute) : execute();
}

/** Replay the selected commits on the approved base. The original index, HEAD and branch refs stay untouched. */
export async function preparePublicationCommit(root: FileSystemDirectoryHandle, base: string, selection: readonly string[],
    guard: () => void): Promise<string> {
    if (!selection.length || new Set(selection).size !== selection.length) throw new GitPanelError('invalid');
    const execute = async () => {
        guard();
        const transaction = createMutationFs(root, false);
        const {fs} = transaction;
        const options = {fs, gitdir: '/.git', cache: {}};
        let tip = base;
        for (const oid of selection) {
            guard();
            const {commit} = await git.readCommit({...options, oid});
            if (commit.parent.length !== 1) throw new GitPanelError('invalid');
            if (commit.parent[0] === tip) {
                tip = oid;
                continue;
            }
            await fs.promises.writeFile('/.git/HEAD', tip + '\n');
            try {
                tip = await git.cherryPick({...options, oid, noUpdateBranch: true, committer: commit.committer});
            } catch (error) {
                if (errorCode(error) === 'MergeConflictError') throw new GitPanelError('publicationConflict');
                throw error;
            }
        }
        const [before, after] = await Promise.all([base, tip].map(oid => git.readCommit({...options, oid})));
        if (before.commit.tree === after.commit.tree) throw new GitPanelError('publicationConflict');
        await transaction.commit(guard, true);
        return tip;
    };
    return globalThis.navigator?.locks ? navigator.locks.request('tw-plus-git-mutation', execute) : execute();
}

/** Read the origin and its currently advertised base refs through the configured Git transport. */
export async function inspectPublicationRepository({root, getSession, guard = () => {}, signal, fetch, write = true}: {
    root: FileSystemDirectoryHandle;
    getSession: GetRemoteSession;
    guard?: () => void;
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
    write?: boolean;
}): Promise<PublicationRepository> {
    guard();
    signal?.throwIfAborted();
    const {fs} = createMutationFs(root, false);
    const remote = await git.getConfig({fs, dir: '/', gitdir: '/.git', path: 'remote.origin.url'});
    if (!remote) throw new GitPanelError('session');
    const target = remoteUrl(remote);
    const session = await getSession(remote, write);
    if (!session) throw new GitPanelError('session');
    guard();
    const transport = createGitSmartHttp({remote: target, connection: session.connection,
        getSession: () => getSession(remote, write), signal, fetch});
    try {
        const refs = await git.listServerRefs({...transport, protocolVersion: 1, symrefs: true});
        const prefix = 'refs/heads/';
        const branches = refs.filter(ref => ref.ref.startsWith(prefix) && /^[0-9a-f]{40}$/u.test(ref.oid))
            .map(ref => ({name: ref.ref.slice(prefix.length), oid: ref.oid}));
        const defaultRef = refs.find(ref => ref.ref === 'HEAD')?.target;
        const defaultBranch = defaultRef?.startsWith(prefix) ? defaultRef.slice(prefix.length) : null;
        guard();
        return {remote, defaultBranch, branches};
    } catch (error) {
        signal?.throwIfAborted();
        throw remoteError(error);
    }
}

/** Publish an exact local commit under a new job-owned ref. Local HEAD and the worktree stay available for edits. */
type PushNewRef = {
    root: FileSystemDirectoryHandle;
    remote: string;
    oid: string;
    ref: string;
    getSession: GetRemoteSession;
    guard?: () => void;
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
};

export async function pushPublicationCommit(options: PushNewRef) {
    if (!/^refs\/heads\/tw-plus\/pr-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(options.ref))
        throw new GitPanelError('invalid');
    return pushNewRef(options);
}

export const validReleaseTag = (tag: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(tag) &&
    !tag.includes('..') && !tag.endsWith('.') && !tag.endsWith('.lock');

export function pushReleaseTag({tag, ...options}: Omit<PushNewRef, 'ref'> & {tag: string}) {
    if (!validReleaseTag(tag)) throw new GitPanelError('invalid');
    return pushNewRef({...options, ref: 'refs/tags/' + tag});
}

async function pushNewRef({root, remote, oid, ref, getSession, guard = () => {}, signal, fetch}: PushNewRef) {
    const target = remoteUrl(remote);
    if (!/^[0-9a-f]{40}$/u.test(oid)) throw new GitPanelError('invalid');
    guard();
    signal?.throwIfAborted();

    // Isomorphic Git records the successful remote-tracking ref in this temporary overlay.
    const {fs} = createMutationFs(root, false);
    const options = {fs, dir: '/', gitdir: '/.git', cache: {}};
    const configured = await git.getConfig({...options, path: 'remote.origin.url'});
    if (!configured || remoteUrl(configured) !== target) throw new GitPanelError('session');
    await git.readCommit({...options, oid});
    const session = await getSession(configured, true);
    if (!session) throw new GitPanelError('session');
    const transport = createGitSmartHttp({remote: target, connection: session.connection,
        getSession: () => getSession(configured, true), signal, fetch});
    try {
        const refs = await git.listServerRefs({...transport, forPush: true, protocolVersion: 1, symrefs: false});
        const current = refs.find(entry => entry.ref === ref);
        if (current?.oid === oid) return;
        if (current) throw new GitPanelError('diverged');
    } catch (error) {
        throw remoteError(error);
    }
    const result = await pushWithoutForce({...options, ...transport, remote: 'origin', ref: oid, remoteRef: ref, signal,
        onPrePush({remoteRef}) {
            guard();
            if (remoteRef.ref !== ref || remoteRef.oid !== emptyOid) throw new GitPanelError('diverged');
            return true;
        }
    });
    if (!result.refs[ref]?.ok) throw new GitPanelError('pushUnknown');
}
