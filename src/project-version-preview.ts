import {dialogAction, dialogActions} from '@kubohiroya/turbowarp-plus-editor-windows';

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
}

export function openProjectVersionPreview(document: Document, oid: string, archive: ArrayBuffer, locale: string,
    {page, params = {}}: ProjectVersionPreviewOptions) {
    const text = projectVersionPreviewMessages(locale);
    const preview = document.createElement('dialog');
    const heading = document.createElement('h2');
    heading.textContent = `${text.title} · ${oid.slice(0, 12)}`;
    preview.setAttribute('aria-label', heading.textContent);
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = text.close;
    close.onclick = () => preview.close();
    const frame = document.createElement('iframe');
    const view = document.defaultView!;
    const url = new URL(page, view.location.href);
    url.searchParams.set('lang', locale);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    frame.src = url.href;
    frame.title = heading.textContent;
    frame.allow = 'autoplay; fullscreen';
    frame.style.cssText = 'width: min(850px, 85vw); height: min(630px, 75vh); border: 0; display: block';
    preview.append(heading, frame, dialogActions(document, dialogAction(close, 'close')));
    const dispose = () => {
        view.removeEventListener('message', send);
        preview.remove();
    };
    const send = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow || event.origin !== url.origin ||
            event.data !== PROJECT_VERSION_PREVIEW_READY) return;
        view.removeEventListener('message', send);
        frame.contentWindow!.postMessage({kind: PROJECT_VERSION_PREVIEW_PROJECT, archive}, url.origin, [archive]);
    };
    preview.addEventListener('close', dispose, {once: true});
    view.addEventListener('message', send);
    document.body.append(preview);
    preview.showModal();
    return preview;
}
