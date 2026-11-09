import React, {useEffect, useMemo, useRef, useState} from 'react';
import {render, unmountComponentAtNode} from 'react-dom';
import {FileDiffView} from './file-diff-view.js';
import {openRepository} from './repository.js';
import type {Repository, Snapshot, FileChange, FileDiff, ChangeGroup} from './repository.js';
import {labelsFor} from './messages.js';
import {GitPanelError} from './filesystem.js';
import {ConnectionSettings} from './connection-settings.js';
import type {GitConnectionSettings} from './connection-settings.js';
import type {RemoteOperation} from './remote-operations.js';
import {PullRequestReviewPanel} from './pull-request-panel.js';
import type {ProjectBlockRenderer} from './scratch-block-diff-renderer.js';

export {createScratchBlocksDiffRenderer} from './scratch-block-diff-renderer.js';
export type {ScratchBlockDiffRendererOptions, ScratchBlocksPort} from './scratch-block-diff-renderer.js';

export {openRepository, createReadOnlyFs, GitPanelError} from './repository.js';
export type {Repository, Snapshot, FileChange, FileDiff} from './repository.js';

export interface GitHost {
    connectionSettings?: GitConnectionSettings;
    renderReviewBlock?: ProjectBlockRenderer;
    openProject(directory: FileSystemDirectoryHandle, confirmReplace: () => boolean): Promise<'opened' | 'cancelled'>;
    isProjectDirty(): boolean;
    isProjectRunning?(): boolean;
    subscribe?(listener: (event: 'loaded' | 'changed') => void): () => void;
}
interface Controller {open(locale: string): void; refresh(): Promise<void>}
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

function GitPanel({document, host, controller}: {document: Document; host: GitHost; controller: Controller}) {
    const [visible, setVisible] = useState(false);
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
    const labels = labelsFor(locale);
    const run = async (operation: () => Promise<Partial<State>>) => {
        if (running.current || !alive.current) return;
        running.current = true;
        const ticket = ++epoch.current;
        setState(previous => ({...previous, busy: true, error: null, notice: undefined}));
        try {
            const update = await operation();
            if (epoch.current === ticket) setState(previous => ({...previous, ...update, busy: false}));
        } catch (error) {
            if (epoch.current !== ticket) return;
            const code = error instanceof GitPanelError ? error.code : 'failed';
            const message = labels[code as keyof typeof labels] || labels.failed;
            setState(previous => ({...previous, error: message, busy: false, diff: null}));
        } finally {
            running.current = false;
            if (refreshPending.current) {
                refreshPending.current = false;
                queueMicrotask(() => void controller.refresh());
            }
        }
    };
    controller.open = language => {setLocale(language); setVisible(true);};
    controller.refresh = async () => {
        if (!alive.current || !current.current.repository) return;
        if (running.current) {refreshPending.current = true; return;}
        await run(async () => {
            const {repository, project} = current.current;
            const snapshot = await repository!.read(project ?? '');
            return {snapshot, changes: snapshot.changes, selected: null, diff: null, commit: null};
        });
    };
    useEffect(() => {
        alive.current = true;
        const unsubscribe = host.subscribe?.(event => {
            setDirty(host.isProjectDirty());
            if (event === 'loaded' && !opening.current) {
                epoch.current++;
                setState(previous => ({...previous, project: null, snapshot: null, changes: [],
                    selected: null, diff: null, commit: null, busy: false}));
                queueMicrotask(() => void controller.refresh());
            }
        });
        return () => {alive.current = false; epoch.current++; remoteRequest.current?.abort(); unsubscribe?.();};
    }, [host]);
    useEffect(() => {
        if (!visible) return;
        const previous = document.activeElement as HTMLElement | null;
        dialog.current?.focus();
        return () => {if (previous?.isConnected) previous.focus();};
    }, [visible]);
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
        if (!alive.current) return {};
        setDirty(host.isProjectDirty());
        setState(previous => ({...previous, project: path, snapshot: null, changes: [], selected: null, diff: null, commit: null}));
        const snapshot = await state.repository!.read(path);
        return {project: path, snapshot, changes: snapshot.changes, selected: null, diff: null, commit: null};
    });
    const selectFile = (selected: FileChange) => run(async () => ({selected,
        diff: await state.repository!.readDiff(state.snapshot!, selected)}));
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
    const focusTrap = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {event.stopPropagation(); setVisible(false); return;}
        if (event.key !== 'Tab') return;
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]')]
            .filter(item => item.getClientRects().length > 0);
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
            event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
    };
    // One loader per selected change, so thumbnails read each asset once.
    const loadAsset = useMemo(() => state.repository && state.snapshot && state.selected ?
        state.repository.assetLoader(state.snapshot, state.selected) : undefined, [state.repository, state.snapshot, state.selected]);
    if (!visible) return null;
    const groups: ChangeGroup[] = state.commit ? ['commit'] : ['staged', 'unstaged', 'untracked'];
    return <div className="twgit-backdrop">
        <div className="twgit-panel" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={labels.title}
            onKeyDown={focusTrap}>
            <header>
                <h2>{labels.title}</h2>
                <button onClick={chooseRoot} disabled={state.busy}>{labels.choose}</button>
                {!review && <button onClick={() => void controller.refresh()} disabled={!state.repository || state.busy}>{labels.refresh}</button>}
                {!review && state.project !== null && <button disabled={state.busy} onClick={() => void openProject(state.project!)}>{labels.reload}</button>}
                {state.repository && host.renderReviewBlock && <button type="button" disabled={state.busy}
                    onClick={() => setReview(!review)}>{review ? labels.localChanges : labels.pullRequests}</button>}
                <button onClick={() => setVisible(false)}>{labels.close}</button>
            </header>
            <div className="twgit-context">
                <span>{labels.repository} · {state.repository?.root.name || '—'}</span>
                <span>{labels.project} · {state.project === null ? labels.none : state.project || labels.root}</span>
                <strong>{state.snapshot?.branch || (state.snapshot?.head ? labels.detached : labels.unborn)}</strong>
                <code>{state.snapshot?.head?.slice(0, 12)}</code>
                <span data-git-dirty="">{dirty ? labels.dirty : labels.saved}</span>
            </div>
            {!review && host.connectionSettings && <ConnectionSettings settings={host.connectionSettings} locale={locale}
                runOperation={host.connectionSettings.getSession ? remoteOperation : undefined}
                readOrigin={state.repository && !state.busy ? async () => {
                    const ticket = epoch.current;
                    const remote = await state.repository!.readOrigin();
                    return epoch.current === ticket ? remote : undefined;
                } : undefined}/>}
            {state.error && <p className="twgit-error" role="alert">{state.error}</p>}
            {state.notice && <p className="twgit-context" role="status">{state.notice}</p>}
            {state.busy && <p role="status">{labels.loading}</p>}
            {!state.repository && <p>{labels.empty}</p>}
            {review && state.repository && host.renderReviewBlock &&
                <PullRequestReviewPanel repository={state.repository} locale={locale} renderBlock={host.renderReviewBlock}/>}
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
                    {groups.map(group => <section key={group}>
                        <h3>{labels[group]} · {state.changes.filter(change => change.group === group).length}</h3>
                        <ul>{state.changes.filter(change => change.group === group).map(change => <li key={change.path}>
                            <button className="twgit-file" data-git-group={group} disabled={state.busy}
                                aria-pressed={state.selected === change} onClick={() => void selectFile(change)}>
                                <span>{!change.after ? 'D' : !change.before ? 'A' : 'M'}</span> {change.path}
                            </button>
                        </li>)}</ul>
                    </section>)}
                    {!state.changes.length && <p>{labels.clean}</p>}
                    <details><summary>{labels.branches}</summary><ul>{state.snapshot?.branches.map(branch => <li key={branch}>{branch}</li>)}</ul></details>
                    <h3>{labels.history}</h3>
                    <ol className="twgit-history">{state.snapshot?.commits.map(commit => <li key={commit.oid}>
                        <button disabled={state.busy} aria-pressed={state.commit === commit.oid} title={commit.oid}
                            onClick={() => void selectCommit(commit.oid)}>{commit.message.split('\n')[0]}</button>
                        <small><code>{commit.oid.slice(0, 8)}</code> · {commit.author} · {new Date(commit.timestamp * 1000).toLocaleString(locale)}</small>
                    </li>)}</ol>
                </aside>
                <main className="twgit-diff">
                    {state.selected ? <FileDiffView change={state.selected} diff={state.diff} labels={labels} locale={locale}
                        renderBlock={host.renderReviewBlock} loadAsset={loadAsset}/> : <p>{labels.select}</p>}
                </main>
            </div>}
            <footer>{labels.permissions}</footer>
        </div>
    </div>;
}

export function mountGitPanel({vm, document, host}: {vm: object; document: Document; host: GitHost}) {
    if (!(document.defaultView as PickerWindow)?.showDirectoryPicker) return null;
    const root = document.createElement('div');
    document.body.append(root);
    const controller: Controller = {open() {}, async refresh() {}};
    controllers.set(vm, controller);
    render(<GitPanel document={document} host={host} controller={controller}/>, root);
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
