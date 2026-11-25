import {dialogAction, dialogActions} from '@kubohiroya/turbowarp-plus-editor-windows';
import type {MergePlaytestRequest} from './merge-playtest.js';
import type {PlaytestObserver, PlaytestReadRequest} from './merge-playtest-observation.js';
import {isProjectVersionEditor} from './project-version-editor.js';
export {isProjectVersionEditor, openProjectVersionEditor, receiveProjectVersionEditor} from './project-version-editor.js';
export type {MergePlanCodeEdit} from './merge-plan.js';
export {connectMergePlaytest, focusPlaytestStop} from './merge-playtest-view.js';
export type {MergePlaytestRequest, PlaytestStop} from './merge-playtest.js';
export type {PlaytestVM} from './merge-playtest-view.js';
export type {MergePlanSharePort} from './merge-plan-sharing.js';
export {registerPlaytestDebugger} from './merge-playtest-observation.js';
export type {PlaytestObserver, PlaytestDebugger, PlaytestReadRequest} from './merge-playtest-observation.js';

/**
 * Shows a past version of the project, read from the repository's history, in a player inside a
 * dialog. The host builds the version's SB3 and serves the player page; this module owns the
 * dialog, its wording and the handshake that hands the archive to the page.
 *
 * Handshake: the page posts `'tw-plus/git-preview-ready'` to its parent, and the dialog answers
 * with `{kind: 'tw-plus/git-preview-project', archive}`, transferring the archive. Both sides check
 * the origin and the window, so no other page can send or receive the project.
 */

export const PROJECT_VERSION_PREVIEW_READY = 'tw-plus/git-preview-ready';
export const PROJECT_VERSION_PREVIEW_PROJECT = 'tw-plus/git-preview-project';
const previewLoaded = 'tw-plus/git-preview-loaded';
const previewUnloaded = 'tw-plus/git-preview-unloaded';
const previewRead = 'tw-plus/git-preview-read';
const observeParam = 'twPlusObserveMergePlaytest';
export const isObservedProjectVersion = (view: Window) => view.parent !== view && !isProjectVersionEditor(view) &&
    new URLSearchParams(view.location.search).get(observeParam) === '1';

const japanese = (locale: string | null | undefined) => /^ja(?:-|$)/i.test(locale || '');

/** The words of the version preview, for the dialog and for the player page. */
export function projectVersionPreviewMessages(locale: string | null | undefined) {
    return japanese(locale) ? {
        title: '作品の過去版',
        close: '閉じる',
        loadFailed: 'この版の作品を読み込めませんでした。'
    } : {
        title: 'Project version',
        close: 'Close',
        loadFailed: 'This version could not be loaded.'
    };
}

export interface ProjectVersionPreviewOptions {
    /** The player page, resolved against the document's URL. */
    page: string;
    /** Extra query parameters for the page, such as startup flags that turn Editor features off. */
    params?: Readonly<Record<string, string>>;
    /** The caller's localized label for a preview outside the commit history. */
    title?: string;
    playtest?: MergePlaytestRequest;
    observe?: PlaytestObserver;
}

export function openProjectVersionPreview(document: Document, oid: string, archive: ArrayBuffer, locale: string,
    {page, params = {}, title, playtest, observe}: ProjectVersionPreviewOptions) {
    const text = projectVersionPreviewMessages(locale);
    const preview = document.createElement('dialog');
    const heading = document.createElement('h2');
    heading.textContent = title ?? `${text.title} · ${oid.slice(0, 12)}`;
    preview.setAttribute('aria-label', heading.textContent);
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = text.close;
    close.onclick = () => preview.close();
    const frame = document.createElement('iframe');
    const view = document.defaultView!;
    const url = new URL(page, view.location.href);
    const origin = view.location.origin;
    if (url.protocol !== view.location.protocol || url.host !== view.location.host) throw new Error('Unexpected player origin');
    url.searchParams.set('lang', locale);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    if (observe) url.searchParams.set(observeParam, '1');
    frame.src = url.href;
    frame.title = heading.textContent;
    frame.allow = 'autoplay; fullscreen';
    frame.style.cssText = 'width: min(850px, 85vw); height: min(630px, 75vh); border: 0; display: block';
    preview.append(heading);
    if (playtest?.blocking.length) {
        const summary = document.createElement('p');
        summary.role = 'alert';
        summary.textContent = japanese(locale) ? '試遊の前に、次の構造上の競合を候補で解決してください。' :
            'Resolve these structural conflicts in the candidate before playtesting.';
        const list = document.createElement('ul');
        for (const description of playtest.blocking) {
            const item = document.createElement('li');
            item.textContent = description;
            list.append(item);
        }
        preview.append(summary, list);
    } else preview.append(frame);
    preview.append(dialogActions(document, dialogAction(close, 'close')));
    const pending = new Set<() => void>();
    const unavailable = () => {
        observe?.(null);
        pending.forEach(cancel => cancel());
    };
    const dispose = () => {
        view.removeEventListener('message', send);
        unavailable();
        preview.remove();
    };
    const read = (query: PlaytestReadRequest) => new Promise<unknown>((resolve, reject) => {
        if (!preview.open) {
            unavailable();
            reject(new Error('The playtest has closed.'));
            return;
        }
        const {port1, port2} = new MessageChannel();
        const fail = () => reject(new Error('The playtest could not be observed.'));
        const cancel = () => {clean(); fail();};
        const timer = view.setTimeout(cancel, 2000);
        const clean = () => {
            pending.delete(cancel);
            view.clearTimeout(timer);
            port1.close();
        };
        pending.add(cancel);
        port1.onmessage = ({data}) => {
            clean();
            if (!preview.open) unavailable();
            if (preview.open && data?.ok === true) resolve(data.observation);
            else fail();
        };
        try {
            frame.contentWindow!.postMessage({kind: previewRead, query}, origin, [port2]);
        } catch {
            port2.close();
            cancel();
        }
    });
    let sent = false;
    const send = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow || event.origin !== origin) return;
        if (!sent && event.data === PROJECT_VERSION_PREVIEW_READY) {
            sent = true;
            frame.contentWindow!.postMessage({kind: PROJECT_VERSION_PREVIEW_PROJECT, archive, ...(playtest && {playtest})}, origin, [archive]);
        } else if (sent && event.data === previewLoaded && preview.open) {
            observe?.(read);
        } else if (sent && (event.data === previewUnloaded || event.data === PROJECT_VERSION_PREVIEW_READY)) {
            unavailable();
        }
    };
    preview.addEventListener('close', dispose, {once: true});
    view.addEventListener('message', send);
    document.body.append(preview);
    preview.showModal();
    return preview;
}

/** The parts of an sb3-toolchain source manifest that packing reads. */
interface VersionSourceManifest {
    project: string;
    embeddedExtensions: string;
    assetsDirectory: string;
    archiveEntries: readonly string[];
}
interface VersionExtensionManifest {
    extensions: readonly {id: string; path: string; mediaType: string; parameters: readonly string[]; encoding: string}[];
}
/** The JSZip constructor the host bundles; this module does not import one. */
export interface ProjectVersionZip {
    new(): {file(name: string, data: string | Uint8Array): unknown; generateAsync(options: {type: 'arraybuffer'}): Promise<ArrayBuffer>};
}

const decoder = new TextDecoder('utf-8', {fatal: true});
const read = (files: ReadonlyMap<string, Uint8Array>, path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`The version has no ${path}`);
    return bytes;
};

/**
 * Builds the SB3 of a past version from its sb3-toolchain source files, embedding each extension
 * as a data URL so the player needs nothing outside the archive.
 * @param files The version's source files, by path.
 * @param options `validate` checks the source files first and throws when they are not a project
 * (the host supplies sb3-toolchain's validator); `zip` is the JSZip constructor the host bundles.
 * @returns The SB3 bytes.
 */
export async function packProjectVersion(files: ReadonlyMap<string, Uint8Array>,
    {validate, zip: Zip}: {validate(files: ReadonlyMap<string, Uint8Array>): void; zip: ProjectVersionZip}) {
    validate(files);
    const manifest: VersionSourceManifest = JSON.parse(decoder.decode(read(files, 'sb3-source.json')));
    const project: {extensionURLs?: Record<string, string>} = JSON.parse(decoder.decode(read(files, manifest.project)));
    const extensions: VersionExtensionManifest = JSON.parse(decoder.decode(read(files, manifest.embeddedExtensions)));
    for (const {id, path, mediaType, parameters, encoding} of extensions.extensions) {
        const contents = read(files, path);
        let payload: string;
        if (encoding === 'base64') {
            const parts: string[] = [];
            for (let offset = 0; offset < contents.length; offset += 0x8000) {
                parts.push(String.fromCharCode(...contents.subarray(offset, offset + 0x8000)));
            }
            payload = btoa(parts.join(''));
        } else {
            payload = Array.from(contents, byte => '%' + byte.toString(16).padStart(2, '0')).join('');
        }
        (project.extensionURLs ??= {})[id] =
            `data:${[mediaType, ...parameters].join(';')}${encoding === 'base64' ? ';base64' : ''},${payload}`;
    }
    const archive = new Zip();
    for (const name of manifest.archiveEntries) {
        if (name === 'project.json') archive.file(name, JSON.stringify(project));
        else if (name === 'tw-plus/workspace.json') {
            const workspace = files.get('.tw-plus/workspace.json');
            if (workspace) archive.file(name, workspace);
        }
        else archive.file(name, read(files, `${manifest.assetsDirectory}/${name}`));
    }
    return archive.generateAsync({type: 'arraybuffer'});
}

/** What the player page does with the archive it receives; the host's GUI supplies each step. */
export interface ProjectVersionPreviewPlayer {
    /** Loads the archive into the player's VM. */
    load(archive: ArrayBuffer, playtest?: MergePlaytestRequest): Promise<void>;
    /** Marks the project as loading, before `load`. */
    loading?(): void;
    /** Marks loading as finished, with whether it succeeded. */
    loaded?(success: boolean): void;
    inspect?(query: PlaytestReadRequest): unknown;
    /** Shows the message when the version could not be loaded. */
    showError(message: string): void;
}

/**
 * The player page's side of the handshake: tells the parent it is ready and loads the one archive
 * the parent sends back. Only a message from the parent window, on this page's origin, is accepted.
 * @param view The player page's window.
 * @param player How the page's GUI loads and reports.
 */
export function receiveProjectVersionPreview(view: Window, player: ProjectVersionPreviewPlayer) {
    const origin = view.location.origin;
    let loaded = false;
    const load = async (event: MessageEvent) => {
        if (event.source !== view.parent || event.origin !== origin || event.data?.kind !== PROJECT_VERSION_PREVIEW_PROJECT ||
            !(event.data.archive instanceof ArrayBuffer)) return;
        view.removeEventListener('message', load);
        player.loading?.();
        try {
            await player.load(event.data.archive, event.data.playtest);
            player.loaded?.(true);
            loaded = true;
            view.parent.postMessage(previewLoaded, origin);
        } catch {
            player.loaded?.(false);
            player.showError(projectVersionPreviewMessages(new URLSearchParams(view.location.search).get('lang')).loadFailed);
        }
    };
    view.addEventListener('message', load);
    const inspect = (event: MessageEvent) => {
        if (event.source !== view.parent || event.origin !== origin || event.data?.kind !== previewRead) return;
        const reply = event.ports[0];
        if (!reply) return;
        try {
            if (!loaded || !player.inspect || !isObservedProjectVersion(view)) throw new Error('Player unavailable');
            reply.postMessage({ok: true, observation: player.inspect(event.data.query)});
        } catch {
            reply.postMessage({ok: false});
        } finally {
            reply.close();
        }
    };
    view.addEventListener('message', inspect);
    const unload = () => view.parent.postMessage(previewUnloaded, origin);
    view.addEventListener('pagehide', unload, {once: true});
    view.parent.postMessage(PROJECT_VERSION_PREVIEW_READY, origin);
    return () => {
        view.removeEventListener('message', load);
        view.removeEventListener('message', inspect);
        view.removeEventListener('pagehide', unload);
    };
}
