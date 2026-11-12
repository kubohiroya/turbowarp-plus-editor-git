import * as git from 'isomorphic-git';
import {GitPanelError} from './filesystem.js';
import {createMutationFs} from './mutation-fs.js';
import {pushWithoutForce, remoteError} from './remote-operations.js';
import type {GetRemoteSession} from './remote-operations.js';
import {createGitSmartHttp, remoteUrl} from './smart-http.js';

const emptyOid = '0'.repeat(40);

export interface PublicationRepository {
    remote: string;
    defaultBranch: string | null;
    branches: readonly {name: string; oid: string}[];
}

/** Read the origin and its currently advertised base refs through the configured Git transport. */
export async function inspectPublicationRepository({root, getSession, guard = () => {}, signal, fetch}: {
    root: FileSystemDirectoryHandle;
    getSession: GetRemoteSession;
    guard?: () => void;
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
}): Promise<PublicationRepository> {
    guard();
    signal?.throwIfAborted();
    const {fs} = createMutationFs(root, false);
    const remote = await git.getConfig({fs, dir: '/', gitdir: '/.git', path: 'remote.origin.url'});
    if (!remote) throw new GitPanelError('session');
    const target = remoteUrl(remote);
    const session = await getSession(remote, true);
    if (!session) throw new GitPanelError('session');
    guard();
    const transport = createGitSmartHttp({remote: target, connection: session.connection,
        getSession: () => getSession(remote, true), signal, fetch});
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
export async function pushPublicationCommit({root, remote, oid, ref, getSession, guard = () => {}, signal, fetch}: {
    root: FileSystemDirectoryHandle;
    remote: string;
    oid: string;
    ref: string;
    getSession: GetRemoteSession;
    guard?: () => void;
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
}) {
    const target = remoteUrl(remote);
    if (!/^[0-9a-f]{40}$/u.test(oid) ||
        !/^refs\/heads\/tw-plus\/pr-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(ref))
        throw new GitPanelError('invalid');
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
