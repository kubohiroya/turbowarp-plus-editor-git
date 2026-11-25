import {dialogAction, dialogActions} from '@kubohiroya/turbowarp-plus-editor-windows';
import {GitPanelError} from './filesystem.js';
import type {MergePlanCodeEdit} from './merge-plan.js';
import type {PlaytestStop} from './merge-playtest.js';
import type {ProjectVersionPreviewOptions, ProjectVersionPreviewPlayer} from './project-version-preview.js';

const sessionParam = 'twPlusMergePlanEditor';
const protocol = 'tw-plus/merge-plan-editor/';
const snapshotLimit = 32 * 1024 * 1024;
const editMessages = (locale: string) => locale.startsWith('ja') ? {
    save: '新しい世代として保存', close: '保存せず閉じる', loading: '候補を読み込み中…',
    saving: '世代を保存中…', failed: '候補を保存できませんでした。編集内容は画面に残っています。',
    loadFailed: '候補を開けませんでした。', unchanged: '保存できるブロックの変更がありません。',
    unsupported: 'この画面では、スプライト・素材・拡張の追加や削除は保存できません。',
    help: 'ブロック、コメント、変数・リスト・メッセージの定義を保存できます。試遊中の値や座標は保存されません。',
    resume: '仮採用して再開', paused: '試遊全体を一時停止中', script: 'スクリプトを編集',
    applying: '編集中のスクリプトを確認中…', rejected: 'この編集では停止地点から再開できません。停止地点までのブロックと参照を確認してください。'
} : {
    save: 'Save as new generation', close: 'Close without saving', loading: 'Loading candidate…',
    saving: 'Saving generation…', failed: 'The candidate could not be saved. Your edits are still open.',
    loadFailed: 'The candidate could not be opened.', unchanged: 'There are no block edits to save.',
    unsupported: 'This editor cannot save changes to sprites, assets or custom extensions.',
    help: 'Save blocks, comments, and variable, list and message definitions. Playtest values and positions are left as they were.',
    resume: 'Try edit and resume', paused: 'The whole playtest is paused', script: 'Edit script',
    applying: 'Checking the edited script…', rejected: 'This edit cannot resume at the paused block. Check the blocks and references up to that point.'
};

export const isProjectVersionEditor = (view: Window) =>
    view.parent !== view && Boolean(new URLSearchParams(view.location.search).get(sessionParam));

export function openProjectVersionEditor(document: Document, archive: ArrayBuffer, locale: string,
    {page, params = {}, title, stop}: ProjectVersionPreviewOptions & {title: string; stop?: PlaytestStop},
    save: (edit: MergePlanCodeEdit) => Promise<string>): Promise<string | undefined> {
    const view = document.defaultView!;
    const text = editMessages(locale);
    const session = view.crypto.randomUUID();
    const url = new URL(page, view.location.href);
    if (url.origin !== view.location.origin) throw new Error('The candidate editor must be on this origin');
    url.searchParams.set('lang', locale);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    url.searchParams.set(sessionParam, session);
    const dialog = document.createElement('dialog');
    dialog.className = 'twgit-merge-code-editor';
    dialog.setAttribute('aria-label', title);
    const heading = document.createElement('h2');
    heading.textContent = title;
    const help = document.createElement('p');
    help.textContent = stop ? text.paused : text.help;
    if (stop) help.setAttribute('role', 'status');
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = text.loading;
    const frame = document.createElement('iframe');
    frame.title = title;
    frame.allow = 'autoplay; fullscreen';
    frame.src = url.href;
    const finish = document.createElement('button');
    finish.type = 'button';
    finish.textContent = stop ? text.resume : text.save;
    finish.disabled = true;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = text.close;
    const editor = document.createElement('div');
    if (stop) {
        dialog.dataset.playtest = '';
        const tabs = document.createElement('div');
        const tab = document.createElement('button');
        const id = 'merge-playtest-' + session;
        tabs.setAttribute('role', 'tablist');
        tab.type = 'button';
        tab.id = id + '-tab';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', 'true');
        tab.setAttribute('aria-controls', id);
        tab.textContent = text.script;
        tabs.append(tab);
        editor.id = id;
        editor.setAttribute('role', 'tabpanel');
        editor.setAttribute('aria-labelledby', tab.id);
        dialog.append(heading, help, tabs);
    } else dialog.append(heading, help);
    editor.append(frame);
    dialog.append(editor, status, dialogActions(document,
        dialogAction(close, 'close'), dialogAction(finish, 'confirm')));
    let phase: 'waiting' | 'loading' | 'ready' | 'snapshot' | 'saving' = 'waiting';
    let saved: string | undefined;
    const send = (kind: string, extra: object = {}, transfer: Transferable[] = []) =>
        frame.contentWindow!.postMessage({kind: protocol + kind, session, ...extra}, url.origin, transfer);
    finish.onclick = () => {
        if (phase !== 'ready') return;
        phase = 'snapshot';
        finish.disabled = true;
        close.disabled = true;
        status.textContent = stop ? text.applying : text.saving;
        send('snapshot');
    };
    close.onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => {
        if (phase === 'snapshot' || phase === 'saving') event.preventDefault();
    });
    return new Promise(resolve => {
        const failed = (message: string) => {
            phase = 'ready';
            finish.disabled = false;
            close.disabled = false;
            status.textContent = message;
        };
        const receive = async (event: MessageEvent) => {
            if (event.source !== frame.contentWindow || event.origin !== url.origin || event.data?.session !== session) return;
            const {kind, before, after} = event.data;
            if (kind === protocol + 'ready' && phase === 'waiting') {
                phase = 'loading';
                send('load', {archive, stop}, [archive]);
            } else if (kind === protocol + 'loaded' && phase === 'loading') {
                phase = 'ready';
                finish.disabled = false;
                status.textContent = '';
            } else if (kind === protocol + 'load-failed' && phase === 'loading') {
                status.textContent = text.loadFailed;
            } else if (kind === protocol + 'snapshot-failed' && phase === 'snapshot') {
                failed(text.failed);
            } else if (kind === protocol + 'snapshot-result' && phase === 'snapshot') {
                if (typeof before !== 'string' || typeof after !== 'string' ||
                    before.length > snapshotLimit || after.length > snapshotLimit) {
                    failed(text.failed);
                    return;
                }
                phase = 'saving';
                try {
                    saved = await save({before, after});
                    dialog.close();
                } catch (error) {
                    failed(stop ? text.rejected : error instanceof GitPanelError && error.code === 'mergePlanEditUnchanged' ? text.unchanged :
                        error instanceof GitPanelError && error.code === 'mergePlanEditUnsupported' ? text.unsupported : text.failed);
                }
            }
        };
        dialog.addEventListener('close', () => {
            view.removeEventListener('message', receive);
            dialog.remove();
            resolve(saved);
        }, {once: true});
        view.addEventListener('message', receive);
        document.body.append(dialog);
        dialog.showModal();
    });
}

/** The embedded Editor owns only an in-memory project. It sends source snapshots, not a directory or Git handle. */
export function receiveProjectVersionEditor(view: Window, editor: ProjectVersionPreviewPlayer & {
    snapshot(): string; focus?(stop: PlaytestStop): void;
}) {
    const session = new URLSearchParams(view.location.search).get(sessionParam);
    const origin = view.location.origin;
    if (!session || view.parent === view) return;
    let started = false;
    let before: string | undefined;
    const send = (kind: string, extra: object = {}) => view.parent.postMessage({kind: protocol + kind, session, ...extra}, origin);
    const receive = async (event: MessageEvent) => {
        if (event.source !== view.parent || event.origin !== origin || event.data?.session !== session) return;
        if (event.data.kind === protocol + 'load' && !started && event.data.archive instanceof ArrayBuffer) {
            started = true;
            editor.loading?.();
            try {
                await editor.load(event.data.archive);
                before = editor.snapshot();
                editor.loaded?.(true);
                if (event.data.stop) editor.focus?.(event.data.stop);
                send('loaded');
            } catch {
                editor.loaded?.(false);
                send('load-failed');
            }
        } else if (event.data.kind === protocol + 'snapshot' && before !== undefined) {
            try {
                send('snapshot-result', {before, after: editor.snapshot()});
            } catch {
                send('snapshot-failed');
            }
        }
    };
    view.addEventListener('message', receive);
    send('ready');
    return () => view.removeEventListener('message', receive);
}
