// SPDX-License-Identifier: MPL-2.0
import type {createGitConnectionSettings} from '@kubohiroya/turbowarp-plus-editor-auth';
import type {PullRequestPublication} from './index.js';
import type {GitAuthor} from './local-operations.js';
import {inspectPublicationRepository, pushPublicationCommit} from './publish-ref.js';
import {bindDesktopPublicationPushSession, createProjectPublication, type PublicationBridge, type ProjectPublicationPort} from './project-publication.js';
import {createCloudflarePublicationBridge} from './cloudflare-publication.js';
import type {ProjectCommitJob, ProjectCommitPort} from './project-commit-dialog.js';
import type {CommitAttribution, GitCollaborationPort} from './collaboration.js';

type Selection = {branch: string; files: {path: string}[]};
export interface SaveCommitQueue {
    capture(): Promise<Selection>;
    enqueue(input: {selection: Selection; message: string; author?: GitAuthor; explicitAuthor?: boolean;
        collaboration?: CommitAttribution['collaboration']}): Promise<ProjectCommitJob>;
    list(): Promise<ProjectCommitJob[]>;
    run(id: string): Promise<ProjectCommitJob>;
}
type CommitJournal = unknown;
type PublicationGitAccess = {root: FileSystemDirectoryHandle;
    getSession: ReturnType<typeof createGitConnectionSettings>['getSession']; guard(): void};
export interface SaveCommitWorkflowOptions {
    collaboration?: GitCollaborationPort;
    view: Window;
    folder: {readonly directory: FileSystemDirectoryHandle | null; save?(): Promise<unknown>};
    getRepository(): {root: FileSystemDirectoryHandle; current(): boolean} | null | undefined;
    isCurrent(): boolean;
    connectionSettings?: ReturnType<typeof createGitConnectionSettings>;
    publicationBridge?: PublicationBridge | null;
    cloudflare?: {bffOrigin: string; proxyOrigin: string} | null;
    createCommitQueue?(options: {root: FileSystemDirectoryHandle; journal: unknown; projectFolder: string;
        guard(): void; author?(): Promise<GitAuthor | undefined>}): SaveCommitQueue;
    createCommitJournal?(factory: IDBFactory): unknown;
    saveWithLock?<T>(operation: () => Promise<T>): Promise<T>;
    flushEdits(): Promise<unknown>;
    readAuthor(): Promise<GitAuthor | undefined>;
    refresh(): void;
}

/** Owns save/commit queues and publication sessions for one mounted project folder. */
export function createSaveCommitWorkflows(options: SaveCommitWorkflowOptions): () => {
    commit?: ProjectCommitPort; publication?: ProjectPublicationPort
} {
    const {view, folder, connectionSettings, cloudflare, saveWithLock, flushEdits: flushPendingSurfaceEdits, readAuthor} = options;
    let journal: CommitJournal;
    let publication: {directory: FileSystemDirectoryHandle; root: FileSystemDirectoryHandle; current(): boolean;
        mode: 'desktop' | 'cloudflare'; port: ProjectPublicationPort} | undefined;
    return () => {
        const common = {};
        const directory = folder.directory;
        const repository = options.getRepository();
        if (!directory || !repository || !folder.save || !saveWithLock ||
            typeof options.createCommitQueue !== 'function' ||
            typeof options.createCommitJournal !== 'function' || !view.indexedDB) return common;
        const guard = () => {
            if (!repository.current() || folder.directory !== directory || !options.isCurrent()) {
                throw Object.assign(new Error('The project or repository changed'), {code: 'changed'});
            }
        };
        const publicationBridge = options.publicationBridge;
        const desktopPublication = typeof publicationBridge?.repository === 'function';
        const mode = connectionSettings?.getView().mode ?? (desktopPublication ? 'desktop' : 'cloudflare');
        const canPublish = connectionSettings && (mode === 'desktop' ? desktopPublication : cloudflare);
        if (canPublish && (!publication || publication.directory !== directory || publication.root !== repository.root ||
            publication.mode !== mode || !publication.current())) {
            const access: PublicationGitAccess = {root: repository.root, guard, async getSession(remote, write) {
                guard();
                const session = await connectionSettings!.getSession(remote, write);
                guard();
                return session?.connection.mode === mode ? session : null;
            }};
            const cloudflareBridge = mode === 'cloudflare' ? createCloudflarePublicationBridge({
                ...cloudflare!, view, getSession: access.getSession
            }) : undefined;
            publication = {directory, root: repository.root, mode, current: repository.current, port: createProjectPublication({
                bridge: (cloudflareBridge ?? publicationBridge)!,
                inspect: () => inspectPublicationRepository(access),
                async push(options, job) {
                    const getSession = cloudflareBridge ? cloudflareBridge.bindPushSession(job) :
                        await bindDesktopPublicationPushSession(access.getSession, options.remote, job);
                    try {
                        await pushPublicationCommit({...access, ...options, getSession});
                    } catch (error) {
                        if (!await getSession(options.remote, true).catch(() => null)) throw new Error('SESSION_REQUIRED');
                        throw error;
                    }
                },
                guard
            })};
        }
        let queue: Promise<SaveCommitQueue>;
        const getQueue = () => queue ??= (async () => {
            guard();
            const relative = repository.root === directory ? [] : await repository.root.resolve(directory);
            guard();
            if (!relative) throw Object.assign(new Error('Select the repository containing the open project folder'), {code: 'outsideRepository'});
            journal ??= options.createCommitJournal!(view.indexedDB);
            return options.createCommitQueue!({root: repository.root, journal, projectFolder: relative.join('/'),
                guard, author: readAuthor});
        })();
        return {...common, publication: canPublish ? publication?.port : undefined, commit: {
            async prepare(current, preparedAttribution) {
                const queue = await getQueue();
                const selection = await saveWithLock(async () => {
                    if (!current()) return null;
                    guard();
                    await flushPendingSurfaceEdits();
                    if (!current()) return null;
                    guard();
                    await folder.save!();
                    return current() ? queue.capture() : null;
                });
                if (!selection) return null;
                return {branch: selection.branch, paths: selection.files.map(file => file.path),
                    enqueue: async message => {
                        const attribution = preparedAttribution ?? await options.collaboration?.prepareCommit(repository.root, message);
                        guard();
                        if (attribution === null) throw Object.assign(new Error('Cancelled'), {code: 'cancelled'});
                        return queue.enqueue({selection, message: attribution?.message ?? message,
                            ...attribution && {author: attribution.author, explicitAuthor: true, collaboration: attribution.collaboration}});
                    }};
            },
            async jobs() {return (await getQueue()).list();},
            async run(id) {
                const job = await (await getQueue()).run(id);
                if (job.status === 'completed' && job.commitOid && job.collaboration)
                    await options.collaboration?.committed(repository.root, job.commitOid, job.collaboration);
                options.refresh();
                return job;
            }
        }};
    };
}

export function createPullRequestPublication(connectionSettings: ReturnType<typeof createGitConnectionSettings> | undefined,
    bridge: PublicationBridge | undefined,
    bindPushSession?: (job: import('./project-publication.js').PublicationJob) => ReturnType<typeof createGitConnectionSettings>['getSession']): PullRequestPublication | undefined {
    if (!bridge || !connectionSettings) return undefined;
    const {getSession} = connectionSettings;
    return {
        pullRequestChecks: bridge.pullRequestChecks,
        mergeStatus: bridge.mergeStatus,
        mergePullRequest: bridge.mergePullRequest,
        prepare: ({root, guard, commit}) => createProjectPublication({bridge, guard,
            inspect: () => inspectPublicationRepository({root, getSession, guard, write: false}),
            async push(options, job) {
                const session = bindPushSession?.(job) ??
                    await bindDesktopPublicationPushSession(getSession, options.remote, job);
                await pushPublicationCommit({root, ...options, getSession: session, guard});
            }
        }).prepare(commit)
    };
}

/** Whether `directory` is the root of a Git repository, as the Git panel opens one. */
export async function hasGitDirectory(directory: FileSystemDirectoryHandle) {
    try {
        await directory.getDirectoryHandle('.git');
        return true;
    } catch {
        return false;
    }
}
