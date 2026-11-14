import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createPortal, render, unmountComponentAtNode} from 'react-dom';
import {CloseButton} from './close-button.js';
import {FileDiffView} from './file-diff-view.js';
import {SaveFilesView} from './save-files-view.js';
import {FileIdentity, GitStatusBadge} from './file-presentation.js';
import {findElement, ProjectChangeListView, ProjectElementView, projectChangeLabels, useProjectChanges} from './project-change-list.js';
import {confirmProjectRestore} from './project-restore-dialog.js';
import type {ChangedFile} from './project-change-model.js';
import {openRepository} from './repository.js';
import type {BranchRefs, Repository, Snapshot, FileChange, FileDiff, HistoryCommit, HistoryCursor} from './repository.js';
import {BranchButton, useBranchSnackbar} from './branch-button.js';
import {changeMarks, fileStatuses} from './change-marks.js';
import type {ChangeMark, FileStatus, MergedFileVersions} from './change-marks.js';
import type {BranchButtonState} from './branch-button.js';
import {HistoryGraph} from './history-graph-view.js';
import type {HistoryActionResult} from './history-graph-view.js';
import {labelsFor} from './messages.js';
import {GitWorkflow, PanelIcon, RepositoryIdentity, panelViews} from './panel-navigation.js';
import type {PanelView} from './panel-navigation.js';
import {GitPanelError, pathParts} from './filesystem.js';
import {ConnectionSettings, GitHubSync} from './connection-settings.js';
export {GitConnectionPreferences} from './connection-settings.js';
import type {GitConnectionSettings} from './connection-settings.js';
import type {RemoteOperation} from './remote-operations.js';
import type {GitAuthor, LocalOperation} from './local-operations.js';
import {pullRequestBranch} from './local-operations.js';
import {PullRequestReviewPanel} from './pull-request-panel.js';
import {createGitHubPullRequests, gitHubRepositoryFromOrigin} from './github-pull-requests.js';
import {ReleaseDialog} from './release-menu.js';
import {PullRequestCreation} from './pull-request-creation.js';
import type {PullRequestPublication} from './publication-ui-port.js';
import {openProjectSourceTabs} from './project-source-tabs.js';
import type {ProjectSourceTabsFile} from './project-source-tabs.js';
import {parseProjectSource} from './project-source-patch.js';
import type {ProjectBlockRenderer} from './scratch-block-diff-renderer.js';
import type {ScratchBlockLocationWorkspace} from './block-diff-location.js';
export {createScratchBlocksDiffLocator} from './block-diff-location.js';
export {createEditorBlockLocator} from './editor-block-locator.js';
import {createEditorBlockLocator} from './editor-block-locator.js';
import type {LocatorVM} from './editor-block-locator.js';

export {createScratchBlocksDiffRenderer} from './scratch-block-diff-renderer.js';
export type {ScratchBlockDiffRendererOptions, ScratchBlocksPort} from './scratch-block-diff-renderer.js';

export {openRepository, createReadOnlyFs, GitPanelError, pullRequestRef} from './repository.js';
export {openProjectComparison} from './project-comparison.js';
export {openProjectSourceTabs} from './project-source-tabs.js';
export type {ProjectSourceTabsFile, ProjectSourceTabsOptions} from './project-source-tabs.js';
export type {ProjectComparisonAction, ProjectComparisonOptions, ProjectComparisonSection} from './project-comparison.js';
export type {BranchRefs, HeadFile, PullRequestBase, PullRequestFetch, PullRequestFiles, Repository, Snapshot, FileChange, FileDiff, HistoryCommit, HistoryCursor, HistoryPage, HistoryRef} from './repository.js';
export {BranchButton} from './branch-button.js';
export type {BranchButtonActions, BranchButtonProps, BranchButtonState} from './branch-button.js';
export {HistoryGraph, laneColors} from './history-graph-view.js';
export type {HistoryActionResult, HistoryGraphProps} from './history-graph-view.js';
export {layoutHistory} from './history-graph.js';
export type {GraphCommit, GraphLayout, GraphRow, GraphSegment} from './history-graph.js';
export {changeMarks} from './change-marks.js';
export type {ChangeMark, FileStatus} from './change-marks.js';
export type {ProjectRestorePlan} from './project-version.js';
export type {GitAuthor, LocalOperation} from './local-operations.js';
export {pullRequestBranch} from './local-operations.js';
export {inspectPublicationRepository, pushPublicationCommit} from './publish-ref.js';
export type {PullRequestPublication} from './publication-ui-port.js';

export interface GitHost {
    connectionSettings?: GitConnectionSettings;
    pullRequestPublication?(): PullRequestPublication | undefined;
    renderReviewBlock?: ProjectBlockRenderer;
    openProject(directory: FileSystemDirectoryHandle, confirmReplace: () => boolean): Promise<'opened' | 'cancelled'>;
    projectDirectory?(): FileSystemDirectoryHandle | null;
    unsavedProjectPaths?(): ReadonlySet<string> | null;
    readUnsavedProjectFile?(path: string): Uint8Array | null | undefined;
    subscribeProjectEdits?(listener: () => void): () => void;
    saveProjectFiles?(): Promise<void>;
    restoreProjectVersions?: boolean;
    validateProjectVersion?(files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): void;
    previewProjectVersion?(request: {oid: string; folder: string; files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>}): Promise<void>;
    isProjectDirty(): boolean;
    isProjectRunning?(): boolean;
    subscribe?(listener: (event: 'loaded' | 'changed' | 'folder') => void): () => void;
    /**
     * Opens the panel as a tab of the host's layout, with the same shape as the layout package's DocumentPanelRequest.
     * Returning `false` keeps the modal dialog.
     */
    openPanel?(request: GitPanelRequest): boolean;
    /** Opens the code of one stage or sprite, so a diff can point at its block. Without it, no block is located. */
    openTargetCode?(targetId: string): void | Promise<void>;
    /** The Editor's code workspace as it is now. */
    getWorkspace?(): ScratchBlockLocationWorkspace | null | Promise<ScratchBlockLocationWorkspace | null>;
    /**
     * Offers staging, unstaging and commits. Without it the panel only reads. `author` is used only where the
     * repository's Git config has no user.name or user.email; the panel never writes the config.
     */
    localWrite?: {author?(): GitAuthor | undefined};
}
export interface GitPanelRequest {
    reference: {providerId: string; documentId: string};
    filename: string;
    title?: string;
    transient?: boolean;
    /** Tabs of one area share a split panel of the host's layout. */
    area?: string;
    /** Gathers the tab with the others of the same `id` under a labelled chip; `color` is a palette id such as `'green'`. */
    tabGroup?: {id: string; label: string; color?: string; collapsed?: boolean};
    /** Opens the tab behind the active one. */
    inactive?: boolean;
    mount(element: HTMLElement, close: () => void): {requestClose(): void; dispose(): void};
}
type BranchOperation = Extract<LocalOperation, {kind: 'createBranch' | 'switchBranch'}>;
type ExplorerEntry = {path: string; kind: 'file' | 'directory'};
type ExplorerOperation = 'stage' | 'unstage';
export type ExplorerGitActions = {
    change(kind: ExplorerOperation, entry: ExplorerEntry, isCurrent: () => boolean): Promise<HistoryActionResult>;
    refresh(): Promise<void>;
};
/** The panel's side of its entries: set by the panel as it renders, used by the branch buttons and `mountGitPanel`'s result. */
interface Controller {
    open(locale: string, inactive?: boolean): void;
    openCommit(locale: string, repository: Repository, oid: string): void;
    refresh(automatic?: boolean, whileHidden?: boolean): Promise<void>;
    /** Asks for a repository, then opens the panel on it. */
    choose(locale: string): Promise<void>;
    openRelease(locale: string, github: string | null, exportProject?: () => void): void;
    selectRepository(root: FileSystemDirectoryHandle, project: FileSystemDirectoryHandle): Promise<boolean>;
    openVersion?: (oid: string) => Promise<HistoryActionResult>;
    restoreVersion?: (oid: string) => Promise<HistoryActionResult>;
    changeBranch(operation: BranchOperation): Promise<HistoryActionResult>;
    changeExplorerEntry(repository: Repository, directory: FileSystemDirectoryHandle, kind: ExplorerOperation,
        entry: ExplorerEntry, isCurrent: () => boolean): Promise<HistoryActionResult>;
    /** Reloads the project folder selected in the panel, as Reload Project does. */
    reload(): void;
    /** What the branch buttons show. */
    branch: BranchButtonState;
    /** The chosen repository and its last snapshot, published with `branch`. */
    repository: Repository | null;
    snapshot: Snapshot | null;
    publish(state: BranchButtonState, repository: Repository | null, snapshot: Snapshot | null): void;
    /** Follows `branch`. While anything follows it, the closed panel keeps watching the branches. */
    follow(listener: () => void): () => void;
    /** How many follow `branch`. */
    followers(): number;
    /** Set by the panel while it is mounted, to hear when `followers()` changes. */
    onFollowers(count: number): void;
}
function createController(): Controller {
    const listeners = new Set<() => void>();
    const controller: Controller = {
        open() {}, openCommit() {}, openRelease() {}, async refresh() {}, async choose() {}, async selectRepository() {return false;},
        async changeBranch() {return {done: false};},
        async changeExplorerEntry() {return {done: false};}, reload() {},
        branch: {repository: false, branch: undefined, head: null, branches: [], remoteBranches: [], writable: false, busy: false,
            project: false},
        repository: null,
        snapshot: null,
        publish(state, repository, snapshot) {
            controller.branch = state;
            controller.repository = repository;
            controller.snapshot = snapshot;
            for (const listener of [...listeners]) listener();
        },
        follow(listener) {
            listeners.add(listener);
            controller.onFollowers(listeners.size);
            return () => {
                listeners.delete(listener);
                controller.onFollowers(listeners.size);
            };
        },
        followers: () => listeners.size,
        onFollowers() {}
    };
    return controller;
}
interface ChangeSelection {
    changes: FileChange[];
    selected: FileChange | null;
    diff: FileDiff | null;
}
interface State extends ChangeSelection {
    repository: Repository | null;
    snapshot: Snapshot | null;
    project: string | null;
    defaultProject: string | null;
    commit: (ChangeSelection & {oid: string}) | null;
    error: string | null;
    notice?: string;
    busy: boolean;
}
const initial: State = {repository: null, snapshot: null, project: null, defaultProject: null,
    changes: [], selected: null, diff: null, commit: null, error: null, busy: false};
const controllers = new WeakMap<object, Controller>();
// Branch buttons rendered before the panel is mounted, or after it is disposed, wait for the VM's controller here.
const registrations = new Set<() => void>();
type PickerWindow = Window & {showDirectoryPicker?: (options: {id: string; mode: 'readwrite'}) => Promise<FileSystemDirectoryHandle>};
type ObserverWindow = Window & {FileSystemObserver?: new (callback: () => void) => {
    observe(handle: FileSystemDirectoryHandle, options: {recursive: boolean}): Promise<void>;
    disconnect(): void;
}};
const watchInterval = 2000;
const noChanges: FileChange[] = [];
let nextPanelId = 0;

/**
 * Calls `check` every `watchInterval`, when the window regains focus and shortly after a File System Observer reports
 * a change under `root`, one call at a time and never while the page is hidden. Returns the function that stops it.
 */
function watchRepository(document: Document, root: FileSystemDirectoryHandle, check: (stopped: () => boolean) => Promise<void>) {
    const view = document.defaultView as ObserverWindow;
    let stopped = false;
    let checking = false;
    const run = async () => {
        if (stopped || checking || document.visibilityState === 'hidden') return;
        checking = true;
        try {
            await check(() => stopped);
        } catch {
            // Entries can disappear while another tool writes. The next check reads them again.
        } finally {
            checking = false;
        }
    };
    let soon: number | undefined;
    const schedule = () => {view.clearTimeout(soon); soon = view.setTimeout(() => void run(), 300);};
    const interval = view.setInterval(() => void run(), watchInterval);
    const onFocus = () => void run();
    view.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    let observer: InstanceType<NonNullable<ObserverWindow['FileSystemObserver']>> | null = null;
    try {
        if (view.FileSystemObserver) {
            observer = new view.FileSystemObserver(schedule);
            observer.observe(root, {recursive: true}).catch(() => {});
        }
    } catch {
        observer = null;
    }
    void run();
    return () => {
        stopped = true;
        view.clearInterval(interval);
        view.clearTimeout(soon);
        view.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onFocus);
        observer?.disconnect();
    };
}
const sameRefs = (a: BranchRefs | null, b: BranchRefs) => !!a && a.branch === b.branch && a.head === b.head &&
    a.branches.join('\n') === b.branches.join('\n') && a.remoteBranches.join('\n') === b.remoteBranches.join('\n');

function GitPanel({vm, document, host, controller}: {vm: object; document: Document; host: GitHost; controller: Controller}) {
    const [visible, setVisible] = useState(false);
    // A layout tab that holds the panel. The panel component stays mounted, so the repository survives closing the tab.
    const [slot, setSlot] = useState<{element: HTMLElement; close(): void} | null>(null);
    const shown = visible || slot !== null;
    // Only a tab leaves the Editor visible, so only a tab offers to point at blocks in it.
    const locator = useMemo(() => slot && host.openTargetCode && host.getWorkspace ? createEditorBlockLocator({
        vm: vm as LocatorVM, openTargetCode: host.openTargetCode, getWorkspace: host.getWorkspace}) : undefined, [slot !== null, host, vm]);
    const [activeView, setActiveView] = useState<PanelView>('changes');
    const [, updateConnection] = useState(0);
    const [connectionBusy, setConnectionBusy] = useState(false);
    const [connectionOpen, setConnectionOpen] = useState(false);
    const [release, setRelease] = useState<{github: string | null; exportProject?: () => void}>();
    const [panelId] = useState(() => `twgit-${++nextPanelId}`);
    const [locale, setLocale] = useState(document.documentElement.lang || 'en');
    const [unsavedPaths, setUnsavedPaths] = useState<ReadonlySet<string>>(new Set());
    useEffect(() => {
        if (!shown || !host.unsavedProjectPaths) return;
        const update = () => {
            const paths = host.unsavedProjectPaths?.();
            if (paths) setUnsavedPaths(paths);
        };
        let timer: ReturnType<typeof setTimeout>;
        const schedule = () => {clearTimeout(timer); timer = setTimeout(update, 100);};
        update();
        const stop = host.subscribeProjectEdits?.(schedule);
        return () => {clearTimeout(timer); stop?.();};
    }, [shown, host]);
    const [state, setState] = useState<State>(initial);
    const current = useRef(state);
    current.current = state;
    const epoch = useRef(0);
    const running = useRef(false);
    const refreshPending = useRef<false | 'panel' | 'explorer'>(false);
    const remoteRequest = useRef<AbortController>();
    const alive = useRef(true);
    const opening = useRef(false);
    const dialog = useRef<HTMLDivElement>(null);
    // A closed panel reads nothing; a refresh asked while it is closed waits until it opens again.
    const shownRef = useRef(false);
    const deferred = useRef(false);
    const panelView = useRef(activeView);
    panelView.current = activeView;
    // The last fingerprint acted on, so a failing read or an open diff is not retried on every check.
    const handled = useRef<string | null>(null);
    const labels = labelsFor(locale);
    // A background refresh never drops a user's operation: the operation waits for that refresh instead.
    const background = useRef<Promise<void> | null>(null);
    /** Whether an operation ran to the end, or the message the panel shows for why it did not. */
    const run = async (operation: () => Promise<Partial<State>>, automatic = false): Promise<HistoryActionResult> => {
        if (running.current && !automatic && background.current) await background.current;
        if (running.current || !alive.current) return {done: false};
        let settle = () => {};
        if (automatic) background.current = new Promise(resolve => {settle = resolve;});
        running.current = true;
        const ticket = ++epoch.current;
        // An automatic refresh keeps the current error and notice, such as an uncertain push result. It also
        // leaves the controls enabled: an operation clicked meanwhile waits for it above, whereas a button
        // that turned disabled under the pointer would swallow the click.
        if (!automatic) setState(previous => ({...previous, busy: true, error: null, notice: undefined}));
        try {
            const update = await operation();
            if (epoch.current === ticket) setState(previous => ({...previous, ...update, busy: automatic ? previous.busy : false}));
            return {done: true};
        } catch (error) {
            if (epoch.current !== ticket) return {done: false};
            const code = error instanceof GitPanelError ? error.code : 'failed';
            // A background read that met another tool still writing tries again on the next check, without an alert.
            if (automatic && code === 'changed') {
                handled.current = null;
                return {done: false};
            }
            const localized = labels[code as keyof typeof labels];
            const message = typeof localized === 'string' ? localized : labels.failed;
            setState(previous => ({...previous, error: automatic && previous.error ? previous.error : message,
                busy: automatic ? previous.busy : false, diff: null,
                commit: previous.commit && {...previous.commit, diff: null}}));
            return {done: false, error: message};
        } finally {
            running.current = false;
            // A result dropped by a newer load still ends the busy state, unless a refresh follows at once.
            if (epoch.current !== ticket && !refreshPending.current && alive.current) {
                setState(previous => ({...previous, busy: false}));
            }
            if (automatic) {background.current = null; settle();}
            if (refreshPending.current) {
                const refreshExplorer = refreshPending.current === 'explorer';
                refreshPending.current = false;
                queueMicrotask(() => void controller.refresh(false, refreshExplorer));
            }
        }
    };
    controller.open = (language, inactive = false) => {
        setLocale(language);
        const opened = host.openPanel?.({reference: {providerId: 'turbowarp-plus-git', documentId: 'local-git'},
            filename: 'Git', title: labelsFor(language).title, transient: true, inactive,
            mount(element, close) {
                setVisible(false);
                setSlot({element, close});
                return {requestClose: close, dispose() {setSlot(previous => previous?.element === element ? null : previous);}};
            }});
        if (!opened && !inactive) setVisible(true);
    };
    const closePanel = () => {
        if (slot) slot.close();
        else setVisible(false);
    };
    const openProjectPath = async (root: FileSystemDirectoryHandle) => {
        const directory = host.projectDirectory?.();
        return directory ? (await root.resolve(directory))?.join('/') ?? null : null;
    };
    controller.refresh = async (automatic = false, whileHidden = false) => {
        if (!alive.current || !current.current.repository) return;
        if (!shownRef.current && !whileHidden) {
            deferred.current = true;
            return;
        }
        if (running.current) {
            if (!automatic) refreshPending.current = whileHidden ? 'explorer' : refreshPending.current || 'panel';
            return;
        }
        await run(async () => {
            const {repository} = current.current;
            const project = current.current.project ?? await openProjectPath(repository!.root);
            // A save or a Git command may still be finishing its writes; read again briefly before reporting a change.
            for (let attempt = 1; ; attempt++) {
                try {
                    const snapshot = await repository!.read(project ?? '');
                    return {project, snapshot, changes: snapshot.changes, selected: null, diff: null, commit: null};
                } catch (error) {
                    if (!(error instanceof GitPanelError && error.code === 'changed') || attempt >= 5) throw error;
                    await new Promise(resolve => setTimeout(resolve, 200 * attempt));
                }
            }
        }, automatic);
    };
    useEffect(() => {
        alive.current = true;
        const unsubscribe = host.subscribe?.(event => {
            if ((event === 'loaded' || event === 'folder') && !opening.current) {
                epoch.current++;
                // An operation still running stays busy; its end, or the refresh queued after it, clears the flag.
                setState(previous => ({...previous, project: null, snapshot: null, changes: [],
                    selected: null, diff: null, commit: null, busy: running.current}));
                queueMicrotask(() => void controller.refresh());
            }
        });
        return () => {alive.current = false; epoch.current++; remoteRequest.current?.abort(); unsubscribe?.();};
    }, [host]);
    useEffect(() => {
        shownRef.current = shown;
        if (shown && deferred.current) {
            deferred.current = false;
            void controller.refresh();
        }
    }, [shown]);
    // The branches the branch buttons show: those of the last snapshot, or newer ones read while the panel is not in view.
    const [refs, setRefs] = useState<BranchRefs | null>(null);
    useEffect(() => {
        if (!state.repository) setRefs(null);
        else if (state.snapshot) setRefs(refsOf(state.snapshot));
    }, [state.repository, state.snapshot]);
    const [followers, setFollowers] = useState(controller.followers());
    useEffect(() => {
        controller.onFollowers = setFollowers;
        // A button may have started following before the panel was mounted.
        setFollowers(controller.followers());
        return () => {controller.onFollowers = () => {};};
    }, []);
    // While the panel is open, notice Git commands, agents and editors that change the repository outside the Editor.
    // While it is out of view and a branch button follows it, read only the refs at the same moments, so the button
    // follows branch changes; the panel reads everything again when it comes into view.
    const following = followers > 0;
    useEffect(() => {
        const repository = state.repository;
        if (!repository || !shown && !following) return;
        return watchRepository(document, repository.root, async stopped => {
            const {snapshot} = current.current;
            if (running.current || current.current.repository !== repository) return;
            // A tab behind another one has no boxes; it reads again when it is shown.
            const inView = shown && !!dialog.current && dialog.current.getClientRects().length > 0;
            if (!inView || !snapshot) {
                if (!following) return;
                const next = await repository.refs();
                if (!stopped() && current.current.repository === repository) setRefs(previous => sameRefs(previous, next) ? previous : next);
                return;
            }
            const probe = await repository.probe(snapshot.scope);
            if (stopped() || probe === 'locked' || probe === snapshot.probe || probe === handled.current ||
                current.current.snapshot !== snapshot) return;
            handled.current = probe;
            const {selected, commit} = current.current;
            const activeView = panelView.current;
            // Keep an open diff, commit or review in place and ask for a refresh instead.
            if (activeView === 'changes' && selected || activeView === 'history' && commit) {
                setState(previous => previous.snapshot === snapshot ? {...previous, notice: labelsFor(locale).outdated} : previous);
            } else await controller.refresh(true);
        });
    }, [shown, following, state.repository, locale]);
    useEffect(() => {
        if (!visible || slot) return;
        const previous = document.activeElement as HTMLElement | null;
        dialog.current?.focus();
        return () => {if (previous?.isConnected) previous.focus();};
    }, [visible, slot]);
    const loadRepository = async (root: FileSystemDirectoryHandle, project: string | null, disconnect = true) => {
        const repository = await openRepository(root);
        const snapshot = await repository.read(project ?? '');
        const defaultProject = await repository.defaultProject(await repository.browse());
        if (disconnect) await host.connectionSettings?.disconnect();
        setElements({});
        return {...initial, repository, snapshot, project, defaultProject, changes: snapshot.changes};
    };
    controller.selectRepository = async (root, directory) => {
        const result = await run(async () => {
            const relative = await root.resolve(directory);
            if (!relative) throw new GitPanelError('invalid');
            const previous = current.current.repository;
            const disconnect = !previous || !await previous.root.isSameEntry(root);
            return loadRepository(root, relative.join('/'), disconnect);
        });
        return result.done;
    };
    const chooseRoot = async () => {
        const view = document.defaultView as PickerWindow;
        return run(async () => {
            let root: FileSystemDirectoryHandle;
            try {root = await view.showDirectoryPicker!({id: 'turbowarp-plus-git-root', mode: 'readwrite'});} catch (error) {
                if ((error as DOMException).name === 'AbortError') return {};
                throw error;
            }
            return loadRepository(root, await openProjectPath(root));
        });
    };
    const openProject = (path: string) => run(async () => {
        const directory = await state.repository!.openProject(path);
        opening.current = true;
        try {
            const result = await host.openProject(directory, () => document.defaultView!.confirm(labels.replace));
            if (result === 'cancelled') return {notice: state.notice};
        } finally {opening.current = false;}
        // Loading the project brings its code to the front; keep the panel the person is working in in front of it.
        if (slot) controller.open(locale);
        if (!alive.current) return {};
        setState(previous => ({...previous, project: path, snapshot: null, changes: [], selected: null, diff: null, commit: null}));
        const snapshot = await state.repository!.read(path);
        return {project: path, snapshot, changes: snapshot.changes, selected: null, diff: null, commit: null};
    });
    const commitView = activeView === 'history';
    const commit = commitView ? state.commit : null;
    const changes = commitView ? commit?.changes ?? noChanges : state.changes;
    const selected = commitView ? commit?.selected : state.selected;
    const diff = commitView ? commit?.diff : state.diff;
    const selectFile = (selectedFile: FileChange) => run(async () => {
        const file = {selected: selectedFile, diff: await state.repository!.readDiff(state.snapshot!, selectedFile)};
        return commit ? {commit: {...commit, ...file}} : file;
    });
    const [elements, setElements] = useState<{changes?: string; history?: string}>({});
    const commitChangeList = useRef<HTMLDivElement>(null);
    const revealCommit = useRef<string | null>(null);
    useEffect(() => {
        if (!shown || !commit || revealCommit.current !== commit.oid || !commitChangeList.current) return;
        revealCommit.current = null;
        commitChangeList.current.scrollIntoView({block: 'start'});
    }, [shown, commit]);
    const view = commitView ? 'history' : 'changes';
    const element = elements[view] ?? null;
    const [fileListOpen, setFileListOpen] = useState(false);
    const pending = useMemo(() => {
        const files = new Map<string, FileChange>();
        // Compose HEAD → index and index → working tree for paths changed in both.
        for (const change of state.changes) {
            const earlier = files.get(change.path);
            const combined = earlier ? {...change, before: earlier.before, oldMode: earlier.oldMode, fromHead: true} : change;
            if (combined.before === combined.after && combined.oldMode === combined.newMode) files.delete(change.path);
            else files.set(change.path, combined);
        }
        return files;
    }, [state.changes]);
    const prefix = state.project ? state.project + '/' : '';
    const unsaved = useMemo(() => new Set(state.project !== null ? [...unsavedPaths].map(path => prefix + path) : []),
        [state.project, prefix, unsavedPaths]);
    const savedFiles = useMemo(() => [...pending.values()].filter(change => !unsaved.has(change.path))
        .sort((first, second) => first.path.localeCompare(second.path)), [pending, unsaved]);
    const worktreeChanges = useProjectChanges(state.repository, state.snapshot, state.project, null, savedFiles);
    const historyChanges = useProjectChanges(state.repository, state.snapshot, state.project,
        state.commit?.oid ?? null, state.commit?.changes ?? noChanges);
    const projectChanges = commitView ? historyChanges : worktreeChanges;
    const openDiff = (change: FileChange) => {
        setElements(previous => ({...previous, [view]: undefined}));
        void selectFile(change);
    };
    const openFile = (file: ChangedFile) => {
        const change = commitView ? changes.find(item => item.path === file.path && item.group === file.group) : pending.get(file.path);
        if (change) openDiff(change);
    };
    const openElement = (key: string) => {
        setElements(previous => ({...previous, [view]: key}));
        setState(previous => commitView ? {...previous, commit: previous.commit &&
            {...previous.commit, selected: null, diff: null}} : {...previous, selected: null, diff: null});
    };
    const selectCommit = (oid: string, request?: {repository: Repository; refresh: boolean}) => run(async () => {
        const {repository, snapshot, project} = current.current;
        if (!repository || (request && repository !== request.repository)) throw new GitPanelError('changed');
        if (request) setState(previous => ({...previous, commit: null}));
        const readSnapshot = () => repository.read(project ?? '');
        let baseline = request?.refresh || !snapshot ? await readSnapshot() : snapshot;
        const changes = await repository.historyChanges(baseline, oid).catch(async error => {
            // The drawer follows Git refs even while the panel's snapshot is out of date.
            if (!request || !(error instanceof GitPanelError) || error.code !== 'changed') throw error;
            baseline = await readSnapshot();
            return repository.historyChanges(baseline, oid);
        });
        setElements(previous => ({...previous, history: undefined}));
        if (request) revealCommit.current = oid;
        return {
            ...(baseline !== snapshot ? {snapshot: baseline, changes: baseline.changes, selected: null, diff: null} : {}),
            commit: {oid, changes, selected: null, diff: null}
        };
    });
    controller.openCommit = (language, repository, oid) => {
        if (current.current.repository !== repository) return;
        // Read a deferred refresh together with the commit so reopening cannot clear the new selection.
        const refresh = deferred.current;
        deferred.current = false;
        setActiveView('history');
        controller.open(language);
        void selectCommit(oid, {repository, refresh});
    };
    const remoteOperation = async (operation: RemoteOperation) => {
        const repository = current.current.repository;
        const getSession = host.connectionSettings?.getSession;
        if (!repository || !getSession) return;
        if (operation === 'push' && !document.defaultView?.confirm(labels.confirmPush)) return;
        await run(async () => {
            const ticket = epoch.current;
            const request = new AbortController();
            remoteRequest.current = request;
            try {
                await repository.remoteOperation(operation, getSession, () => {
                    if (epoch.current !== ticket) throw new GitPanelError('changed');
                    if (operation === 'pull' && (host.isProjectDirty() || host.isProjectRunning?.()))
                        throw new GitPanelError('pullUnsafe');
                }, request.signal);
            } finally {
                remoteRequest.current = undefined;
            }
            const snapshot = await repository.read(current.current.project ?? '');
            return {snapshot, changes: snapshot.changes, selected: null, diff: null, commit: null,
                notice: operation === 'pull' && current.current.project !== null ? labels.pulledProject : labels.remoteDone};
        });
    };
    const readOrigin = useMemo(() => {
        const repository = state.repository;
        if (!repository || state.busy) return undefined;
        return async () => {
            const ticket = epoch.current;
            const remote = await repository.readOrigin();
            return epoch.current === ticket ? remote : undefined;
        };
    }, [state.repository, state.busy]);
    // A connected GitHub connection reads pull request contents over Git Smart HTTP, so private repositories work too.
    const pullRequestConnection = useMemo(() => {
        const settings = host.connectionSettings;
        const getSession = settings?.getSession;
        return getSession ? {getSession, connected: () => settings.getView().state.status === 'connected',
            reviewGranted: () => settings.getView().review === true} : undefined;
    }, [host]);
    const [message, setMessage] = useState('');
    const [commitSelection, setCommitSelection] = useState<{
        repository: Repository; branch: string; head: string | null; scope: string; paths: ReadonlySet<string>;
    } | null>(null);
    const localOperation = (request: LocalOperation | ((repository: Repository, guard: () => void) => Promise<LocalOperation>),
        notice?: string, isCurrent = () => true) => {
        const repository = current.current.repository;
        if (!repository || !host.localWrite) return Promise.resolve<HistoryActionResult>({done: false});
        return run(async () => {
            const ticket = epoch.current;
            const guard = () => {
                if (epoch.current !== ticket || current.current.repository !== repository || !isCurrent()) {
                    throw new GitPanelError('changed');
                }
            };
            guard();
            const operation = typeof request === 'function' ? await request(repository, guard) : request;
            const check = () => {
                guard();
                // Staging records the saved files; edits still in the Editor would be left out without a word.
                if (operation.kind === 'stage' && host.isProjectDirty()) throw new GitPanelError('saveFirst');
                if (operation.kind === 'commit' && operation.selection) {
                    const {project} = current.current;
                    const pending = host.unsavedProjectPaths?.();
                    const prefix = project ? project + '/' : '';
                    if (project !== null && operation.selection.files.some(({path}) => path.startsWith(prefix) &&
                        (pending ? pending.has(path.slice(prefix.length)) : host.isProjectDirty())))
                        throw new GitPanelError('saveFirst');
                }
                // Switching replaces the files the Editor opened, like pull.
                if ((operation.kind === 'switchBranch' || (operation.kind === 'createBranch' && operation.checkout)) &&
                    (host.isProjectDirty() || host.isProjectRunning?.())) throw new GitPanelError('switchUnsafe');
            };
            check();
            if (!('paths' in operation) || operation.paths.length) await repository.localOperation(operation, check);
            if (operation.kind === 'commit') setMessage('');
            const snapshot = await repository.read(current.current.project ?? '');
            const update = {snapshot, changes: snapshot.changes, selected: null, diff: null, commit: null, notice};
            if (operation.kind !== 'stage' && operation.kind !== 'unstage') return update;
            const active = current.current.selected;
            if (!active) return update;
            const group = operation.paths.includes(active.path) ?
                (operation.kind === 'stage' ? 'staged' : active.group === 'staged' ? 'unstaged' : active.group) : active.group;
            const matching = snapshot.changes.filter(change => change.path === active.path);
            const selected = matching.find(change => change.group === group) ?? matching[0];
            if (!selected) return update;
            try {
                return {...update, selected, diff: await repository.readDiff(snapshot, selected)};
            } catch (error) {
                if (error instanceof GitPanelError && error.code === 'changed') return {...update, notice: labels.outdated};
                throw error;
            }
        });
    };
    const [newBranch, setNewBranch] = useState('');
    const [switchAfterCreate, setSwitchAfterCreate] = useState(true);
    const changeBranch = async (operation: BranchOperation): Promise<HistoryActionResult> => {
        const repository = current.current.repository;
        const project = current.current.project;
        const switching = operation.kind === 'switchBranch' || operation.checkout;
        if (!repository) return {done: false};
        // Tell before switching when the open project folder is not on the branch.
        const at = operation.kind === 'createBranch' ? operation.at : undefined;
        if (switching && project && !(operation.kind === 'createBranch' && !operation.fromRemote && !at) &&
            !await (at ? repository.hasFolder(at, project, 'commit') :
                repository.hasFolder(operation.name, project, operation.kind === 'createBranch' && operation.fromRemote)) &&
            !document.defaultView?.confirm(labels.projectMissing)) return {done: false};
        const result = await localOperation(operation, switching ? labels.switched : labels.branchCreated);
        if (operation.kind === 'createBranch' && !operation.fromRemote && !at) setNewBranch('');
        return result;
    };
    /**
     * Opens a pull request version fetched over the connection: creates `pr/<number>` at its head (or reuses that
     * branch when it already points there), switches to it with the same refusals as any switch, and opens the project
     * folder again from it. The branch the person was on stays, so switching back is an ordinary switch.
     */
    const openPullRequest = async (number: number, head: string): Promise<HistoryActionResult> => {
        const repository = current.current.repository;
        if (!repository) return {done: false};
        const original = current.current.snapshot?.branch ?? null;
        const name = pullRequestBranch(number);
        const result = await changeBranch({kind: 'createBranch', name, at: head, checkout: true, reuse: true});
        if (!result.done) return result;
        const project = current.current.project;
        if (project !== null && await repository.hasFolder(name, project)) await openProject(project);
        const notice = (original && original !== name ? labels.openedPullRequest : labels.openedPullRequestDetached)
            .replace('{number}', String(number)).replace('{branch}', name).replace('{previous}', original ?? '');
        if (alive.current) setState(previous => previous.error ? previous : {...previous, notice});
        return result;
    };
    // The history graph reads its own pages after each snapshot, through the same queue as the other reads.
    const [history, setHistory] = useState<{commits: HistoryCommit[]; cursor: HistoryCursor | null; loading: boolean; failed: boolean}>(
        {commits: [], cursor: null, loading: false, failed: false});
    const historyTicket = useRef(0);
    useEffect(() => {
        const ticket = ++historyTicket.current;
        const repository = state.repository;
        if (!repository || !state.snapshot) {
            setHistory({commits: [], cursor: null, loading: false, failed: false});
            return;
        }
        // The rows read before stay until the new page arrives, so focus in the list is kept.
        setHistory(previous => ({...previous, cursor: null, loading: true, failed: false}));
        repository.history().then(page => {
            if (historyTicket.current === ticket) setHistory({commits: page.commits, cursor: page.cursor, loading: false, failed: false});
        }, () => {
            if (historyTicket.current === ticket) setHistory({commits: [], cursor: null, loading: false, failed: true});
        });
    }, [state.repository, state.snapshot]);
    const showMoreHistory = () => {
        const repository = state.repository;
        if (!repository || !history.cursor || history.loading) return;
        const ticket = historyTicket.current;
        setHistory(previous => ({...previous, loading: true}));
        repository.history({after: history.cursor}).then(page => {
            if (historyTicket.current === ticket) setHistory(previous => ({commits: [...previous.commits, ...page.commits],
                cursor: page.cursor, loading: false, failed: false}));
        }, () => {
            if (historyTicket.current === ticket) setHistory(previous => ({...previous, cursor: null, loading: false, failed: true}));
        });
    };
    const focusTrap = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {event.stopPropagation(); closePanel(); return;}
        if (event.key !== 'Tab') return;
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')]
            .filter(item => item.getClientRects().length > 0);
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
            event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
    };
    // One loader per selected change, so thumbnails read each asset once.
    const loadAsset = useMemo(() => state.repository && state.snapshot && selected ?
        state.repository.assetLoader(state.snapshot, selected) : undefined, [state.repository, state.snapshot, selected]);
    const versionDirectory = host.projectDirectory?.();
    const hasProject = host.projectDirectory ? !!versionDirectory : state.project !== null;
    const canUseVersions = !!state.repository && hasProject;
    const projectVersionScope = async (repository: Repository) => {
        const project = current.current.project;
        const directory = host.projectDirectory?.();
        const ticket = epoch.current;
        const parts = directory ? await repository.root.resolve(directory) : null;
        const folder = host.projectDirectory ? parts?.join('/') : project;
        if (folder === null || folder === undefined) throw new GitPanelError('invalid');
        const guard = () => {
            if (!alive.current || epoch.current !== ticket || current.current.repository !== repository ||
                (host.projectDirectory ? host.projectDirectory() !== directory : current.current.project !== project))
                throw new GitPanelError('changed');
        };
        guard();
        return {folder, guard};
    };
    controller.openVersion = host.previewProjectVersion && canUseVersions ? oid => run(async () => {
        const repository = current.current.repository!;
        const {folder, guard} = await projectVersionScope(repository);
        const files = await repository.readProjectVersion(oid, folder);
        guard();
        try {await host.previewProjectVersion!({oid, folder, files});}
        catch {throw new GitPanelError('versionOpenFailed');}
        return {};
    }) : undefined;
    controller.restoreVersion = host.restoreProjectVersions && host.localWrite && canUseVersions ? async oid => {
        let cancelled = false;
        const result = await run(async () => {
            const repository = current.current.repository!;
            const {folder, guard} = await projectVersionScope(repository);
            const check = () => {
                guard();
                if (host.isProjectDirty() || host.isProjectRunning?.()) throw new GitPanelError('restoreUnsafe');
            };
            check();
            const plan = await repository.planProjectRestore(oid, folder);
            check();
            if (!plan.changes.length) throw new GitPanelError('versionIdentical');
            if (host.validateProjectVersion) {
                const files = await repository.readProjectVersion(oid, folder);
                try {host.validateProjectVersion(files);}
                catch {throw new GitPanelError('versionOpenFailed');}
            }
            check();
            if (!await confirmProjectRestore(document, plan, labels)) {
                cancelled = true;
                return {};
            }
            check();
            await repository.localOperation({kind: 'restoreProject', plan, author: host.localWrite?.author?.()}, check);
            const snapshot = await repository.read(folder);
            return {project: folder, snapshot, changes: snapshot.changes, selected: null, diff: null, commit: null, notice: labels.versionRestored};
        });
        if (result.done && !cancelled && alive.current && !shownRef.current) controller.open(locale);
        return result;
    } : undefined;
    controller.changeBranch = changeBranch;
    controller.changeExplorerEntry = (repository, directory, kind, entry, isCurrent) => localOperation(async (active, guard) => {
        const parts = await active.root.resolve(directory);
        const relative = pathParts(entry.path);
        if (!parts || !relative.length || relative.join('/') !== entry.path) throw new GitPanelError('invalid');
        const path = [...parts, ...relative].join('/');
        if (pathParts(path).some(part => part.toLowerCase() === '.git')) throw new GitPanelError('invalid');
        const snapshot = await active.read(parts.join('/'));
        guard();
        if (!snapshot.branch) throw new GitPanelError('unsupported');
        const paths = snapshot.changes.filter(change => (kind === 'stage' ? change.group !== 'staged' : change.group === 'staged') &&
            (change.path === path || (entry.kind === 'directory' && change.path.startsWith(`${path}/`)))).map(change => change.path);
        return {kind, paths};
    }, undefined, () => current.current.repository === repository && isCurrent());
    controller.reload = () => {
        if (current.current.project !== null) void openProject(current.current.project);
    };
    controller.openRelease = (language, github, exportProject) => {
        setLocale(language);
        setRelease({github, exportProject});
    };
    controller.choose = async language => {
        if (connectionBusy) return;
        setLocale(language);
        const before = current.current.repository;
        const result = await chooseRoot();
        // The panel shows the chosen repository, or why it could not be read; a cancelled choice opens nothing.
        if (!result.done && result.error || current.current.repository !== before) controller.open(language);
    };
    const branchState: BranchButtonState = {repository: !!state.repository, branch: refs?.branch, head: refs?.head ?? null,
        branches: refs?.branches ?? [], remoteBranches: refs?.remoteBranches ?? [], writable: !!host.localWrite && !!refs, busy: state.busy,
        project: hasProject};
    const published = JSON.stringify(branchState);
    useEffect(() => controller.publish(branchState, state.repository, state.snapshot), [published, state.repository, state.snapshot]);
    const connectionDialog = connectionOpen && host.connectionSettings && <ConnectionSettings
        view={document.defaultView!} settings={host.connectionSettings}
        locale={locale} readOrigin={readOrigin} busy={connectionBusy} setBusy={setConnectionBusy}
        onChange={() => updateConnection(value => value + 1)} onClose={() => setConnectionOpen(false)}/>;
    const releaseDialog = release && <ReleaseDialog locale={locale} repository={state.repository}
        github={release.github} connection={host.connectionSettings} exportProject={release.exportProject} onClose={() => setRelease(undefined)}/>;
    if (!shown) return <>{null}{connectionDialog}{releaseDialog}</>;
    const snapshot = state.snapshot;
    const branching = !!host.localWrite && !!snapshot;
    const canRecord = !!host.localWrite && !!snapshot?.branch;
    const writable = canRecord && !commitView;
    const filesToSave = [...unsaved].sort();
    const publication = host.pullRequestPublication?.();
    const selectedPaths = commitSelection && commitSelection.repository === state.repository &&
        snapshot && commitSelection.branch === snapshot.branch && commitSelection.head === snapshot.head &&
        commitSelection.scope === snapshot.scope ? commitSelection.paths : new Set<string>();
    const filesToCommit = [...selectedPaths].flatMap(path => {
        const change = pending.get(path);
        return change && !unsaved.has(path) ? [{path, oid: change.after}] : [];
    });
    const toggleCommitFile = (path: string, included: boolean) => {
        if (!state.repository || !snapshot?.branch) return;
        const paths = new Set(selectedPaths);
        if (included) paths.add(path);
        else paths.delete(path);
        setCommitSelection({repository: state.repository, branch: snapshot.branch, head: snapshot.head, scope: snapshot.scope, paths});
    };
    const saveFiles = () => run(async () => {
        try {await host.saveProjectFiles?.();}
        catch {throw new GitPanelError('saveFilesFailed');}
        const next = await state.repository!.read(state.project ?? '');
        return {snapshot: next, changes: next.changes, selected: null, diff: null};
    });
    const projectList = typeof projectChanges === 'object' ? projectChanges : null;
    // The open project matches the working tree, so only the working-tree side of its project file can be located.
    const projectFile = state.project === null ? null : [state.project, 'project.source.json'].filter(Boolean).join('/');
    const fileLocator = (change: FileChange) => locator && change.path === projectFile &&
        (change.group === 'unstaged' || change.group === 'untracked' ||
            (change.group === 'staged' && !state.changes.some(item => item.path === change.path && item.group === 'unstaged'))) ?
        locator : undefined;
    const reviewLocator = (path: string, headSha: string) => locator && path === projectFile && state.snapshot?.head === headSha &&
        !state.changes.length ? locator : undefined;
    const selection = projectList && !selected ? findElement(projectList.list, element) : null;
    const selectedFiles = selected ? [selected] : selection?.element.files ?? [];
    const stageActions = writable ? selectedFiles.filter(file => pending.has(file.path) &&
        state.changes.some(change => change.path === file.path && change.group === file.group) &&
        // The project comparison shows the working copy when a path has both versions.
        (selected || pending.get(file.path)?.group === file.group)) : [];
    // Only a tab leaves room for more tabs beside it; the modal dialog keeps its comparisons inside.
    const openTabs = slot && host.openPanel && host.renderReviewBlock ?
        (key: string, files: readonly ProjectSourceTabsFile[], rememberAs?: string) =>
            openProjectSourceTabs(host.openPanel, {key, files, renderBlock: host.renderReviewBlock!, locale, rememberAs}) : undefined;
    const openFileTabs = (change: FileChange) => openTabs && ((before: string | null, after: string | null) => {
        let files: ProjectSourceTabsFile[];
        try {
            files = [{path: change.path, before: parseProjectSource(before), after: parseProjectSource(after),
                loadAsset: loadAsset ?? undefined, locateBlock: fileLocator(change)}];
        } catch {
            return;
        }
        openTabs(`${commit?.oid ?? change.group}:${change.path}`, files);
    });
    const savedFileRow = (change: FileChange) => <li key={change.path}>
        {writable && <input type="checkbox" checked={selectedPaths.has(change.path)}
            aria-label={labels.includeFile.replace('{path}', change.path)} disabled={state.busy}
            onChange={event => toggleCommitFile(change.path, event.currentTarget.checked)}/>}
        <button type="button" className="twgit-file twgit-file-entry" data-git-group={change.group} disabled={state.busy}
            aria-pressed={selected?.path === change.path} onClick={() => openDiff(change)}>
            <FileIdentity path={change.path}/>
            <small className="twgit-change-kind">{!change.after ? labels.deleted : !change.before ? labels.added : labels.modified}</small>
            <GitStatusBadge group={change.group} labels={labels}/>
        </button>
    </li>;
    const savedFileList = (files: readonly FileChange[]) =>
        <ul className="twgit-file-state-list">{files.map(savedFileRow)}</ul>;
    const otherPaths = new Set(projectList?.list.other.map(file => file.path));
    const projectFiles = savedFiles.filter(change => !otherPaths.has(change.path));
    const fileDetails = commitView && commit ? <section>
        <h3>{labels.commit}: {changes.length}</h3>
        <ul>{changes.map(change => <li key={change.path}>
            <button className="twgit-file twgit-file-entry" data-git-group="commit" disabled={state.busy}
                aria-pressed={selected === change} onClick={() => openDiff(change)}>
                <FileIdentity path={change.path}/>
                <small className="twgit-change-kind">{!change.after ? labels.deleted : !change.before ? labels.added : labels.modified}</small>
                <GitStatusBadge group="commit" labels={labels}/>
            </button>
        </li>)}</ul>
    </section> : null;
    const projectChangeList = projectList && <ProjectChangeListView changes={projectList}
        selected={selection ? element : null} selectedFile={selected} locale={locale} busy={state.busy}
        onSelect={openElement} onSelectFile={openFile} fileListOpen={fileListOpen} setFileListOpen={setFileListOpen}
        fileList={commitView ? fileDetails : projectFiles.length > 0 && savedFileList(projectFiles)}
        renderOtherFile={commitView ? undefined : file => {
            const change = pending.get(file.path);
            return change && !unsaved.has(file.path) ? savedFileRow(change) : null;
        }}/>;
    const content = <>
            <header>
                {!slot && <h2>{labels.title}</h2>}
                <div className="twgit-repository-heading">
                    <RepositoryIdentity repositoryName={state.repository?.root.name} labels={labels}
                        repositoryAction={<button type="button" className="twgit-panel-action"
                            onClick={() => void controller.refresh()} disabled={!state.repository || state.busy}>
                            <PanelIcon name="refresh"/>{labels.refresh}</button>}/>
                    {state.project === null && state.defaultProject !== null &&
                        <button type="button" className="twgit-panel-action" disabled={state.busy}
                            onClick={() => void openProject(state.defaultProject!)}><PanelIcon name="choose"/>{labels.openDefault}</button>}
                    {state.repository && !!host.connectionSettings?.modes.length &&
                        <button type="button" className="twgit-panel-action" disabled={state.busy || connectionBusy}
                            onClick={() => setConnectionOpen(true)}><PanelIcon name="globe"/>
                            {locale.startsWith('ja') ? 'GitHub に接続…' : 'Connect to GitHub…'}</button>}
                </div>
                {!slot && <CloseButton label={labels.close} onClick={closePanel}/>}
            </header>
            <GitWorkflow id={panelId} snapshot={state.snapshot}
                labels={labels} active={activeView} unsavedFiles={filesToSave.length} savedFiles={savedFiles.length} onSelect={setActiveView}/>
            {state.error && <p className="twgit-error" role="alert">{state.error}</p>}
            {state.notice && <div className="twgit-context">
                <span role="status">{state.notice}</span>
                {state.project !== null && (state.notice === labels.pulledProject || state.notice === labels.switched || state.notice === labels.versionRestored) &&
                    <button type="button" className="twgit-panel-action" disabled={state.busy} onClick={() => controller.reload()}>
                        <PanelIcon name="reload"/>{labels.reload}</button>}
            </div>}
            {state.busy && <p className="twgit-status" role="status">{labels.loading}</p>}
            {panelViews.map(section => <div key={section} className="twgit-workflow-view" role="region"
                id={`${panelId}-view-${section}`} aria-labelledby={`${panelId}-step-${section}`}
                hidden={activeView !== section}>
                {activeView === section && !state.repository && <p className="twgit-status">{labels.empty}</p>}
                {(section === 'history' || section === 'github') && activeView === section &&
                    (host.connectionSettings ? <GitHubSync settings={host.connectionSettings} locale={locale} branch={snapshot?.branch}
                        busy={state.busy || connectionBusy || !readOrigin} runOperation={remoteOperation}
                        syncStatus={snapshot && snapshot.upstream.state !== 'unknown' ?
                            {state: snapshot.upstream.state, text: upstreamText(snapshot, labels), title: labels.checkedAt} :
                            undefined}/> : <p className="twgit-status">{labels.githubUnavailable}</p>)}
                {section === 'github' && activeView === section && state.repository && host.renderReviewBlock &&
                        <PullRequestReviewPanel repository={state.repository} locale={locale} renderBlock={host.renderReviewBlock}
                            locateFor={reviewLocator} openTabs={openTabs} connection={pullRequestConnection}
                            publication={publication}
                            openLocally={branching ? {open: openPullRequest, busy: state.busy} : undefined}/>}
                {section === 'save' && activeView === section && snapshot && state.repository &&
                    <SaveFilesView repository={state.repository} snapshot={snapshot} project={state.project}
                        unsavedPaths={unsavedPaths} paths={filesToSave} busy={state.busy} locale={locale} labels={labels}
                        readUnsaved={host.readUnsavedProjectFile} renderBlock={host.renderReviewBlock}
                        onSave={host.saveProjectFiles ? saveFiles : undefined}/>}
                {(section === 'changes' || section === 'history') && activeView === section && state.repository &&
                    <div className="twgit-content" data-commit-view={commitView ? undefined : ''}>
                <aside className={commitView ? undefined : 'twgit-commit-changes'}>
                {!commitView ? <>
                    {host.projectDirectory && state.project === null && state.defaultProject === null &&
                        <p>{labels.openProjectFromMenu}</p>}
                    {snapshot && (savedFiles.length ? <>
                        {projectChanges === 'loading' && <p role="status">{projectChangeLabels(locale).loading}</p>}
                        {projectChanges === 'unreadable' && <p>{projectChangeLabels(locale).unreadable}</p>}
                        {projectChangeList ?? <section>
                            <h4 className="twgit-element-target">{projectChangeLabels(locale).other}</h4>
                            {savedFileList(savedFiles)}
                        </section>}
                    </> : <p>{labels.noFilesToCommit}</p>)}
                </> : <>
                    {state.repository && snapshot && <PullRequestCreation repository={state.repository} head={snapshot.head}
                        locale={locale} publication={publication} getSession={host.connectionSettings?.getSession}
                        connected={pullRequestConnection?.connected() === true}
                        isCurrent={() => current.current.repository === state.repository &&
                            current.current.snapshot?.head === snapshot.head && current.current.snapshot?.branch === snapshot.branch}/>}
                    <h3 className="twgit-section-heading">{labels.history}</h3>
                    {state.snapshot && <HistoryGraph commits={history.commits} selected={state.commit?.oid ?? null} locale={locale} busy={state.busy}
                        onSelect={oid => void selectCommit(oid)} hasMore={!!history.cursor} loadingMore={history.loading}
                        onShowMore={showMoreHistory} localBranches={state.snapshot.branches} onOpenVersion={controller.openVersion} onRestoreVersion={controller.restoreVersion}
                        {...branching ? {
                            onCreateBranch: (oid: string, name: string, checkout: boolean) =>
                                changeBranch({kind: 'createBranch', name, at: oid, checkout}),
                            onSwitchBranch: (name: string) => changeBranch({kind: 'switchBranch', name}),
                            onCreateFromRemote: (name: string) => changeBranch({kind: 'createBranch', name, fromRemote: true, checkout: true})
                        } : {}}/>}
                    {history.loading && !history.commits.length && <p>{labels.historyLoading}</p>}
                    {history.failed && <p>{labels.historyFailed}</p>}
                    {state.snapshot && !history.loading && !history.failed && !history.commits.length && <p>{labels.unborn}</p>}
                </>}
                {commitView && commit && <div ref={commitChangeList}>
                    {projectChanges === 'loading' && <p role="status">{projectChangeLabels(locale).loading}</p>}
                    {projectChanges === 'unreadable' && <p>{projectChangeLabels(locale).unreadable}</p>}
                    {projectChangeList ?? fileDetails}
                    {!changes.length && <p>{labels.clean}</p>}
                </div>}
                    {commitView && branching && state.snapshot && <section className="twgit-branches" aria-label={labels.branches}>
                        <h3>{labels.branches}</h3>
                        <ul>{state.snapshot.branches.map(name => <li key={name}><code>{name}</code>
                            {name === state.snapshot!.branch ? <small> · {labels.currentBranch}</small> :
                                <button type="button" disabled={state.busy} aria-label={`${labels.switchTo}: ${name}`}
                                    onClick={() => void changeBranch({kind: 'switchBranch', name})}>{labels.switchTo}</button>}
                        </li>)}</ul>
                        {state.snapshot.head && <form onSubmit={event => {
                            event.preventDefault();
                            if (newBranch.trim()) void changeBranch({kind: 'createBranch', name: newBranch.trim(), checkout: switchAfterCreate});
                        }}>
                            <label>{labels.newBranch} <input value={newBranch} disabled={state.busy}
                                onChange={event => setNewBranch(event.currentTarget.value)}/></label>
                            <label><input type="checkbox" checked={switchAfterCreate} disabled={state.busy}
                                onChange={event => setSwitchAfterCreate(event.currentTarget.checked)}/> {labels.switchAfterCreate}</label>
                            <button type="submit" disabled={state.busy || !newBranch.trim()}>{labels.createBranch}</button>
                        </form>}
                        {state.snapshot.remoteBranches.length > 0 && <>
                            <h3>{labels.remoteBranches}</h3>
                            <ul>{state.snapshot.remoteBranches.map(name => <li key={name}><code>origin/{name}</code>
                                <button type="button" disabled={state.busy} aria-label={`${labels.createFromRemote}: origin/${name}`}
                                    onClick={() => void changeBranch({kind: 'createBranch', name, fromRemote: true, checkout: true})}>
                                    {labels.createFromRemote}</button></li>)}</ul>
                        </>}
                    </section>}
                </aside>
                <main className="twgit-diff" data-git-actions={stageActions.length ? '' : undefined}>
                    <div className="twgit-diff-scroll">
                    {selection && projectList ? <ProjectElementView changes={projectList} selection={selection} locale={locale}
                        locateBlock={commitView ? undefined : locator}
                        renderBlock={host.renderReviewBlock} onSelectFile={openFile}/> :
                        selected ? <FileDiffView change={selected} diff={diff ?? null} labels={labels} locale={locale}
                            locateBlock={fileLocator(selected)} onOpenTabs={openFileTabs(selected)}
                            renderBlock={host.renderReviewBlock}/> :
                            <p>{commitView && !commit ? labels.selectRecord : labels.select}</p>}
                    </div>
                    {stageActions.length > 0 && <div className="twgit-diff-actions" role="group" aria-label={labels.recordFileActions}>
                        {stageActions.map(file => {
                            const kind = selectedPaths.has(file.path) ? 'unstage' : 'stage';
                            const descriptionId = `${panelId}-target-${kind}-${encodeURIComponent(file.path)}`;
                            return <div key={file.group + ':' + file.path}>
                                <FileIdentity path={file.path} id={descriptionId}/>
                                <button className={kind === 'stage' ? 'twgit-primary' : undefined} type="button"
                                    aria-describedby={descriptionId} disabled={state.busy || kind === 'stage' && (unsaved.has(file.path) || !pending.has(file.path))}
                                    onClick={() => toggleCommitFile(file.path, kind === 'stage')}>
                                    {labels[kind]}</button>
                            </div>;
                        })}
                    </div>}
                </main>
                {writable && snapshot?.branch && savedFiles.length > 0 && <footer className="twgit-commit-footer">
                    <form className="twgit-commit" aria-label={labels.nextRecord} onSubmit={event => {
                        event.preventDefault();
                        if (!filesToCommit.length || !message.trim() || state.busy) return;
                        void localOperation({kind: 'commit', message, author: host.localWrite?.author?.(),
                            selection: {branch: snapshot.branch!, head: snapshot.head, files: filesToCommit}}, labels.committed);
                    }}>
                        <p role="status">{labels.selectedFiles.replace('{count}', String(filesToCommit.length))}</p>
                        <label>{labels.commitLabel}<textarea value={message} rows={3} disabled={state.busy}
                            onChange={event => setMessage(event.currentTarget.value)}/></label>
                        <button className="twgit-primary" type="submit" disabled={state.busy || !filesToCommit.length || !message.trim()}>
                            {labels.commitButton}</button>
                    </form>
                </footer>}
                </div>}
            </div>)}
    </>;
    // In a tab the Editor stays usable beside the panel, so there is no backdrop, focus trap or Escape to close.
    return <>
        {slot ? createPortal(<div className="twgit-panel twgit-panel-tab" ref={dialog} role="region" aria-label={labels.title}>{content}</div>,
            slot.element) : <div className="twgit-backdrop">
            <div className="twgit-panel" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={labels.title}
                onKeyDown={focusTrap}>{content}</div>
        </div>}
        {connectionDialog}
        {releaseDialog}
    </>;
}

/** The GitHub relation in plain words, with the number of records where it helps. */
function upstreamText({upstream}: Snapshot, labels: ReturnType<typeof labelsFor>) {
    switch (upstream.state) {
    case 'same': return labels.upstreamSame;
    case 'ahead': return `${labels.upstreamAhead}: ${upstream.ahead} ${labels.records}`;
    case 'behind': return `${labels.upstreamBehind}: ${upstream.behind} ${labels.records}`;
    case 'diverged': return `${labels.upstreamDiverged}: +${upstream.ahead} / −${upstream.behind}`;
    default: return '';
    }
}

const refsOf = ({branch, head, branches, remoteBranches}: Snapshot): BranchRefs => ({branch, head, branches, remoteBranches});
const announce = () => {for (const listener of [...registrations]) listener();};

export function mountGitPanel({vm, document, host}: {vm: object; document: Document; host: GitHost}) {
    if (!(document.defaultView as PickerWindow)?.showDirectoryPicker) return null;
    const root = document.createElement('div');
    document.body.append(root);
    const controller = createController();
    controllers.set(vm, controller);
    render(<GitPanel vm={vm} document={document} host={host} controller={controller}/>, root);
    announce();
    return {refresh: () => controller.refresh(), open: (locale: string, inactive?: boolean) => controller.open(locale, inactive),
        selectRepository: (root: FileSystemDirectoryHandle, project: FileSystemDirectoryHandle) =>
            controller.selectRepository(root, project), getCommitRepository() {
        const repository = controller.repository;
        if (!host.localWrite || !repository) return null;
        return {
            root: repository.root,
            current: () => controllers.get(vm) === controller && controller.repository === repository
        };
    }, dispose() {
        if (controllers.get(vm) === controller) controllers.delete(vm);
        void host.connectionSettings?.disconnect().catch(() => {});
        unmountComponentAtNode(root);
        root.remove();
        announce();
    }};
}

/** The branch button of the panel mounted for `vm`, or nothing while no panel is mounted for it. */
/** Calls `listener` with the controller of the panel mounted for `vm`, now and whenever it is mounted or disposed. */
function findController(vm: object, listener: (controller: Controller | undefined) => void) {
    const update = () => listener(controllers.get(vm));
    registrations.add(update);
    update();
    return () => {registrations.delete(update);};
}

/** The panel mounted for `vm` and what it last published. Following it keeps the closed panel watching the branches. */
function useController(vm: object) {
    const [controller, setController] = useState(() => controllers.get(vm));
    useEffect(() => findController(vm, setController), [vm]);
    const [state, setState] = useState(controller?.branch);
    useEffect(() => {
        if (!controller) return;
        const update = () => setState(controller.branch);
        update();
        return controller.follow(update);
    }, [controller]);
    return {controller, state};
}

function BranchEntry({vm, locale}: {vm: object; locale: string}) {
    const {controller, state} = useController(vm);
    if (!controller || !state) return null;
    return <BranchButton state={state} locale={locale} open={() => controller.open(locale)} choose={() => void controller.choose(locale)}
        reload={() => controller.reload()}
        switchBranch={name => controller.changeBranch({kind: 'switchBranch', name})}
        createBranch={(name, checkout) => controller.changeBranch({kind: 'createBranch', name, checkout})}
        createFromRemote={name => controller.changeBranch({kind: 'createBranch', name, fromRemote: true, checkout: true})}/>;
}

/**
 * Renders the button for the host's menu bar that shows the current branch of the panel mounted for `vm` and opens the
 * menu of branches, the panel and the repository choice. It renders nothing while no panel is mounted for `vm`, such as
 * when the host does not offer local Git, and shares the panel's repository, operations and checks.
 */
export function renderBranchButton(createElement: (component: any, props: any, ...children: any[]) => any,
    {vm, locale = 'en'}: {vm: object; locale?: string}) {
    return createElement(BranchEntry, {vm, locale});
}

/** Adds Git commands next to the host's project-folder command. */
export function GitFileMenu({vm, locale = 'en', MenuItem, onRequestClose, exportProject}: {
    vm: object; locale?: string; MenuItem: React.ElementType; onRequestClose(): void; exportProject?: () => void;
}) {
    const {controller} = useController(vm);
    const repository = controller?.repository;
    const [release, setRelease] = useState<{repository: Repository; url: string | null}>();
    useEffect(() => {
        if (!repository) return;
        let current = true;
        const update = (url: string | null) => {if (current) setRelease({repository, url});};
        void repository.readOrigin().then(origin => {
            const name = gitHubRepositoryFromOrigin(origin);
            update(name ? `https://github.com/${name}` : null);
        }, () => update(null));
        return () => {current = false;};
    }, [repository]);
    if (!controller) return null;
    const releaseUrl = release && release.repository === repository ? release.url : null;
    const japanese = locale.startsWith('ja');
    const item = (command: string, label: string, icon: 'choose' | 'tag', action?: () => void) => {
        const run = action && (() => {onRequestClose(); action();});
        return <MenuItem command={command} onClick={run}>
            <span role="button" tabIndex={run ? 0 : -1} aria-disabled={!run || undefined}
                className="twgit-file-menu-item" onKeyDown={event => {
                    if (!run || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    event.stopPropagation();
                    run();
                }}><PanelIcon name={icon}/>{label}</span>
        </MenuItem>;
    };
    return <>
        {item('git-choose-repository', labelsFor(locale).choose, 'choose', () => void controller.choose(locale))}
        {item('git-releases', japanese ? 'リリース…' : 'Releases…', 'tag',
            !repository || release?.repository === repository ?
                () => controller.openRelease(locale, releaseUrl || null, exportProject) : undefined)}
    </>;
}

type History = {commits: HistoryCommit[]; cursor: HistoryCursor | null; loading: boolean; failed: boolean};

/** The history of the panel's repository, read again whenever its branches move. */
function HistoryEntry({vm, locale, query}: {vm: object; locale: string; query: string}) {
    const {controller, state} = useController(vm);
    const labels = labelsFor(locale);
    const repository = state && controller?.repository || null;
    const [history, setHistory] = useState<History>({commits: [], cursor: null, loading: false, failed: false});
    const [selected, setSelected] = useState<string | null>(null);
    const ticket = useRef(0);
    const root = useRef<HTMLDivElement>(null);
    const refs = state ? [state.head, ...state.branches, '', ...state.remoteBranches].join('\n') : '';
    useEffect(() => {
        const current = ++ticket.current;
        if (!repository) {
            setHistory({commits: [], cursor: null, loading: false, failed: false});
            return;
        }
        // The rows read before stay until the new page arrives, so focus in the list is kept.
        setHistory(previous => ({...previous, cursor: null, loading: true, failed: false}));
        repository.history().then(page => {
            if (ticket.current === current) setHistory({commits: page.commits, cursor: page.cursor, loading: false, failed: false});
        }, () => {
            if (ticket.current === current) setHistory({commits: [], cursor: null, loading: false, failed: true});
        });
    }, [repository, refs]);
    const showMore = () => {
        if (!repository || !history.cursor || history.loading) return;
        const current = ticket.current;
        setHistory(previous => ({...previous, loading: true}));
        repository.history({after: history.cursor}).then(page => {
            if (ticket.current === current) setHistory(previous => ({commits: [...previous.commits, ...page.commits],
                cursor: page.cursor, loading: false, failed: false}));
        }, () => {
            if (ticket.current === current) setHistory(previous => ({...previous, cursor: null, loading: false, failed: true}));
        });
    };
    const {report, element: snackbar} = useBranchSnackbar(locale, !!state?.project, {
        open: () => controller?.open(locale), reload: () => controller?.reload()
    }, () => root.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({preventScroll: true}));
    if (!controller || !state) return null;
    if (!repository) return <div className="twgit-history-view" ref={root}>
        <p>{labels.historyViewEmpty}</p>
        <button type="button" onClick={() => void controller.choose(locale)}>{labels.choose}</button>
    </div>;
    const change = async (operation: BranchOperation) => {
        const result = await controller.changeBranch(operation);
        report(result, operation.kind === 'switchBranch' || !!operation.checkout);
        return result;
    };
    const term = query.trim().toLowerCase();
    const matches = term ? history.commits.filter(commit => [commit.message, commit.author, commit.oid, ...commit.refs.map(ref => ref.name)]
        .some(value => value.toLowerCase().includes(term))) : history.commits;
    return <div className="twgit-history-view" ref={root}>
        {term && !history.loading && !matches.length && <p role="status">{history.cursor ? labels.historySearchMore : labels.historyNoMatches}</p>}
        <HistoryGraph commits={matches} flat={Boolean(term)} selected={selected} locale={locale} busy={state.busy} onSelect={oid => {
            setSelected(oid);
            controller.openCommit(locale, repository, oid);
        }}
            hasMore={!!history.cursor} loadingMore={history.loading} onShowMore={showMore} localBranches={state.branches}
            onOpenVersion={controller.openVersion} onRestoreVersion={controller.restoreVersion}
            {...state.writable ? {
                // A refused create stays in the graph's form with its reason; only a done one is told in the snackbar.
                onCreateBranch: async (oid: string, name: string, checkout: boolean) => {
                    const result = await controller.changeBranch({kind: 'createBranch', name, at: oid, checkout});
                    if (result.done) report(result, checkout);
                    return result;
                },
                onSwitchBranch: (name: string) => change({kind: 'switchBranch', name}),
                onCreateFromRemote: (name: string) => change({kind: 'createBranch', name, fromRemote: true, checkout: true})
            } : {}}/>
        {history.loading && !history.commits.length && <p role="status">{labels.historyLoading}</p>}
        {history.failed && <p>{labels.historyFailed}</p>}
        {snackbar}
    </div>;
}

/**
 * Renders the history graph of the repository chosen in the panel mounted for `vm`, for a side panel of the host. It
 * opens the commit's changes in the panel on selection. It follows branch changes made anywhere, offers the graph's
 * branch actions when the panel allows writes and tells their results in the branch button's snackbar. Before a
 * repository is chosen it offers to choose one; it renders nothing while no panel is mounted for `vm`.
 */
export function renderHistoryView(createElement: (component: any, props: any, ...children: any[]) => any,
    {vm, locale = 'en', query = ''}: {vm: object; locale?: string; query?: string}) {
    return createElement(HistoryEntry, {vm, locale, query});
}

/** Reads the baseline of a project-folder file from a repository already accessible to the Editor. */
export async function readProjectHeadFile(vm: object, directory: FileSystemDirectoryHandle, path: string, limit: number) {
    const controller = controllers.get(vm);
    if (!controller) return null;
    const repository = controller.repository;
    if (repository) {
        const scope = await repository.root.resolve(directory);
        if (scope) return repository.readHeadFile([...scope, path].join('/'), limit);
    }
    // The project itself may be the repository root even before a repository is chosen in the Git panel.
    try {
        await directory.getDirectoryHandle('.git');
    } catch (error) {
        if (['NotFoundError', 'TypeMismatchError'].includes((error as DOMException).name)) return null;
        throw error;
    }
    return (await openRepository(directory)).readHeadFile(path, limit);
}

/**
 * Follows the Git status of the files under `directory`, as the panel mounted for `vm` last read it, and calls
 * `listener` with their marks by path relative to `directory`. The marks are empty while no repository is chosen or
 * `directory` is outside it. Returns the function that stops following.
 */
export function followChangeMarks(vm: object, directory: FileSystemDirectoryHandle,
    listener: (marks: ReadonlyMap<string, ChangeMark>) => void) {
    let stopped = false;
    let read: Snapshot | null | undefined;
    let unfollow = () => {};
    const update = async (controller: Controller | undefined) => {
        const {repository, snapshot} = controller ?? {repository: null, snapshot: null};
        if (snapshot === read) return;
        read = snapshot;
        const path = repository && snapshot ? await repository.root.resolve(directory).catch(() => null) : null;
        if (!stopped && read === snapshot) listener(path ? changeMarks(snapshot!.changes, path.join('/')) : new Map());
    };
    const unregister = findController(vm, controller => {
        unfollow();
        unfollow = controller ? controller.follow(() => void update(controller)) : () => {};
        void update(controller);
    });
    return () => {
        stopped = true;
        unregister();
        unfollow();
    };
}

/** Watches the open folder's Git status independently of the visibility of the Git panel. */
export function followFileStatuses(vm: object, directory: FileSystemDirectoryHandle,
    listener: (statuses: ReadonlyMap<string, FileStatus>) => void) {
    let repository: Repository | null | undefined;
    let unfollow = () => {};
    let stopWatching = () => {};
    let generation = 0;
    const follow = async (next: Repository | null | undefined) => {
        if (next === repository) return;
        repository = next;
        const ticket = ++generation;
        stopWatching();
        listener(new Map());
        if (!next) return;
        const path = await next.root.resolve(directory).catch(() => null);
        if (!path || generation !== ticket) return;
        const scope = path.join('/');
        let fingerprint: string | undefined;
        let local: Awaited<ReturnType<Repository['readFileStatus']>> | undefined;
        let merged: MergedFileVersions = new Map();
        let remoteKey = '';
        let remoteRequest: AbortController | undefined;
        let checkAgain = 0;
        const publish = () => {
            if (local) listener(fileStatuses(local.changes, local.committed, local.upstream, merged, scope));
        };
        const checkRemote = () => {
            const name = gitHubRepositoryFromOrigin(local?.remote);
            const {branch, upstreamBranch, pushed} = local ?? {};
            const key = name && branch && upstreamBranch && pushed ? JSON.stringify([name, branch, upstreamBranch, pushed]) : '';
            if (key !== remoteKey) {
                remoteRequest?.abort();
                remoteRequest = undefined;
                remoteKey = key;
                merged = new Map();
                checkAgain = 0;
            }
            if (!name || !upstreamBranch || !pushed || remoteRequest || Date.now() < checkAgain) return;
            const request = new AbortController();
            remoteRequest = request;
            const timeout = setTimeout(() => request.abort(), 10000);
            void createGitHubPullRequests(name).mergedFileVersions(pushed, scope, request.signal, upstreamBranch).then(result => {
                if (!request.signal.aborted) {
                    merged = result;
                    publish();
                }
            }).catch(() => {
                // Keep the local status when GitHub cannot confirm the merge.
            }).finally(() => {
                clearTimeout(timeout);
                if (remoteRequest === request) {
                    remoteRequest = undefined;
                    checkAgain = Date.now() + 120000;
                }
            });
        };
        const stop = watchRepository(document, next.root, async stopped => {
            const probe = await next.probe(scope, true);
            if (stopped() || probe === 'locked') return;
            if (probe === fingerprint) {
                checkRemote();
                return;
            }
            try {
                const status = await next.readFileStatus(scope, probe);
                if (stopped()) return;
                local = status;
                fingerprint = probe;
                checkRemote();
                publish();
            } catch {
                if (stopped()) return;
                local = undefined;
                fingerprint = undefined;
                checkRemote();
                listener(new Map());
            }
        });
        stopWatching = () => {stop(); remoteRequest?.abort();};
    };
    const unregister = findController(vm, controller => {
        unfollow();
        const update = () => void follow(controller?.repository);
        unfollow = controller?.follow(update) ?? (() => {});
        update();
    });
    return () => {
        generation++;
        unregister();
        unfollow();
        stopWatching();
    };
}

/** Gives an explorer write actions only while its directory belongs to the selected writable repository. */
export function followExplorerGit(vm: object, directory: FileSystemDirectoryHandle,
    listener: (actions?: ExplorerGitActions) => void) {
    let ticket = 0;
    let unfollow = () => {};
    const unregister = findController(vm, controller => {
        unfollow();
        let previous: Repository | null | undefined;
        const update = async () => {
            const repository = controller?.branch.writable && controller.branch.branch ? controller.repository : null;
            if (repository === previous) return;
            previous = repository;
            const current = ++ticket;
            listener();
            if (!repository || !controller || !await repository.root.resolve(directory).catch(() => null) || current !== ticket) return;
            listener({
                change: (kind, entry, isCurrent) => controller.changeExplorerEntry(repository, directory, kind, entry,
                    () => current === ticket && isCurrent()),
                refresh: () => current === ticket ? controller.refresh(false, true) : Promise.resolve()
            });
        };
        unfollow = controller?.follow(() => void update()) ?? (() => {});
        void update();
    });
    return () => {
        ticket++;
        unregister();
        unfollow();
    };
}
