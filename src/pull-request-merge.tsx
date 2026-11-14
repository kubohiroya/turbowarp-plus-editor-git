import React, {useEffect, useRef, useState} from 'react';
import type {MergeCondition, PullRequestObservation} from './pull-request-queue.js';
import type {PullRequestMergePort} from './publication-ui-port.js';

const en = {
    pending: 'CI pending', failed: 'CI failed', passed: 'CI passed', absent: 'No CI checks', unknown: 'CI status unavailable',
    ready: 'Ready to merge', blocked: 'Merge requirements are pending', conflicting: 'Resolve merge conflicts',
    closed: 'Closed', draft: 'Draft', checks: 'Checks', reviews: 'Reviews',
    review: {approved: 'Approved', changesRequested: 'Changes requested', required: 'Approval required',
        none: 'No approvals required', unknown: 'Review status unavailable'},
    submit: 'Squash and merge', confirm: 'Squash merge PR #{number} into {base} on {repository}?',
    closesIssues: 'GitHub will close linked issues when this PR merges.',
    merged: 'Merged', accepted: 'Merge requested', rejected: 'This PR cannot be merged in its current state.',
    error: 'The merge result could not be confirmed. Refresh the status before retrying.',
    unavailable: 'Merge status is unavailable for this connection.'
};
const ja: typeof en = {
    pending: 'CI 待機・実行中', failed: 'CI 失敗', passed: 'CI 成功', absent: 'CI チェックなし', unknown: 'CI 状態未確認',
    ready: 'マージ可能', blocked: 'マージ条件を確認してください', conflicting: '競合を解消してください',
    closed: 'クローズ済み', draft: 'ドラフト', checks: 'チェック', reviews: 'レビュー',
    review: {approved: '承認済み', changesRequested: '変更が必要', required: '承認が必要',
        none: '承認は不要', unknown: 'レビュー状況は未確認'},
    submit: 'スカッシュしてマージ', confirm: '{repository} の PR #{number} を {base} にスカッシュマージしますか？',
    closesIssues: 'マージすると、GitHub が関連する Issue をクローズします。',
    merged: 'マージ済み', accepted: 'マージをリクエストしました。', rejected: '現在の条件ではマージできません。',
    error: 'マージ結果を確認できませんでした。状態を再取得してから操作してください。',
    unavailable: 'この接続ではマージ状態を確認できませんでした。'
};
export const pullRequestMergeLabels = (locale: string) => locale.startsWith('ja') ? ja : en;

export function PullRequestMerge({remote, observation, publication, locale}: {
    remote: string; observation: PullRequestObservation; publication?: PullRequestMergePort; locale: string;
}) {
    const labels = pullRequestMergeLabels(locale);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<'merged' | 'accepted' | 'rejected' | 'error'>();
    const active = useRef(true);
    useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
    const submit = publication?.mergePullRequest;
    const allowNoChecks = observation.checks === 'absent';
    const ready = observation.state === 'open' && observation.mergeable === 'ready' && !!observation.diffDigest &&
        (allowNoChecks || observation.checks === 'passed') &&
        (observation.review === 'approved' || observation.review === 'none') && !observation.downstackOpen;
    const merge = async (event: React.MouseEvent<HTMLButtonElement>) => {
        if (!submit || !ready || busy || result) return;
        const window = event.currentTarget.ownerDocument.defaultView;
        const message = labels.confirm.replace('{number}', String(observation.number)).replace('{base}', observation.base)
            .replace('{repository}', remote) + '\n\n' + observation.head + ' @ ' + observation.headOid.slice(0, 12) +
            '\n' + labels[observation.checks] + (observation.closesOtherIssues ? '\n' + labels.closesIssues : '');
        if (!window?.confirm(message)) return;
        const expected: MergeCondition = {number: observation.number, head: observation.head, base: observation.base,
            headOid: observation.headOid, baseOid: observation.baseOid, diffDigest: observation.diffDigest!, allowNoChecks};
        setBusy(true);
        try {
            const response = await submit(remote, expected);
            if (active.current) setResult(response.state);
        } catch {if (active.current) setResult('error');}
        finally {if (active.current) setBusy(false);}
    };
    const status = observation.state !== 'open' ? labels[observation.state] :
        ready ? labels.ready : observation.mergeable === 'conflicting' ? labels.conflicting : labels.blocked;
    return <section className="twgit-merge-actions" aria-label={status}>
        <div className="twgit-merge-summary" data-ready={ready && !result || undefined}>
            {result ? <strong role={result === 'error' || result === 'rejected' ? 'alert' : 'status'}>{labels[result]}</strong> :
                <strong>{status}</strong>}
            {ready && submit && !result && <button className="twgit-merge-submit" type="button" disabled={busy}
                onClick={event => void merge(event)}>{labels.submit}</button>}
        </div>
        <dl>
            <div><dt>{labels.checks}</dt><dd>{labels[observation.checks]}</dd></div>
            <div><dt>{labels.reviews}</dt><dd>{labels.review[observation.review]}</dd></div>
        </dl>
    </section>;
}
