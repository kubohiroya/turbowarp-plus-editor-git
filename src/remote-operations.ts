import * as git from 'isomorphic-git';
import {GitPanelError} from './filesystem.js';
import {createMutationFs} from './mutation-fs.js';
import {createGitSmartHttp, GitSmartHttpError} from './smart-http.js';
import type {GitSmartHttpOptions} from './smart-http.js';

export type RemoteOperation = 'fetch' | 'pull' | 'push';
export type RemoteSession = NonNullable<Awaited<ReturnType<GitSmartHttpOptions['getSession']>>>;
export type GetRemoteSession = (remote: string, write: boolean) => Promise<RemoteSession | null>;

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
        const refspecs = await git.getConfigAll({...options, path: 'remote.origin.fetch'});
        if (refspecs.some(spec => !/^\+?refs\/heads\/[^:\s]+:refs\/remotes\/origin\/[^:\s]+$/u.test(spec)))
            throw new GitPanelError('unsupported');
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
