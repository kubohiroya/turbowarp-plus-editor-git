import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createPortal, render, unmountComponentAtNode} from 'react-dom';
import {CloseButton} from './close-button.js';
import {FileDiffView} from './file-diff-view.js';
import {findElement, ProjectChangeListView, ProjectElementView, projectChangeLabels, useProjectChanges} from './project-change-list.js';
import type {ChangedFile} from './project-change-model.js';
import {openRepository} from './repository.js';
import type {Repository, Snapshot, FileChange, FileDiff, ChangeGroup, HistoryCommit, HistoryCursor} from './repository.js';
import {HistoryGraph} from './history-graph-view.js';
import type {HistoryActionResult} from './history-graph-view.js';
import {labelsFor} from './messages.js';
import {GitPanelError} from './filesystem.js';
import {ConnectionSettings} from './connection-settings.js';
import type {GitConnectionSettings} from './connection-settings.js';
import type {RemoteOperation} from './remote-operations.js';
import type {GitAuthor, LocalOperation} from './local-operations.js';
import {PullRequestReviewPanel} from './pull-request-panel.js';
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
export type {PullRequestBase, PullRequestFetch, PullRequestFiles, Repository, Snapshot, FileChange, FileDiff, HistoryCommit, HistoryCursor, HistoryPage, HistoryRef} from './repository.js';
export {HistoryGraph, laneColors} from './history-graph-view.js';
export type {HistoryActionResult, HistoryGraphProps} from './history-graph-view.js';
export {layoutHistory} from './history-graph.js';
export type {GraphCommit, GraphLayout, GraphRow, GraphSegment} from './history-graph.js';
export type {GitAuthor, LocalOperation} from './local-operations.js';

export interface GitHost {
    connectionSettings?: GitConnectionSettings;
    renderReviewBlock?: ProjectBlockRenderer;
    openProject(directory: FileSystemDirectoryHandle, confirmReplace: () => boolean): Promise<'opened' | 'cancelled'>;
    isProjectDirty(): boolean;
    isProjectRunning?(): boolean;
    subscribe?(listener: (event: 'loaded' | 'changed') => void): () => void;
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
interface Controller {open(locale: string): void; refresh(automatic?: boolean): Promise<void>}
interface State {
    repository: Repository | null;
    snapshot: Snapshot | null;
    project: string | null;
    browser: {path: string; children: string[]; isProject: boolean} | null;
    changes: FileChange[];
    selected: FileChange | null;
    diff: FileDiff | null;
    commit: string | null;
    error: string | null;
    notice?: string;
    busy: boolean;
}
const initial: State = {repository: null, snapshot: null, project: null, browser: null,
    changes: [], selected: null, diff: null, commit: null, error: null, busy: false};
const controllers = new WeakMap<object, Controller>();
type PickerWindow = Window & {showDirectoryPicker?: (options: {id: string; mode: 'readwrite'}) => Promise<FileSystemDirectoryHandle>};
type ObserverWindow = Window & {FileSystemObserver?: new (callback: () => void) => {
    observe(handle: FileSystemDirectoryHandle, options: {recursive: boolean}): Promise<void>;
    disconnect(): void;
}};
const watchInterval = 2000;

function GitPanel({vm, document, host, controller}: {vm: object; document: Document; host: GitHost; controller: Controller}) {
    const [visible, setVisible] = useState(false);
    // A layout tab that holds the panel. The panel component stays mounted, so the repository survives closing the tab.
    const [slot, setSlot] = useState<{element: HTMLElement; close(): void} | null>(null);
    const shown = visible || slot !== null;
    // Only a tab leaves the Editor visible, so only a tab offers to point at blocks in it.
    const locator = useMemo(() => slot && host.openTargetCode && host.getWorkspace ? createEditorBlockLocator({
        vm: vm as LocatorVM, openTargetCode: host.openTargetCode, getWorkspace: host.getWorkspace}) : undefined, [slot !== null, host, vm]);
    const [review, setReview] = useState(false);
    const [locale, setLocale] = useState(document.documentElement.lang || 'en');
    const [dirty, setDirty] = useState(host.isProjectDirty());
    const [state, setState] = useState<State>(initial);
    const current = useRef(state);
    current.current = state;
    const epoch = useRef(0);
    const running = useRef(false);
    const refreshPending = useRef(false);
    const remoteRequest = useRef<AbortController>();
    const alive = useRef(true);
    const opening = useRef(false);
    const dialog = useRef<HTMLDivElement>(null);
    // A closed panel reads nothing; a refresh asked while it is closed waits until it opens again.
    const shownRef = useRef(false);
    const deferred = useRef(false);
    const reviewing = useRef(review);
    reviewing.current = review;
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
            const message = labels[code as keyof typeof labels] || labels.failed;
            setState(previous => ({...previous, error: automatic && previous.error ? previous.error : message,
                busy: automatic ? previous.busy : false, diff: null}));
            return {done: false, error: message};
        } finally {
            running.current = false;
            // A result dropped by a newer load still ends the busy state, unless a refresh follows at once.
            if (epoch.current !== ticket && !refreshPending.current && alive.current) {
                setState(previous => ({...previous, busy: false}));
            }
            if (automatic) {background.current = null; settle();}
            if (refreshPending.current) {
                refreshPending.current = false;
                queueMicrotask(() => void controller.refresh());
            }
        }
    };
    controller.open = language => {
        setLocale(language);
        const opened = host.openPanel?.({reference: {providerId: 'turbowarp-plus-git', documentId: 'local-git'},
            filename: 'Git', title: labelsFor(language).title, transient: true,
            mount(element, close) {
                setVisible(false);
                setSlot({element, close});
                return {requestClose: close, dispose() {setSlot(previous => previous?.element === element ? null : previous);}};
            }});
        if (!opened) setVisible(true);
    };
    const closePanel = () => {
        if (slot) slot.close();
        else setVisible(false);
    };
    controller.refresh = async (automatic = false) => {
        if (!alive.current || !current.current.repository) return;
        if (!shownRef.current) {
            deferred.current = true;
            return;
        }
        if (running.current) {
            if (!automatic) refreshPending.current = true;
            return;
        }
        await run(async () => {
            const {repository, project} = current.current;
            // A save or a Git command may still be finishing its writes; read again briefly before reporting a change.
            for (let attempt = 1; ; attempt++) {
                try {
                    const snapshot = await repository!.read(project ?? '');
                    return {snapshot, changes: snapshot.changes, selected: null, diff: null, commit: null};
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
            setDirty(host.isProjectDirty());
            if (event === 'loaded' && !opening.current) {
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
    // While the panel is open, notice Git commands, agents and editors that change the repository outside the Editor.
    useEffect(() => {
        const repository = state.repository;
        if (!shown || !repository) return;
        const view = document.defaultView as ObserverWindow;
        let stopped = false;
        let checking = false;
        const check = async () => {
            const {snapshot} = current.current;
            // A tab behind another one has no boxes; it reads again when it is shown.
            const hidden = !dialog.current || !dialog.current.getClientRects().length;
            if (stopped || checking || running.current || document.visibilityState === 'hidden' || hidden ||
                !snapshot || current.current.repository !== repository) return;
            checking = true;
            try {
                const probe = await repository.probe(snapshot.scope);
                if (stopped || probe === 'locked' || probe === snapshot.probe || probe === handled.current ||
                    current.current.snapshot !== snapshot) return;
                handled.current = probe;
                const {selected, commit} = current.current;
                // Keep an open diff, commit or review in place and ask for a refresh instead.
                if (selected || commit || reviewing.current) {
                    setState(previous => previous.snapshot === snapshot ? {...previous, notice: labelsFor(locale).outdated} : previous);
                } else await controller.refresh(true);
            } catch {
                // Entries can disappear while another tool writes. The next check reads them again.
            } finally {
                checking = false;
            }
        };
        let soon: number | undefined;
        const schedule = () => {view.clearTimeout(soon); soon = view.setTimeout(() => void check(), 300);};
        const interval = view.setInterval(() => void check(), watchInterval);
        const onFocus = () => void check();
        view.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onFocus);
        let observer: InstanceType<NonNullable<ObserverWindow['FileSystemObserver']>> | null = null;
        try {
            if (view.FileSystemObserver) {
                observer = new view.FileSystemObserver(schedule);
                observer.observe(repository.root, {recursive: true}).catch(() => {});
            }
        } catch {
            observer = null;
        }
        void check();
        return () => {
            stopped = true;
            view.clearInterval(interval);
            view.clearTimeout(soon);
            view.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onFocus);
            observer?.disconnect();
        };
    }, [shown, state.repository, locale]);
    useEffect(() => {
        if (!visible || slot) return;
        const previous = document.activeElement as HTMLElement | null;
        dialog.current?.focus();
        return () => {if (previous?.isConnected) previous.focus();};
    }, [visible, slot]);
    const chooseRoot = async () => {
        const view = document.defaultView as PickerWindow;
        await run(async () => {
            let root: FileSystemDirectoryHandle;
            try {root = await view.showDirectoryPicker!({id: 'turbowarp-plus-git-root', mode: 'readwrite'});} catch (error) {
                if ((error as DOMException).name === 'AbortError') return {};
                throw error;
            }
            const repository = await openRepository(root);
            const snapshot = await repository.read();
            const browser = await repository.browse();
            await host.connectionSettings?.disconnect();
            setReview(false);
            return {...initial, repository, snapshot, browser, changes: snapshot.changes};
        });
    };
    const browse = (path: string) => run(async () => ({browser: await state.repository!.browse(path)}));
    const openProject = (path: string) => run(async () => {
        const directory = await state.repository!.openProject(path);
        opening.current = true;
        try {
            const result = await host.openProject(directory, () => document.defaultView!.confirm(labels.replace));
            if (result === 'cancelled') return {};
        } finally {opening.current = false;}
        // Loading the project brings its code to the front; keep the panel the person is working in in front of it.
        if (slot) controller.open(locale);
        if (!alive.current) return {};
        setDirty(host.isProjectDirty());
        setState(previous => ({...previous, project: path, snapshot: null, changes: [], selected: null, diff: null, commit: null}));
        const snapshot = await state.repository!.read(path);
        return {project: path, snapshot, changes: snapshot.changes, selected: null, diff: null, commit: null};
    });
    const selectFile = (selected: FileChange) => run(async () => ({selected,
        diff: await state.repository!.readDiff(state.snapshot!, selected)}));
    // A selected stage or sprite element replaces the file diff; picking a file goes back to it.
    const [element, setElement] = useState<string | null>(null);
    const [fileListOpen, setFileListOpen] = useState(false);
    const projectChanges = useProjectChanges(state.repository, state.snapshot, state.project, state.commit, state.changes);
    const openFile = (file: ChangedFile | FileChange) => {
        const change = state.changes.find(item => item.path === file.path && item.group === file.group);
        if (!change) return;
        setElement(null);
        void selectFile(change);
    };
    const openElement = (key: string) => {
        setElement(key);
        setState(previous => ({...previous, selected: null, diff: null}));
    };
    const selectCommit = (commit: string) => run(async () => ({commit,
        changes: await state.repository!.historyChanges(state.snapshot!, commit), selected: null, diff: null}));
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
    // A connected GitHub connection reads pull request contents over Git Smart HTTP, so private repositories work too.
    const pullRequestConnection = useMemo(() => {
        const settings = host.connectionSettings;
        const getSession = settings?.getSession;
        return getSession ? {getSession, connected: () => settings.getView().state.status === 'connected'} : undefined;
    }, [host]);
    const [message, setMessage] = useState('');
    const localOperation = (operation: LocalOperation, notice?: string) => {
        const repository = current.current.repository;
        if (!repository || !host.localWrite) return Promise.resolve<HistoryActionResult>({done: false});
        return run(async () => {
            const ticket = epoch.current;
            await repository.localOperation(operation, () => {
                if (epoch.current !== ticket) throw new GitPanelError('changed');
                // Staging records the saved files; edits still in the Editor would be left out without a word.
                if (operation.kind === 'stage' && host.isProjectDirty()) throw new GitPanelError('saveFirst');
                // Switching replaces the files the Editor opened, like pull.
                if ((operation.kind === 'switchBranch' || (operation.kind === 'createBranch' && operation.checkout)) &&
                    (host.isProjectDirty() || host.isProjectRunning?.())) throw new GitPanelError('switchUnsafe');
            });
            if (operation.kind === 'commit') setMessage('');
            const snapshot = await repository.read(current.current.project ?? '');
            return {snapshot, changes: snapshot.changes, selected: null, diff: null, commit: null, notice};
        });
    };
    const [newBranch, setNewBranch] = useState('');
    const [switchAfterCreate, setSwitchAfterCreate] = useState(true);
    const changeBranch = async (operation: Extract<LocalOperation, {kind: 'createBranch' | 'switchBranch'}>): Promise<HistoryActionResult> => {
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
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]')]
            .filter(item => item.getClientRects().length > 0);
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
            event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
    };
    // One loader per selected change, so thumbnails read each asset once.
    const loadAsset = useMemo(() => state.repository && state.snapshot && state.selected ?
        state.repository.assetLoader(state.snapshot, state.selected) : undefined, [state.repository, state.snapshot, state.selected]);
    if (!shown) return null;
    const groups: ChangeGroup[] = state.commit ? ['commit'] : ['staged', 'unstaged', 'untracked'];
    // Branches can be switched and created whenever writes are allowed and the repository has been read.
    const branching = !!host.localWrite && !!state.snapshot;
    // Writing works on the current changes, not on a record from the history, and only on a branch.
    const writable = !!host.localWrite && !state.commit && !!state.snapshot?.branch;
    const unrecorded = [...new Set(state.changes.filter(change => change.group === 'unstaged' || change.group === 'untracked')
        .map(change => change.path))];
    const staged = state.changes.some(change => change.group === 'staged');
    const projectList = typeof projectChanges === 'object' ? projectChanges : null;
    // The open project matches the working tree, so only the working-tree side of its project file can be located.
    const projectFile = state.project === null ? null : [state.project, 'project.source.json'].filter(Boolean).join('/');
    const fileLocator = (change: FileChange) => locator && change.path === projectFile &&
        (change.group === 'unstaged' || change.group === 'untracked' ||
            (change.group === 'staged' && !state.changes.some(item => item.path === change.path && item.group === 'unstaged'))) ?
        locator : undefined;
    const reviewLocator = (path: string, headSha: string) => locator && path === projectFile && state.snapshot?.head === headSha &&
        !state.changes.length ? locator : undefined;
    const selection = projectList && !state.selected ? findElement(projectList.list, element) : null;
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
        openTabs(`${state.commit ?? change.group}:${change.path}`, files);
    });
    const content = <>
            <header>
                <h2>{labels.title}</h2>
                <button onClick={chooseRoot} disabled={state.busy}>{labels.choose}</button>
                {!review && <button onClick={() => void controller.refresh()} disabled={!state.repository || state.busy}>{labels.refresh}</button>}
                {!review && state.project !== null && <button disabled={state.busy} onClick={() => void openProject(state.project!)}>{labels.reload}</button>}
                {state.repository && host.renderReviewBlock && <button type="button" disabled={state.busy}
                    onClick={() => setReview(!review)}>{review ? labels.localChanges : labels.pullRequests}</button>}
                <CloseButton label={labels.close} onClick={closePanel}/>
            </header>
            <div className="twgit-context">
                <span>{labels.repository} · {state.repository?.root.name || '—'}</span>
                <span>{labels.project} · {state.project === null ? labels.none : state.project || labels.root}</span>
                <span data-git-dirty="">{dirty ? labels.dirty : labels.saved}</span>
                {state.snapshot && <span data-git-upstream={state.snapshot.upstream.state} title={labels.checkedAt}>{upstreamText(state.snapshot, labels)}</span>}
                {!review && host.connectionSettings && <ConnectionSettings settings={host.connectionSettings} locale={locale}
                    runOperation={host.connectionSettings.getSession ? remoteOperation : undefined}
                    readOrigin={state.repository && !state.busy ? async () => {
                        const ticket = epoch.current;
                        const remote = await state.repository!.readOrigin();
                        return epoch.current === ticket ? remote : undefined;
                    } : undefined}/>}
                {state.snapshot && <details className="twgit-git-details">
                    <summary>{labels.details}</summary>
                    <div className="twgit-connection-body">
                        <p>{labels.branch} · <strong>{state.snapshot.branch || (state.snapshot.head ? labels.detached : labels.unborn)}</strong></p>
                        <p>{labels.head} · <code>{state.snapshot.head?.slice(0, 12) ?? '—'}</code></p>
                        <p>{labels.branches} · {state.snapshot.branches.join(', ') || '—'}</p>
                        <p>{labels.groups} · {labels.gitStaged} = {labels.staged} / {labels.gitUnstaged} = {labels.unstaged} / {labels.gitUntracked} = {labels.untracked}</p>
                        <p>{labels.permissions}</p>
                    </div>
                </details>}
            </div>
            {state.error && <p className="twgit-error" role="alert">{state.error}</p>}
            {state.notice && <p className="twgit-context" role="status">{state.notice}</p>}
            {state.busy && <p role="status">{labels.loading}</p>}
            {!state.repository && <p>{labels.empty}</p>}
            {review && state.repository && host.renderReviewBlock &&
                <PullRequestReviewPanel repository={state.repository} locale={locale} renderBlock={host.renderReviewBlock}
                    locateFor={reviewLocator} openTabs={openTabs} connection={pullRequestConnection}/>}
            {!review && state.repository && <div className="twgit-content">
                <aside>
                    {state.browser && <details>
                        <summary>{labels.browse}</summary>
                        <p><code>{state.browser.path || '/'}</code></p>
                        <button disabled={state.busy || !state.browser.path} onClick={() => void browse(state.browser!.path.split('/').slice(0, -1).join('/'))}>{labels.up}</button>
                        <button data-git-open-project="" disabled={state.busy || !state.browser.isProject} onClick={() => void openProject(state.browser!.path)}>{labels.open}</button>
                        <ul>{state.browser.children.map(name => <li key={name}><button disabled={state.busy}
                            onClick={() => void browse([state.browser!.path, name].filter(Boolean).join('/'))}>{name}/</button></li>)}</ul>
                    </details>}
                    <h3><button disabled={state.busy} onClick={() => void controller.refresh()}>{labels.worktree}</button></h3>
                    {projectChanges === 'loading' && <p role="status">{projectChangeLabels(locale).loading}</p>}
                    {projectChanges === 'unreadable' && <p>{projectChangeLabels(locale).unreadable}</p>}
                    {(() => {
                        const fileList = groups.map(group => <section key={group}>
                            <h3>{labels[group]} · {state.changes.filter(change => change.group === group).length}</h3>
                            <ul>{state.changes.filter(change => change.group === group).map(change => <li key={change.path}
                                className={writable ? 'twgit-file-row' : undefined}>
                                <button className="twgit-file" data-git-group={group} disabled={state.busy}
                                    aria-pressed={state.selected === change} onClick={() => openFile(change)}>
                                    <small className="twgit-change-kind">{!change.after ? labels.deleted : !change.before ? labels.added : labels.modified}</small> {change.path}
                                </button>
                                {writable && <button type="button" className="twgit-stage" disabled={state.busy}
                                    aria-label={`${group === 'staged' ? labels.unstage : labels.stage}: ${change.path}`}
                                    onClick={() => void localOperation({kind: group === 'staged' ? 'unstage' : 'stage', paths: [change.path]})}>
                                    {group === 'staged' ? labels.unstage : labels.stage}</button>}
                            </li>)}</ul>
                        </section>);
                        return projectList ? <ProjectChangeListView changes={projectList} selected={selection ? element : null}
                            locale={locale} busy={state.busy} onSelect={openElement} onSelectFile={openFile} fileList={fileList}
                            fileListOpen={fileListOpen} setFileListOpen={setFileListOpen}/> : fileList;
                    })()}
                    {!state.changes.length && <p>{labels.clean}</p>}
                    {writable && <section className="twgit-commit" aria-label={labels.commitButton}>
                        <button type="button" disabled={state.busy || !unrecorded.length}
                            onClick={() => void localOperation({kind: 'stage', paths: unrecorded})}>{labels.stageAll}</button>
                        <label>{labels.commitLabel}
                            <textarea value={message} rows={3} disabled={state.busy} onChange={event => setMessage(event.currentTarget.value)}/></label>
                        <button type="button" disabled={state.busy || !staged || !message.trim()}
                            onClick={() => void localOperation({kind: 'commit', message, author: host.localWrite?.author?.()},
                                labels.committed)}>{labels.commitButton}</button>
                    </section>}
                    {branching && state.snapshot && <section className="twgit-branches" aria-label={labels.branches}>
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
                    <h3>{labels.history}</h3>
                    {state.snapshot && <HistoryGraph commits={history.commits} selected={state.commit} locale={locale} busy={state.busy}
                        onSelect={oid => void selectCommit(oid)} hasMore={!!history.cursor} loadingMore={history.loading}
                        onShowMore={showMoreHistory} localBranches={state.snapshot.branches}
                        {...branching ? {
                            onCreateBranch: (oid: string, name: string, checkout: boolean) =>
                                changeBranch({kind: 'createBranch', name, at: oid, checkout}),
                            onSwitchBranch: (name: string) => changeBranch({kind: 'switchBranch', name}),
                            onCreateFromRemote: (name: string) => changeBranch({kind: 'createBranch', name, fromRemote: true, checkout: true})
                        } : {}}/>}
                    {history.loading && !history.commits.length && <p>{labels.historyLoading}</p>}
                    {history.failed && <p>{labels.historyFailed}</p>}
                </aside>
                <main className="twgit-diff">
                    {selection && projectList ? <ProjectElementView changes={projectList} selection={selection} locale={locale}
                        locateBlock={state.commit ? undefined : locator}
                        renderBlock={host.renderReviewBlock} onSelectFile={openFile}/> :
                        state.selected ? <FileDiffView change={state.selected} diff={state.diff} labels={labels} locale={locale}
                            locateBlock={fileLocator(state.selected)} onOpenTabs={openFileTabs(state.selected)}
                            renderBlock={host.renderReviewBlock} loadAsset={loadAsset}/> : <p>{labels.select}</p>}
                </main>
            </div>}
    </>;
    // In a tab the Editor stays usable beside the panel, so there is no backdrop, focus trap or Escape to close.
    if (slot) return createPortal(<div className="twgit-panel twgit-panel-tab" ref={dialog} role="region" aria-label={labels.title}>{content}</div>,
        slot.element);
    return <div className="twgit-backdrop">
        <div className="twgit-panel" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={labels.title}
            onKeyDown={focusTrap}>{content}</div>
    </div>;
}

/** The GitHub relation in plain words, with the number of records where it helps. */
function upstreamText({upstream}: Snapshot, labels: ReturnType<typeof labelsFor>) {
    switch (upstream.state) {
    case 'same': return labels.upstreamSame;
    case 'ahead': return `${labels.upstreamAhead} · ${upstream.ahead} ${labels.records}`;
    case 'behind': return `${labels.upstreamBehind} · ${upstream.behind} ${labels.records}`;
    case 'diverged': return `${labels.upstreamDiverged} · +${upstream.ahead} / −${upstream.behind}`;
    default: return labels.upstreamUnknown;
    }
}

export function mountGitPanel({vm, document, host}: {vm: object; document: Document; host: GitHost}) {
    if (!(document.defaultView as PickerWindow)?.showDirectoryPicker) return null;
    const root = document.createElement('div');
    document.body.append(root);
    const controller: Controller = {open() {}, async refresh() {}};
    controllers.set(vm, controller);
    render(<GitPanel vm={vm} document={document} host={host} controller={controller}/>, root);
    return {refresh: () => controller.refresh(), dispose() {
        if (controllers.get(vm) === controller) controllers.delete(vm);
        void host.connectionSettings?.disconnect().catch(() => {});
        unmountComponentAtNode(root);
        root.remove();
    }};
}

export function renderGitMenu(createElement: (component: any, props: any, ...children: any[]) => any,
    {vm, locale = 'en', MenuItem, MenuSection, onRequestClose}: {
        vm: object; locale?: string; MenuItem: any; MenuSection: any; onRequestClose(): void;
    }) {
    const controller = controllers.get(vm);
    if (!controller) return null;
    return createElement(MenuSection, null, createElement(MenuItem, {
        command: 'local-git', onClick() {onRequestClose(); controller.open(locale);}
    }, labelsFor(locale).menu));
}
