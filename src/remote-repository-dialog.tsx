import React, {useEffect, useRef, useState} from 'react';
import {render, unmountComponentAtNode} from 'react-dom';
import type {GitProgressEvent} from 'isomorphic-git';
import {CloseButton} from './close-button.js';
import {preferredMode} from './connection-settings.js';
import type {GitConnectionSettings} from './connection-settings.js';
import {remoteRepositoryLabelsFor} from './messages.js';
import type {RemoteRepositoryLabels} from './messages.js';
import {PanelIcon} from './panel-navigation.js';
import {cloneRemoteProject, writeClonedProject} from './remote-clone.js';
import type {ClonedProject} from './remote-clone.js';
import {remoteUrl} from './smart-http.js';

export {cloneRemoteProject, writeClonedProject, readProjectRemote, PROJECT_ROOT_FILES} from './remote-clone.js';
export type {
    ClonedProject, CloneFailureReason, CloneRemoteProjectOptions, CloneRemoteProjectResult
} from './remote-clone.js';

export interface RemoteRepositoryDialogOptions {
    document: Document;
    locale: string;
    /** Prefills an existing catalog entry; authorization still happens when the person starts opening it. */
    initialRemote?: string;
    /** The host's GitHub connection; it needs `getSession`. */
    connectionSettings: GitConnectionSettings;
    /** `false` when the browser cannot pick folders on the device (Safari, Firefox). */
    deviceFolders?: boolean;
    /** Picks a folder on the device, during the click that calls it. Resolves an empty folder, or `null` when cancelled. */
    pickDeviceFolder?(): Promise<FileSystemDirectoryHandle | null>;
    /** Creates a new, empty folder in the browser's storage, named after the repository. */
    createBrowserFolder?(name: string): Promise<FileSystemDirectoryHandle>;
    /** Removes a folder made by `createBrowserFolder` when saving into it failed. */
    removeBrowserFolder?(folder: FileSystemDirectoryHandle): Promise<void>;
    /** Opens the saved repository's root as the project folder. */
    openProject(root: FileSystemDirectoryHandle): Promise<unknown>;
}

type Destination = 'device' | 'browser';
type Step = 'form' | 'connecting' | 'cloning' | 'choosing' | 'writing' | 'opening';
type Popup = {replace(url: string): void; closed(): boolean; close(): void};

const pollInterval = 1500;
const authorizationLifetime = 10 * 60_000;

class DialogError extends Error {
    constructor(readonly key: keyof RemoteRepositoryLabels, readonly path = '') {
        super(key);
    }
}

// Opened during the click, before anything is awaited, so popup blockers allow it; navigated once the URL is known.
function reserveWindow(view: Window): Popup | null {
    const popup = view.open('about:blank', '_blank');
    if (!popup) return null;
    popup.opener = null;
    return {
        replace(url) {if (!popup.closed) popup.location.replace(url);},
        closed: () => popup.closed,
        close() {if (!popup.closed) popup.close();}
    };
}

function delay(view: Window, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const stop = () => {view.clearTimeout(timer); reject(signal.reason);};
        const timer = view.setTimeout(() => {signal.removeEventListener('abort', stop); resolve();}, pollInterval);
        signal.addEventListener('abort', stop, {once: true});
        if (signal.aborted) stop();
    });
}

function RemoteRepositoryDialog({view, options, onDone}: {
    view: Window; options: RemoteRepositoryDialogOptions; onDone(opened: boolean): void;
}) {
    const {locale, connectionSettings: settings, pickDeviceFolder, createBrowserFolder, removeBrowserFolder, openProject} = options;
    const labels = remoteRepositoryLabelsFor(locale);
    const deviceAvailable = options.deviceFolders !== false && !!pickDeviceFolder;
    const dialog = useRef<HTMLDialogElement>(null);
    const alert = useRef<HTMLDialogElement>(null);
    const alive = useRef(true);
    const abort = useRef<AbortController | null>(null);
    const snapshot = useRef<ClonedProject | null>(null);
    const result = useRef(false);
    const [url, setUrl] = useState(options.initialRemote ?? '');
    const [invalid, setInvalid] = useState(false);
    const [destination, setDestination] = useState<Destination>(deviceAvailable || !createBrowserFolder ? 'device' : 'browser');
    const [step, setStepState] = useState<Step>('form');
    const [authorization, setAuthorizationState] = useState<{url: string; userCode?: string} | null>(null);
    const [blocked, setBlockedState] = useState(false);
    const [progress, setProgressState] = useState<GitProgressEvent | null>(null);
    const [error, setErrorState] = useState<string | null>(null);
    const [notProject, setNotProjectState] = useState(false);
    // The work goes on after awaits; nothing is drawn once the dialog has closed.
    const guarded = <T, >(set: (value: T) => void) => (value: T) => {if (alive.current) set(value);};
    const setStep = guarded(setStepState);
    const setAuthorization = guarded(setAuthorizationState);
    const setBlocked = guarded(setBlockedState);
    const setProgress = guarded(setProgressState);
    const setError = guarded(setErrorState);
    const setNotProject = guarded(setNotProjectState);

    useEffect(() => {
        dialog.current?.showModal();
        return () => {
            alive.current = false;
            abort.current?.abort();
        };
    }, []);
    useEffect(() => {
        if (notProject) alert.current?.showModal();
    }, [notProject]);

    const close = (opened = false) => {
        result.current = opened;
        abort.current?.abort();
        dialog.current?.close();
    };
    const message = (failure: unknown) => {
        if (failure instanceof DialogError) return labels[failure.key].replace('{path}', failure.path);
        return labels.failed;
    };

    async function authorize(remote: string, mode: 'desktop' | 'cloudflare', popup: Popup | null, signal: AbortSignal) {
        const getSession = settings.getSession!;
        let started = false;
        try {
            if (await getSession(remote, false)) return;
            signal.throwIfAborted();
            if (settings.getView().mode !== mode) await settings.select(mode);
            if (settings.getView().state.status === 'connecting') await settings.disconnect();
            signal.throwIfAborted();
            started = true;
            try {
                await settings.connect(remote, false);
            } catch {
                throw new DialogError('authFailed');
            }
            const link = settings.getView().authorization;
            if (link) {
                setAuthorization(link);
                popup?.replace(link.url);
            } else {
                popup?.close();
            }
            const deadline = Date.now() + authorizationLifetime;
            let closedOnce = false;
            for (;;) {
                signal.throwIfAborted();
                await settings.refresh();
                signal.throwIfAborted();
                const {state} = settings.getView();
                if (state.status === 'connected') {
                    if (await getSession(remote, false)) return;
                    throw new DialogError('auth');
                }
                if (state.status !== 'connecting') throw new DialogError('authFailed');
                if (popup?.closed()) {
                    // The authorization page can close itself as it finishes; read the state once more first.
                    if (closedOnce) throw new DialogError('authFailed');
                    closedOnce = true;
                    continue;
                }
                if (Date.now() > deadline) throw new DialogError('timeout');
                await delay(view, signal);
            }
        } catch (failure) {
            if (started) void settings.disconnect().catch(() => {});
            throw failure;
        } finally {
            popup?.close();
            setAuthorization(null);
        }
    }

    async function save(folder: FileSystemDirectoryHandle, browser: boolean, signal: AbortSignal) {
        const cloned = snapshot.current!;
        setStep('writing');
        try {
            await writeClonedProject(folder, cloned, {signal});
        } catch (failure) {
            if (browser) await removeBrowserFolder?.(folder).catch(() => {});
            if (signal.aborted) return;
            const code = (failure as {code?: string})?.code;
            setError(code === 'notEmpty' ? labels.notEmpty : browser ? labels.failed : labels.writeFailed);
            // Another folder on the device can take the same download.
            setStep(browser ? 'form' : 'choosing');
            if (browser) snapshot.current = null;
            return;
        }
        setStep('opening');
        try {
            const opened = await openProject(folder);
            if (opened === false || opened === 'cancelled' || opened === 'not-project') {
                setError(labels.openFailed);
                snapshot.current = null;
                setStep('form');
                return;
            }
        } catch {
            setError(labels.openFailed);
            snapshot.current = null;
            setStep('form');
            return;
        }
        if (alive.current) close(true);
    }

    async function run(remote: string, mode: 'desktop' | 'cloudflare', popup: Popup | null, signal: AbortSignal) {
        try {
            setStep('connecting');
            await authorize(remote, mode, popup, signal);
            setStep('cloning');
            const cloned = await cloneRemoteProject({remote, getSession: settings.getSession!, signal,
                onProgress: event => setProgress(event)});
            setProgress(null);
            if (!cloned.ok) {
                if (cloned.reason === 'not-project') {
                    setStep('form');
                    setNotProject(true);
                    return;
                }
                const key = cloned.reason === 'invalid-remote' ? 'invalidUrl' : cloned.reason;
                throw new DialogError(key, cloned.path);
            }
            snapshot.current = cloned.snapshot;
            if (destination === 'device') {
                setStep('choosing');
                return;
            }
            const name = remote.slice(remote.lastIndexOf('/') + 1, -'.git'.length);
            const folder = await createBrowserFolder!(name);
            if (signal.aborted) {
                await removeBrowserFolder?.(folder).catch(() => {});
                return;
            }
            await save(folder, true, signal);
        } catch (failure) {
            setProgress(null);
            if (signal.aborted) return;
            snapshot.current = null;
            setError(message(failure));
            setStep('form');
        }
    }

    const start = (event: React.FormEvent) => {
        event.preventDefault();
        if (step !== 'form') return;
        let remote: string;
        try {
            remote = remoteUrl(url.trim());
        } catch {
            setInvalid(true);
            return;
        }
        setInvalid(false);
        setError(null);
        const mode = settings.getView().mode ?? preferredMode(view, settings.modes);
        if (!settings.getSession || !mode) {
            setError(labels.unavailable);
            return;
        }
        // Reserve the authorization window now, while the click still allows it.
        const popup = mode === 'cloudflare' && settings.getView().state.status !== 'connected' ? reserveWindow(view) : null;
        setBlocked(mode === 'cloudflare' && settings.getView().state.status !== 'connected' && !popup);
        const controller = new AbortController();
        abort.current = controller;
        void run(remote, mode, popup, controller.signal);
    };
    const choose = () => {
        const controller = abort.current;
        if (!controller || !pickDeviceFolder || !snapshot.current) return;
        setError(null);
        // The picker is called before anything is awaited, so it keeps the click.
        void pickDeviceFolder().then(folder => {
            if (folder && !controller.signal.aborted) return save(folder, false, controller.signal);
        }, () => setError(labels.writeFailed));
    };
    const cancel = () => {
        abort.current?.abort();
        snapshot.current = null;
        setProgress(null);
        setAuthorization(null);
        setStep('form');
    };

    const busy = step !== 'form';
    const status = step === 'connecting' ? labels.connecting : step === 'cloning' ? labels.cloning :
        step === 'choosing' ? labels.choosing : step === 'writing' ? labels.writing : step === 'opening' ? labels.opening : '';
    const canOpen = destination === 'device' ? deviceAvailable : !!createBrowserFolder;
    return <dialog className="twgit-panel twgit-connection-dialog twgit-remote-repository-dialog" ref={dialog}
        aria-label={labels.title} onClose={() => onDone(result.current)}>
        <header>
            <PanelIcon name="globe"/><h2>{labels.title}</h2>
            <CloseButton label={labels.close} onClick={() => close()}/>
        </header>
        <form className="twgit-connection-body" onSubmit={start} noValidate>
            <label>{labels.url}
                <input type="url" name="remote" value={url} placeholder={labels.urlHint} disabled={busy} required
                    autoComplete="off" spellCheck={false} aria-invalid={invalid || undefined}
                    onChange={event => {setUrl(event.currentTarget.value); setInvalid(false);}}/>
            </label>
            {invalid && <p className="twgit-error" role="alert">{labels.invalidUrl}</p>}
            <fieldset disabled={busy}>
                <legend>{labels.destination}</legend>
                <label><input type="radio" name="destination" value="device" checked={destination === 'device'}
                    disabled={!deviceAvailable} onChange={() => setDestination('device')}/> {labels.device}</label>
                {options.deviceFolders === false && <p className="twgit-setup-note">{labels.deviceUnavailable}</p>}
                {createBrowserFolder && <label><input type="radio" name="destination" value="browser"
                    checked={destination === 'browser'} onChange={() => setDestination('browser')}/> {labels.browser}</label>}
            </fieldset>
            {status && <p role="status">{status}</p>}
            {step === 'cloning' && progress && <p>
                <progress max={progress.total || undefined} value={progress.total ? progress.loaded : undefined}
                    aria-label={progress.phase}/> {progress.phase}
            </p>}
            {authorization && <>
                <p>{authorization.userCode && <code>{authorization.userCode} </code>}
                    <a href={authorization.url} target="_blank" rel="noopener noreferrer">{labels.openAuthorization}</a></p>
                {authorization.userCode && <p>{labels.deviceCodeHelp}</p>}
                {blocked && <p>{labels.popupBlocked}</p>}
            </>}
            {error && <p className="twgit-error" role="alert">{error}</p>}
            <div className="twgit-remote-repository-actions">
                {step === 'choosing' && <button type="button" onClick={choose}>{labels.chooseFolder}</button>}
                {busy && step !== 'opening' && <button type="button" onClick={cancel}>{labels.cancel}</button>}
                {!busy && <button type="submit" disabled={!canOpen || !url.trim()}>{error ? labels.retry : labels.open}</button>}
            </div>
        </form>
        {notProject && <dialog className="twgit-panel twgit-connection-dialog" ref={alert} role="alertdialog"
            aria-label={labels.notProject} onClose={() => close()}>
            <div className="twgit-connection-body">
                <p>{labels.notProject}</p>
                <div className="twgit-remote-repository-actions">
                    <button type="button" autoFocus onClick={() => alert.current?.close()}>{labels.ok}</button>
                </div>
            </div>
        </dialog>}
    </dialog>;
}

/**
 * Asks for a GitHub repository and where to save it, connects with read access (opening GitHub's authorization when
 * needed), clones its default branch in memory and, only when the root of that branch is a project, saves it in an
 * empty folder and calls `openProject` with the folder. A repository without a project shows "This folder is not a
 * project folder." and writes nothing. Resolves `true` once the project was opened, `false` when the dialog closed.
 */
export function openRemoteRepositoryDialog(options: RemoteRepositoryDialogOptions): Promise<boolean> {
    const {document} = options;
    const view = document.defaultView!;
    return new Promise(resolve => {
        const container = document.createElement('div');
        document.body.append(container);
        let done = false;
        const finish = (opened: boolean) => {
            if (done) return;
            done = true;
            // Unmount after the closing event has finished.
            view.setTimeout(() => {
                unmountComponentAtNode(container);
                container.remove();
                resolve(opened);
            }, 0);
        };
        render(<RemoteRepositoryDialog view={view} options={options} onDone={finish}/>, container);
    });
}
