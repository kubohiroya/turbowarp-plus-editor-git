import {dialogAction, dialogActions} from '@kubohiroya/turbowarp-plus-editor-windows';
import type {PublicationCommit} from './project-publication.js';

type Localize = (ja: string, en: string) => string;

export interface ProjectCommitJob {
    id: string;
    message: string;
    status: 'queued' | 'prepared' | 'completed' | 'blocked' | 'failed';
    commitOid?: string;
    error?: string;
}

export interface ProjectCommitPort {
    prepare(current: () => boolean): Promise<{
        branch: string;
        paths: readonly string[];
        enqueue(message: string): Promise<ProjectCommitJob>;
    } | null>;
    jobs(): Promise<readonly ProjectCommitJob[]>;
    run(id: string): Promise<ProjectCommitJob>;
}

const errorText = (error: unknown, l: Localize) => {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : error;
    switch (code) {
    case 'nothingStaged': return l('コミットする作品の変更がありません。', 'There are no project changes to commit.');
    case 'ignoredProjectFile': return l('Git の除外設定に作品ファイルが含まれています。',
        'Git ignore rules exclude a project file.');
    case 'author': return l('Git の作者名とメールアドレスを設定してください。', 'Set the Git author name and email.');
    case 'outsideRepository': return l('開いている作品フォルダを含むリポジトリを選んでください。',
        'Select the repository containing the open project folder.');
    case 'changed': case 'conflict': return l('作品またはリポジトリが変更されました。保存して再確認してください。',
        'The project or repository changed. Save and review the changes again.');
    case 'locked': return l('別の Git 操作が進行中です。', 'Another Git operation is in progress.');
    case 'unsupported': return l('この Git の状態ではコミットできません。', 'This Git state cannot be committed from the editor.');
    case 'rollbackFailed': return l('一部の変更を元に戻せませんでした。作業ツリーと Git の状態を確認してください。',
        'Some changes could not be restored. Check the working tree and Git state.');
    default: return l('保存またはコミットを完了できませんでした。', 'Could not complete the save or commit.');
    }
};

export function renderProjectCommitDialog(document: Document, locale: string, port: ProjectCommitPort, close: () => void,
    openPublication?: (commit: PublicationCommit) => void) {
    const l: Localize = (ja, en) => locale.startsWith('ja') ? ja : en;
    const form = document.createElement('form');
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const heading = document.createElement('h3');
    heading.textContent = l('コミットする作品の変更', 'Project changes to commit');
    const paths = document.createElement('ul');
    paths.setAttribute('aria-label', heading.textContent);
    const selection = document.createElement('div');
    const messageLabel = document.createElement('label');
    messageLabel.textContent = l('コミットメッセージ', 'Commit message');
    const message = document.createElement('input');
    message.name = 'commit-message';
    message.required = true;
    messageLabel.append(message);
    selection.append(heading, paths, messageLabel);
    const jobs = document.createElement('ul');
    jobs.setAttribute('aria-label', l('コミットキュー', 'Commit queue'));
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = l('閉じる', 'Close');
    closeButton.onclick = close;
    const submit = document.createElement('button');
    submit.type = 'submit';
    form.append(selection, status, jobs, dialogActions(document, dialogAction(closeButton, 'close'),
        dialogAction(submit, 'confirm')));

    const saved = new Map<string, ProjectCommitJob>();
    let review: Awaited<ReturnType<ProjectCommitPort['prepare']>> = null;
    let busy = false;
    const render = () => {
        selection.hidden = review === null;
        message.disabled = !review || busy;
        submit.disabled = busy;
        submit.textContent = review ? l('コミットする', 'Commit') : l('保存して変更を確認', 'Save and review changes');
        const rows = [...saved.values()].reverse().slice(0, 20).map(job => {
            const row = document.createElement('li');
            const states = {
                queued: l('待機中', 'Queued'), prepared: l('処理中', 'In progress'),
                completed: l('コミット済み', 'Committed'), blocked: l('要確認', 'Needs review'), failed: l('失敗', 'Failed')
            };
            row.textContent = `${job.message} · ${states[job.status]}${job.commitOid ? ' ' + job.commitOid.slice(0, 8) : ''}`;
            if (job.error) row.append(' · ' + errorText(job.error, l));
            if (job.status === 'completed' && job.commitOid && openPublication) {
                const {id, message, commitOid} = job;
                const publication = document.createElement('button');
                publication.type = 'button';
                publication.textContent = l('PR を作成・確認', 'Create or view PR');
                publication.disabled = busy;
                publication.onclick = () => openPublication({id, message, commitOid});
                row.append(' ', publication);
            } else if (job.status !== 'completed') {
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.textContent = l('再試行', 'Retry');
                retry.disabled = busy;
                retry.onclick = () => void perform(async () => {
                    saved.set(job.id, await port.run(job.id));
                });
                row.append(' ', retry);
            }
            return row;
        });
        jobs.replaceChildren(...rows);
        jobs.hidden = rows.length === 0;
    };
    const perform = async (action: () => Promise<void>) => {
        if (busy) return;
        busy = true;
        status.textContent = l('処理中…', 'Working…');
        render();
        try {
            await action();
            status.textContent = '';
        } catch (error) {
            status.textContent = errorText(error, l);
        } finally {
            busy = false;
            render();
        }
    };
    form.onsubmit = event => {
        event.preventDefault();
        void perform(async () => {
            if (!review) {
                review = await port.prepare(() => form.isConnected);
                if (!review) return;
                heading.textContent = l(`コミットする作品の変更 · ${review.branch}`, `Project changes to commit · ${review.branch}`);
                paths.replaceChildren(...review.paths.map(path => {
                    const row = document.createElement('li');
                    row.textContent = path;
                    return row;
                }));
                queueMicrotask(() => message.focus());
                return;
            }
            if (!message.value.trim()) return;
            const job = await review.enqueue(message.value);
            saved.set(job.id, job);
            review = null;
            message.value = '';
            render();
            saved.set(job.id, await port.run(job.id));
        });
    };
    // A repository can be reopened after a reload. The journal resumes only work for the same folder.
    queueMicrotask(() => {
        if (!form.isConnected) return;
        void perform(async () => {
            for (const job of await port.jobs()) saved.set(job.id, job);
            for (const job of saved.values()) {
                if (job.status === 'queued' || job.status === 'prepared') saved.set(job.id, await port.run(job.id));
            }
        });
    });
    render();
    return form;
}
