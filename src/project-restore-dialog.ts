import type {labelsFor} from './messages.js';
import type {ProjectRestorePlan} from './project-version.js';

export function confirmProjectRestore(document: Document, plan: ProjectRestorePlan, labels: ReturnType<typeof labelsFor>) {
    const dialog = document.createElement('dialog');
    dialog.className = 'twgit-restore-dialog';
    dialog.setAttribute('aria-label', labels.historyRestoreVersion);
    const heading = document.createElement('h2');
    heading.textContent = labels.historyRestoreVersion;
    const description = document.createElement('p');
    description.textContent = labels.restoreSummary.replace('{folder}', () => plan.folder || '.')
        .replace('{branch}', () => plan.branch).replace('{oid}', () => plan.oid.slice(0, 12));
    const list = document.createElement('ul');
    const prefix = plan.folder ? plan.folder.length + 1 : 0;
    for (const {path, before, after} of plan.changes) {
        const item = document.createElement('li');
        const name = document.createElement('code');
        name.textContent = path.slice(prefix);
        item.append((!before ? labels.added : !after ? labels.deleted : labels.modified) + ' ', name);
        list.append(item);
    }
    const form = document.createElement('form');
    form.method = 'dialog';
    const cancel = document.createElement('button');
    cancel.value = 'cancel';
    cancel.textContent = labels.cancel;
    cancel.autofocus = true;
    const apply = document.createElement('button');
    apply.value = 'restore';
    apply.textContent = labels.restoreConfirm;
    form.append(cancel, apply);
    dialog.append(heading, description, list, form);
    return new Promise<boolean>(resolve => {
        dialog.addEventListener('close', () => {
            dialog.remove();
            resolve(dialog.returnValue === 'restore');
        }, {once: true});
        document.body.append(dialog);
        dialog.showModal();
    });
}
