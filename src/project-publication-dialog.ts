import {dialogAction, dialogActions} from '@kubohiroya/turbowarp-plus-editor-windows';
import type {PreparedPublication, ProjectPublicationPort, PublicationCommit, PublicationIssue,
    PublicationJob, PublicationStackParent} from './project-publication.js';

type Localize = (ja: string, en: string) => string;

function progressText(job: PublicationJob, l: Localize) {
    if (job.awaitingPush) return l('PR 用のブランチを送信中', 'Pushing the PR branch');
    const states = {
        queued: l('待機中', 'Queued'),
        pushed: l('ブランチ送信済み', 'Branch pushed'),
        creatingIssue: l('Issue を作成中', 'Creating issue'),
        issueReady: l('PR を準備中', 'Preparing pull request'),
        creatingPull: l('PR を作成中', 'Creating pull request'),
        stacking: l('PR をスタックに追加中', 'Adding the pull request to the stack'),
        waitingForParent: l('親 PR のマージを待機中', 'Waiting for the parent pull request to merge'),
        waiting: job.intent.goal === 'merge' ? l('CI・レビューを待機中', 'Waiting for CI and review') :
            l('PR のマージを待機中', 'Waiting for the pull request to merge'),
        ready: l('マージ条件を確認済み', 'Merge conditions met'),
        merging: l('GitHub のマージ処理を待機中', 'Waiting for GitHub to merge'),
        merged: l('マージ済み', 'Merged'),
        done: job.mergeOid ? l('マージ完了', 'Merge complete') : l('PR 作成済み', 'Pull request created')
    };
    return states[job.status];
}

function pauseText(reason: string | undefined, l: Localize) {
    switch (reason) {
    case 'headChanged': case 'baseChanged':
        return l('ブランチが承認時のコミットから変更されました。GitHub で差分を確認してください。',
            'A branch changed after approval. Review the diff on GitHub.');
    case 'checksFailed': return l('CI が失敗しました。GitHub で確認してください。', 'CI failed. Check the results on GitHub.');
    case 'noChecks': return l('CI チェックを確認できません。', 'No CI checks were found.');
    case 'conflicting': return l('マージ競合があります。', 'The pull request has merge conflicts.');
    case 'reviewChanges': return l('レビューで変更が求められています。', 'A review requested changes.');
    case 'mergeRejected': return l('GitHub がマージを拒否しました。', 'GitHub rejected the merge.');
    case 'mergeUnknown': return l('マージ結果を確認できません。GitHub で状態を確認してください。',
        'The merge outcome is uncertain. Check its state on GitHub.');
    case 'pullClosed': return l('PR はクローズされています。', 'The pull request is closed.');
    case 'issueUnavailable': return l('指定の Issue を利用できません。', 'The selected issue is unavailable.');
    case 'downstack': return l('GitHub でスタックされた PR の状態を確認してください。', 'Check the stacked pull requests on GitHub.');
    case 'stackUnknown': return l('スタックへの追加結果を確認できません。GitHub で状態を確認してください。',
        'Could not verify that the pull request was added to the stack. Check the stack on GitHub.');
    case 'stackParentChanged': return l('親 PR のブランチまたは状態が変わりました。GitHub で確認してください。',
        'The parent pull request changed. Check it on GitHub.');
    case 'stackDiffChanged': return l('親 PR のマージ後に子 PR の差分が変わりました。GitHub で再確認してください。',
        'The child pull request diff changed after the parent merged. Review it on GitHub.');
    case 'closingIssues': return l('この PR による Issue の自動クローズを GitHub で確認してください。',
        'Review automatic issue closure for this pull request on GitHub.');
    case 'issueUnknown': case 'pullUnknown':
        return l('作成結果を確認できません。GitHub で状態を確認してください。',
            'The creation outcome is uncertain. Check its state on GitHub.');
    default: return reason ? l('処理が一時停止しました。', 'Publication is paused.') : '';
    }
}

function errorText(error: unknown, l: Localize) {
    const code = error instanceof Error ? error.message : String(error);
    if (/\b(?:FORBIDDEN|GIT_UNAVAILABLE|SESSION_\w+|REAUTH_REQUIRED|session)\b/u.test(code)) {
        return l('ローカル Git で対象リポジトリを GitHub App に書き込み権限付きで接続してください。',
            'Connect the repository through Local Git with GitHub App write access.');
    }
    if (code.includes('PUBLICATION_BASE')) return l('コミットが異なるベースブランチを選んでください。',
        'Choose a base branch at a different commit.');
    if (code.includes('PUBLICATION_STACK_PARENT')) return l('同じリポジトリの開いている親 PR を確認してください。',
        'Verify an open parent pull request in this repository.');
    if (code.includes('PUBLICATION_POPUP')) return l('PR 承認のポップアップを許可して再試行してください。',
        'Allow the publication approval popup and try again.');
    if (code.includes('RATE_LIMITED')) return l('GitHub の利用上限に達しました。しばらくして再試行してください。',
        'GitHub rate limited this request. Try again later.');
    if (code.includes('BAD_REQUEST')) return l('タイトル・本文と Issue の指定を確認してください。Issue のクローズはチェックボックスで指定します。',
        'Check the title, body and issue choice. Use the checkbox to select issue closure.');
    if (code.includes('PUSH_UNCONFIRMED')) return l('送信したブランチを GitHub で確認できませんでした。',
        'The pushed branch could not be verified on GitHub.');
    return l('PR の処理を完了できませんでした。接続と GitHub 上の状態を確認してください。',
        'Could not complete the pull request operation. Check the connection and GitHub state.');
}

export function renderProjectPublicationDialog(document: Document, locale: string, port: ProjectPublicationPort,
    commit: PublicationCommit, close: () => void, back: () => void) {
    const l: Localize = (ja, en) => locale.startsWith('ja') ? ja : en;
    const element = document.createElement('form');
    const field = (text: string, input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
        const label = document.createElement('label');
        label.textContent = text;
        label.append(input);
        return label;
    };
    const button = (text: string, onclick: () => void) => {
        const control = document.createElement('button');
        control.type = 'button';
        control.textContent = text;
        control.onclick = onclick;
        return control;
    };
    const input = (name: string, type = 'text') => {
        const control = document.createElement('input');
        control.name = name;
        control.type = type;
        return control;
    };
    const title = input('pr-title');
    title.required = true;
    title.maxLength = 256;
    title.value = commit.message.split('\n', 1)[0].slice(0, 256);
    const body = document.createElement('textarea');
    body.name = 'pr-body';
    body.rows = 4;
    const base = document.createElement('select');
    base.name = 'pr-base';
    base.required = true;
    const baseField = field(l('ベースブランチ', 'Base branch'), base);
    const useStack = input('pr-stack', 'checkbox');
    const stackField = field(l('既存 PR にスタックする', 'Stack on an existing pull request'), useStack);
    stackField.hidden = true;
    const parentNumber = input('pr-stack-parent', 'number');
    parentNumber.min = '1';
    parentNumber.step = '1';
    const parentStatus = document.createElement('p');
    parentStatus.setAttribute('role', 'status');
    const verifyParent = button(l('親 PR を確認', 'Verify parent pull request'), () => {
        if (!prepared?.stackParent || checkingParent || !useStack.checked) return;
        const number = parentNumber.valueAsNumber;
        if (!Number.isSafeInteger(number) || number < 1) return;
        checkingParent = true;
        parent = undefined;
        parentStatus.textContent = l('親 PR を確認中…', 'Checking the parent pull request…');
        render();
        void prepared.stackParent(number).then(value => {
            if (!open || !useStack.checked || parentNumber.valueAsNumber !== number) return;
            parent = value ?? undefined;
            parentStatus.textContent = parent ?
                l(`親 PR #${parent.number} · 最終ベース ${parent.targetBase}`,
                    `Parent PR #${parent.number} · final base ${parent.targetBase}`) :
                l('この PR を親にできません。GitHub で PR が開いていてスタックの先頭にあることを確認してください。',
                    'This PR cannot be used as the parent. Check that it is open and at the top of its stack on GitHub.');
        }, error => {if (open) parentStatus.textContent = errorText(error, l);}).finally(() => {
            checkingParent = false;
            render();
        });
    });
    const stackFields = document.createElement('div');
    stackFields.hidden = true;
    stackFields.append(field(l('親 PR の番号', 'Parent pull request number'), parentNumber), verifyParent, parentStatus);
    const issueMode = document.createElement('select');
    issueMode.name = 'pr-issue-mode';
    const option = (value: string, label: string) => {
        const item = document.createElement('option');
        item.value = value;
        item.textContent = label;
        return item;
    };
    const issueNumber = input('pr-issue-number', 'number');
    issueNumber.min = '1';
    issueNumber.step = '1';
    const issueTitle = input('pr-issue-title');
    issueTitle.maxLength = 256;
    const issueBody = document.createElement('textarea');
    issueBody.name = 'pr-issue-body';
    issueBody.rows = 3;
    const issueClose = input('pr-issue-close', 'checkbox');
    const merge = input('pr-merge', 'checkbox');
    const mergeField = field(l('CI とレビュー完了後にマージする', 'Merge after CI and review'), merge);
    const issueModeField = field(l('関連 Issue', 'Related issue'), issueMode);
    const issueNumberField = field(l('既存 Issue の番号', 'Existing issue number'), issueNumber);
    const issueTitleField = field(l('新規 Issue のタイトル', 'New issue title'), issueTitle);
    const issueBodyField = field(l('新規 Issue の本文', 'New issue body'), issueBody);
    const issueCloseField = field(l('PR のマージ後に Issue をクローズする', 'Close the issue after the PR merges'), issueClose);
    const fields = document.createElement('div');
    fields.hidden = true;
    fields.append(baseField, stackField, stackFields, field(l('PR タイトル', 'PR title'), title),
        field(l('PR 本文', 'PR body'), body), issueModeField, issueNumberField, issueTitleField, issueBodyField,
        issueCloseField, mergeField);
    const references = document.createElement('div');
    references.hidden = true;
    const details = document.createElement('dl');
    references.append(details);
    const addDetail = (name: string) => {
        const label = document.createElement('dt');
        label.textContent = name;
        const value = document.createElement('dd');
        const code = document.createElement('code');
        code.style.overflowWrap = 'anywhere';
        value.append(code);
        details.append(label, value);
        return code;
    };
    const remoteText = addDetail(l('リポジトリ', 'Repository'));
    const headText = addDetail(l('ヘッド', 'Head'));
    const baseText = addDetail(l('ベース', 'Base'));
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = l('リポジトリを確認中…', 'Checking the repository…');
    const alert = document.createElement('p');
    alert.setAttribute('role', 'alert');
    const links = document.createElement('p');
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = l('PR をキューに登録', 'Queue pull request');
    submit.hidden = true;
    const resume = button(l('処理を再開', 'Resume publication'), () =>
        prepared?.resume(prepared.progress().job?.pause === 'mergeRejected'));
    resume.hidden = true;
    const closeButton = button(l('閉じる', 'Close'), close);
    element.append(references, fields, status, alert, links, dialogActions(document,
        button(l('コミットに戻る', 'Back to commits'), back), dialogAction(closeButton, 'close'),
        dialogAction(submit, 'confirm'), dialogAction(resume, 'confirm')));

    let prepared: PreparedPublication | undefined;
    let stopListening: (() => void) | undefined;
    let open = true;
    let busy = false;
    let checkingParent = false;
    let parent: PublicationStackParent | undefined;
    const showIssueFields = () => {
        const newIssue = issueMode.value === 'new';
        const existingIssue = issueMode.value === 'existing';
        issueNumberField.hidden = !existingIssue;
        issueNumber.required = existingIssue;
        issueTitleField.hidden = issueBodyField.hidden = !newIssue;
        issueTitle.required = newIssue;
        issueCloseField.hidden = !(newIssue || existingIssue) ||
            !prepared?.capabilities.includes('issues-write') || !prepared?.capabilities.includes('checks-read');
        if (issueCloseField.hidden) issueClose.checked = false;
    };
    issueMode.onchange = showIssueFields;
    const displayBase = (name: string, oid: string) => {baseText.textContent = name ? name + ' · ' + oid : '—';};
    const displaySelectedBase = () => {
        if (useStack.checked) displayBase(parent?.head ?? '', parent?.headOid ?? '');
        else displayBase(base.value, prepared?.branches.find(branch => branch.name === base.value)?.oid ?? '');
    };
    base.onchange = displaySelectedBase;
    useStack.onchange = parentNumber.oninput = () => {
        parent = undefined;
        parentStatus.textContent = '';
        render();
    };
    function render() {
        if (!open || !prepared) return;
        const {job, running, error, approvalIntent} = prepared.progress();
        const stacking = useStack.checked;
        baseField.hidden = stacking;
        base.disabled = stacking;
        stackFields.hidden = !stacking;
        verifyParent.disabled = checkingParent || busy || !(parentNumber.valueAsNumber >= 1);
        parentNumber.disabled = !stacking || busy;
        fields.hidden = Boolean(job || approvalIntent);
        submit.hidden = Boolean(job);
        submit.disabled = busy || (!approvalIntent && (stacking ? !parent : !base.value));
        submit.textContent = approvalIntent ? l('ブラウザーで承認を再開…', 'Resume approval in browser…') :
            prepared.approval === 'browser' ? l('ブラウザーで確認して承認…', 'Review and approve in browser…') :
                l('PR をキューに登録', 'Queue pull request');
        if (!job) {
            links.replaceChildren();
            resume.hidden = true;
            if (approvalIntent) displayBase(approvalIntent.base, approvalIntent.baseOid);
            else displaySelectedBase();
            if (approvalIntent && !busy) status.textContent = l(`承認待ち · ${approvalIntent.title}`, `Awaiting approval · ${approvalIntent.title}`);
            return;
        }
        displayBase(job.intent.base, job.intent.baseOid);
        status.textContent = progressText(job, l);
        alert.textContent = error ? errorText(error, l) : pauseText(job.awaitingPush ? undefined : job.pause, l);
        resume.hidden = running || job.status === 'done';
        resume.textContent = job.pause === 'mergeRejected' ? l('マージを再試行', 'Retry merge') :
            l('処理を再開', 'Resume publication');
        const web = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(job.intent.remote) ?
            job.intent.remote.replace(/\.git$/u, '') : null;
        const link = (path: string, number: number, label: string) => {
            const anchor = document.createElement('a');
            anchor.href = web + '/' + path + '/' + number;
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
            anchor.textContent = label + ' #' + number;
            return anchor;
        };
        links.replaceChildren();
        if (web && job.pullNumber) links.append(link('pull', job.pullNumber, 'PR'));
        if (web && job.issueNumber) links.append(' ', link('issues', job.issueNumber, 'Issue'));
        if (web && job.intent.stackParent) links.append(' ', link('pull', job.intent.stackParent.number, l('親 PR', 'Parent PR')));
    }
    element.onsubmit = event => {
        event.preventDefault();
        if (!prepared || busy || prepared.progress().job) return;
        const {approvalIntent} = prepared.progress();
        if (!approvalIntent && (!title.value.trim() || useStack.checked && !parent)) return;
        let issue: PublicationIssue | undefined;
        if (!approvalIntent && issueMode.value === 'existing') {
            const number = issueNumber.valueAsNumber;
            if (!Number.isSafeInteger(number) || number < 1) return;
            issue = {number, closeAfterMerge: issueClose.checked};
        } else if (!approvalIntent && issueMode.value === 'new') {
            if (!issueTitle.value.trim()) return;
            issue = {title: issueTitle.value.trim(), body: issueBody.value, closeAfterMerge: issueClose.checked};
        }
        busy = true;
        alert.textContent = '';
        if (prepared.approval === 'browser') status.textContent = l('ブラウザーの承認画面で内容を確認してください。',
            'Review and approve the publication in the browser window.');
        render();
        const current = () => open && element.isConnected;
        const submitted = approvalIntent ? prepared.approvePending!(current) :
            prepared.submit({base: useStack.checked ? parent!.head : base.value, title: title.value.trim(), body: body.value,
                goal: merge.checked ? 'merge' : 'pr', issue, ...(useStack.checked && {stackParent: parent})}, current);
        void submitted.then(
            approved => {if (open && !approved) status.textContent = l('PR の登録をキャンセルしました。', 'PR registration was cancelled.');},
            error => {if (open) alert.textContent = errorText(error, l);}
        ).finally(() => {busy = false; render();});
    };
    void port.prepare(commit).then(publication => {
        if (!open) return;
        prepared = publication;
        stackField.hidden = !publication.stackParent;
        remoteText.textContent = publication.remote;
        headText.textContent = publication.head + ' · ' + commit.commitOid;
        references.hidden = false;
        const candidates = publication.branches.filter(branch => branch.oid !== commit.commitOid &&
            !branch.name.startsWith('tw-plus/pr-'));
        base.replaceChildren(...candidates.map(branch => option(branch.name, branch.name)));
        if (publication.defaultBranch && candidates.some(branch => branch.name === publication.defaultBranch)) {
            base.value = publication.defaultBranch;
        }
        else if (candidates.length > 1) {
            base.prepend(option('', l('ブランチを選ぶ', 'Choose a branch')));
            base.value = '';
        }
        displaySelectedBase();
        issueMode.replaceChildren(option('none', l('関連付けなし', 'None')));
        if (publication.capabilities.includes('issues-read')) {
            issueMode.append(option('existing', l('既存 Issue', 'Existing issue')));
            if (publication.capabilities.includes('issues-write')) issueMode.append(option('new', l('新規 Issue', 'New issue')));
        }
        issueModeField.hidden = issueMode.options.length < 2;
        showIssueFields();
        mergeField.hidden = !publication.capabilities.includes('merge') || !publication.capabilities.includes('checks-read');
        status.textContent = candidates.length || publication.stackParent || publication.progress().job ? '' :
            l('選べるベースブランチがありません。', 'There are no eligible base branches.');
        stopListening = publication.subscribe(render);
        render();
    }, error => {
        if (!open) return;
        status.textContent = '';
        alert.textContent = errorText(error, l);
    });
    return {element, dispose() {open = false; stopListening?.();}};
}
