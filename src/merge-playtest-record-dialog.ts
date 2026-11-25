import {dialogAction, dialogActions} from '@kubohiroya/turbowarp-plus-editor-windows';
import {PlaytestRecordError, playtestRecordNoteLimit, playtestRecordVariableLimit,
    type PlaytestRecordPort} from './merge-playtest-record.js';

const words = (locale: string) => locale.startsWith('ja') ? {
    open: 'この試遊状態を共有…', title: '試遊状態の共有',
    values: '記録する変数・リスト（最大16件）', list: 'リスト', logs: '直近のログを含める', note: '試遊メモ（任意）',
    save: '共有フォルダを選んで保存…', close: '閉じる', saving: '試遊状態を保存中…',
    saved: (file: string, folder: string) => `${folder} に ${file} を保存しました。`,
    tooMany: '変数・リストを16件以内にしてください。',
    insideWorktree: 'Gitリポジトリと重ならない共有フォルダを選んでください。',
    captureUnavailable: 'この試遊の状態を取得できませんでした。',
    failed: '選んだフォルダに試遊状態を保存できませんでした。'
} : {
    open: 'Share this playtest state…', title: 'Share playtest state',
    values: 'Variables and lists to record (up to 16)', list: 'list', logs: 'Include recent logs', note: 'Playtest note (optional)',
    save: 'Choose a shared folder and save…', close: 'Close', saving: 'Saving playtest state…',
    saved: (file: string, folder: string) => `Saved ${file} in ${folder}.`,
    tooMany: 'Choose up to 16 variables and lists.',
    insideWorktree: 'Choose a shared folder outside the Git repository.',
    captureUnavailable: 'Could not read the state of this playtest.',
    failed: 'Could not save the playtest state in the selected folder.'
};

export function connectPlaytestRecord(preview: HTMLDialogElement, locale: string, port: PlaytestRecordPort) {
    const document = preview.ownerDocument;
    const text = words(locale);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text.open;
    button.disabled = true;
    let dialog: HTMLDialogElement | undefined;
    button.onclick = () => {
        if (button.disabled || !preview.open || dialog) return;
        const modal = dialog = document.createElement('dialog');
        modal.className = 'twgit-playtest-record';
        modal.setAttribute('aria-label', text.title);
        const heading = document.createElement('h2');
        heading.textContent = text.title;
        const form = document.createElement('form');
        const values = document.createElement('fieldset');
        const legend = document.createElement('legend');
        legend.textContent = text.values;
        values.append(legend);
        for (const variable of port.variables) {
            const label = document.createElement('label');
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.name = 'variable';
            check.value = variable.id;
            label.append(check, ` ${variable.target} · ${variable.name}${variable.kind === 'list' ? ` (${text.list})` : ''}`);
            values.append(label);
        }
        const logs = document.createElement('input');
        logs.type = 'checkbox';
        const logLabel = document.createElement('label');
        logLabel.append(logs, ` ${text.logs}`);
        const memo = document.createElement('textarea');
        memo.rows = 3;
        memo.maxLength = playtestRecordNoteLimit;
        const memoLabel = document.createElement('label');
        memoLabel.append(text.note, memo);
        const status = document.createElement('p');
        status.role = 'status';
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = text.close;
        close.onclick = () => modal.close();
        const save = document.createElement('button');
        save.type = 'submit';
        save.textContent = text.save;
        if (port.variables.length) form.append(values);
        form.append(logLabel, memoLabel, status, dialogActions(document, dialogAction(close, 'close'), dialogAction(save, 'confirm')));
        form.onsubmit = async event => {
            event.preventDefault();
            if (save.disabled || !preview.open) return;
            const variableIds = [...new Set(new FormData(form).getAll('variable').map(String))];
            if (variableIds.length > playtestRecordVariableLimit) {
                status.textContent = text.tooMany;
                return;
            }
            save.disabled = close.disabled = true;
            status.textContent = text.saving;
            try {
                const result = await port.save({variableIds, includeLogs: logs.checked, note: memo.value});
                status.textContent = result ? text.saved(result.filename, result.folder) : '';
            } catch (error) {
                status.textContent = error instanceof PlaytestRecordError ? text[error.code] : text.failed;
            } finally {
                save.disabled = close.disabled = false;
            }
        };
        modal.addEventListener('cancel', event => {if (save.disabled) event.preventDefault();});
        modal.addEventListener('close', () => {modal.remove(); dialog = undefined;}, {once: true});
        modal.append(heading, form);
        document.body.append(modal);
        modal.showModal();
    };
    return {
        button,
        available: (available: boolean) => {button.disabled = !available;},
        dispose: () => {dialog?.remove(); dialog = undefined;}
    };
}
