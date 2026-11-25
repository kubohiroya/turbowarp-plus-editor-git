import type {labelsFor} from './messages.js';
import {mergePlanPathLabel, type MergePlan} from './merge-plan.js';
import type {prepareMergeCommit} from './merge-plan-commit.js';
import {createMergePlanTestSummary, type MergePlanTestResult} from './merge-plan-tests.js';

export function confirmMergeCommit(document: Document, locale: string, title: string, plan: MergePlan,
    changes: Awaited<ReturnType<typeof prepareMergeCommit>>, labels: ReturnType<typeof labelsFor>, result: MergePlanTestResult | null) {
    const ja = locale.startsWith('ja');
    const headingText = ja ? 'マージコミットを確認' : 'Review merge commit';
    const dialog = document.createElement('dialog');
    dialog.className = 'twgit-restore-dialog';
    dialog.setAttribute('aria-label', headingText);
    const heading = document.createElement('h2');
    heading.textContent = headingText;
    const summary = document.createElement('p');
    summary.textContent = `${title} · ${plan.folder || '.'}`;
    const parents = document.createElement('p');
    const {current, incoming} = plan.inputs;
    parents.textContent = `${incoming.name} @ ${incoming.oid.slice(0, 12)} → ${current.name} @ ${current.oid.slice(0, 12)}`;
    const content = document.createElement('p');
    content.textContent = (ja ? '内容ID ' : 'Content ID ') + plan.contentId;
    const list = document.createElement('ul');
    for (const {relative, before, after} of changes) {
        const row = document.createElement('li');
        const path = document.createElement('code');
        path.textContent = mergePlanPathLabel(relative);
        row.append((!before ? labels.added : !after ? labels.deleted : labels.modified) + ' ', path);
        list.append(row);
    }
    if (!changes.length) {
        const row = document.createElement('li');
        row.textContent = ja ? 'ファイルの変更なし。2つの親を持つコミットを作成します。' :
            'The files match the current branch. The merge commit will record both parents.';
        list.append(row);
    }
    const form = document.createElement('form');
    form.method = 'dialog';
    const label = document.createElement('label');
    const message = document.createElement('input');
    message.value = `Merge ${incoming.name} into ${current.name}`;
    message.required = true;
    label.append(labels.commitLabel + ' ', message);
    const cancel = document.createElement('button');
    cancel.value = 'cancel';
    cancel.textContent = labels.cancel;
    cancel.autofocus = true;
    cancel.formNoValidate = true;
    const apply = document.createElement('button');
    apply.value = 'apply';
    apply.textContent = ja ? 'マージコミットを作成' : 'Create merge commit';
    form.append(label, cancel, apply);
    dialog.append(heading, summary, parents, content, createMergePlanTestSummary(document, locale, result), list, form);
    return new Promise<string | undefined>(resolve => {
        dialog.addEventListener('close', () => {
            dialog.remove();
            resolve(dialog.returnValue === 'apply' ? message.value : undefined);
        }, {once: true});
        document.body.append(dialog);
        dialog.showModal();
    });
}
