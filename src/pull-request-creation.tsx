import React, {useEffect, useRef, useState} from 'react';
import {GitPanelError} from './filesystem.js';
import {inspectPublicationRepository, preparePublicationCommit, publicationCommits} from './publish-ref.js';
import type {PublicationRepository} from './publish-ref.js';
import type {PreparedPublication, PullRequestPublication} from './publication-ui-port.js';
import type {GetRemoteSession} from './remote-operations.js';
import type {Commit, Repository} from './repository.js';
import {remoteUrl} from './smart-http.js';

const en = {
    base: 'Base branch', commits: 'Commits to include', title: 'PR title',
    description: 'PR description', submit: 'Create PR', select: 'Include {commit} in the PR',
    loading: 'Reading the branches and commits…', prepare: 'Prepare PR', pending: 'Creating the PR…',
    refresh: 'Refresh branches', edit: 'Edit PR', noCommits: 'There are no eligible commits on this branch for the selected base.',
    unavailable: 'PR creation needs a GitHub connection with write access.',
    unsupported: 'This GitHub connection does not support creating PRs.',
    failed: 'Could not create the PR. Check the GitHub connection and the selected branch.',
    conflict: 'The selected commits could not be applied to the base. Include their dependencies or choose another base.',
    changed: 'The selected branch changed. Refresh the branches and select the commits again.',
    retry: 'Check publication status', canceled: 'PR creation was canceled.', approve: 'Continue to GitHub to approve',
    ready: 'Confirm the selected commits and create the PR.', created: 'Open PR #{number} on GitHub'
};
const ja: typeof en = {
    base: '反映先のブランチ', commits: 'PRに含めるコミット', title: 'PRのタイトル',
    description: 'PRの説明', submit: 'PRを作成', select: '{commit} をPRに含める',
    loading: 'ブランチとコミットを読み込み中…', prepare: 'PRの内容を確認', pending: 'PRを作成中…',
    refresh: 'ブランチを再取得', edit: 'PRの内容を編集', noCommits: '選んだ反映先に追加できるコミットはありません。',
    unavailable: 'PRを作成するには、書き込みを許可してGitHubに接続してください。',
    unsupported: 'このGitHub接続ではPRを作成できません。',
    failed: 'PRを作成できませんでした。GitHub接続と、選んだブランチを確認してください。',
    conflict: '選んだコミットを反映先に適用できませんでした。必要なコミットも含めるか、反映先を選び直してください。',
    changed: 'ブランチが変更されました。ブランチを再取得し、コミットを選び直してください。',
    retry: '作成状況を確認', canceled: 'PRの作成を取り消しました。', approve: 'GitHubで内容を承認',
    ready: '選んだコミットと説明を確認して、PRを作成します。', created: 'GitHubでPR #{number}を開く'
};

export function PullRequestCreation({repository, head, locale, publication, getSession, connected, isCurrent}: {
    repository: Repository; head: string | null; locale: string; publication?: PullRequestPublication;
    getSession?: GetRemoteSession; connected: boolean; isCurrent(): boolean;
}) {
    const labels = locale.startsWith('ja') ? ja : en;
    const [target, setTarget] = useState<PublicationRepository>();
    const [base, setBase] = useState('');
    const [commits, setCommits] = useState<Commit[]>();
    const [chosen, setChosen] = useState<Set<string>>(new Set());
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [prepared, setPrepared] = useState<PreparedPublication>();
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string>();
    const [, update] = useState(0);
    const mounted = useRef(true);
    useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
    const current = () => mounted.current && isCurrent();
    const guard = () => {if (!current()) throw new GitPanelError('changed');};
    const status = prepared?.progress();
    useEffect(() => prepared?.subscribe(() => update(value => value + 1)), [prepared]);
    const origin = useRef<PublicationRepository>();
    const inspect = async () => {
        guard();
        const next = await inspectPublicationRepository({root: repository.root, getSession: getSession!, guard, write: false});
        origin.current = next;
        return next;
    };
    const refresh = async () => {
        setTarget(undefined);
        setPrepared(undefined);
        setError(undefined);
        if (!publication || !getSession) return;
        try {
            const next = await inspect();
            if (!current()) return;
            setBase(previous => next.branches.some(branch => branch.name === previous) ? previous :
                next.defaultBranch ?? next.branches[0]?.name ?? '');
            setTarget(next);
        } catch {if (current()) setError(labels.unavailable);}
    };
    useEffect(() => {
        if (connected && publication && getSession) void refresh();
    }, [repository, head, connected, publication, getSession]);
    useEffect(() => {
        const selected = target?.branches.find(branch => branch.name === base);
        if (!selected || !head || !getSession) return;
        let active = true;
        setCommits(undefined);
        setChosen(new Set());
        setPrepared(undefined);
        setError(undefined);
        void publicationCommits(repository.root, head, selected, getSession, () => {
            guard();
            if (!active) throw new GitPanelError('changed');
        }).then(list => {if (active && current()) setCommits(list);}, () => {
            if (active && current()) setError(labels.failed);
        });
        return () => {active = false;};
    }, [repository, head, target, base, getSession, labels]);

    const prepare = async () => {
        if (!target || !publication || !getSession || submitting) return;
        const branch = target.branches.find(branch => branch.name === base);
        const selection = commits?.filter(commit => chosen.has(commit.oid)).reverse();
        if (!branch || !selection?.length || !title.trim()) return;
        setSubmitting(true);
        setError(undefined);
        try {
            const commitOid = await preparePublicationCommit(repository.root, branch.oid, selection.map(commit => commit.oid), guard);
            const next = await publication.prepare({root: repository.root, guard,
                commit: {id: crypto.randomUUID(), message: title, commitOid}});
            if (next.remote !== target.remote || next.branches.find(ref => ref.name === base)?.oid !== branch.oid)
                throw new GitPanelError('changed');
            if (!next.capabilities.includes('pulls-write')) throw new Error('UNAVAILABLE');
            if (current()) setPrepared(next);
        } catch (failure) {
            if (current()) setError(failure instanceof GitPanelError ?
                failure.code === 'publicationConflict' ? labels.conflict : failure.code === 'changed' ? labels.changed : labels.failed :
                labels.failed);
        } finally {if (current()) setSubmitting(false);}
    };
    const submit = async () => {
        if (!prepared || submitting) return;
        setSubmitting(true);
        setError(undefined);
        try {
            const accepted = status?.approvalIntent && prepared.approvePending ?
                await prepared.approvePending(current) :
                await prepared.submit({base, title: title.trim(), body: body.trim(), goal: 'pr'}, current);
            if (!accepted && current()) setError(labels.canceled);
        } catch {if (current()) setError(labels.failed);}
        finally {if (current()) setSubmitting(false);}
    };
    const job = status?.job;
    const created = job?.status === 'done' && job.pullNumber;
    const href = created && origin.current ? remoteUrl(origin.current.remote).replace(/\.git$/u, '') + '/pull/' + created : undefined;
    const busy = submitting || status?.running;
    return <section className="twgit-pr-create" aria-label={labels.commits}>
        {!publication || !getSession ? <p>{labels.unsupported}</p> : !connected ? <p>{labels.unavailable}</p> : <>
            {error && <p className="twgit-error" role="alert">{error}</p>}
            {!target && !error && <p role="status">{labels.loading}</p>}
            {!job && <button type="button" disabled={busy} onClick={() => {
                if (prepared) setPrepared(undefined);
                else void refresh();
            }}>{prepared ? labels.edit : labels.refresh}</button>}
            {target && <form onSubmit={event => {event.preventDefault(); void (prepared ? submit() : prepare());}}>
                <label>{labels.base}
                    <select value={base} disabled={busy || !!prepared} onChange={event => setBase(event.currentTarget.value)}>
                        {target.branches.map(branch => <option key={branch.name}>{branch.name}</option>)}
                    </select>
                </label>
                <fieldset disabled={busy || !!prepared}>
                    <legend>{labels.commits}</legend>
                    {!commits && !error && <p role="status">{labels.loading}</p>}
                    {commits?.length === 0 && <p>{labels.noCommits}</p>}
                    {commits?.map(commit => <label key={commit.oid} className="twgit-pr-commit" title={commit.oid}>
                        <input type="checkbox" aria-label={labels.select.replace('{commit}', commit.message)}
                            checked={chosen.has(commit.oid)} onChange={event => {
                                const next = new Set(chosen);
                                if (event.currentTarget.checked) next.add(commit.oid);
                                else next.delete(commit.oid);
                                setChosen(next);
                            }}/>
                        <span>{commit.message} <small>{commit.oid.slice(0, 8)}</small></span>
                    </label>)}
                    <label>{labels.title}<input required maxLength={256} value={title}
                        onChange={event => setTitle(event.currentTarget.value)}/></label>
                    <label>{labels.description}<textarea rows={3} maxLength={16000} value={body}
                        onChange={event => setBody(event.currentTarget.value)}/></label>
                </fieldset>
                {busy && <p role="status">{prepared ? labels.pending : labels.loading}</p>}
                {prepared && !job && !busy && <p>{labels.ready}</p>}
                {(status?.error || job?.pause) && <p className="twgit-error" role="alert">{labels.failed}</p>}
                {href && <a href={href} target="_blank" rel="noreferrer">{labels.created.replace('{number}', String(created))}</a>}
                {job && !href && !busy && <button type="button" onClick={() => prepared?.resume()}>{labels.retry}</button>}
                {!job && <button type="submit" className="twgit-primary" disabled={busy || !chosen.size || !title.trim()}>
                    {status?.approvalIntent ? labels.approve : prepared ? labels.submit : labels.prepare}
                </button>}
            </form>}
        </>}
    </section>;
}
