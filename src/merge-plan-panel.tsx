import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {GitPanelError} from './filesystem.js';
import {duplicateMergePlan, type MergePlan, type MergePlanBranch} from './merge-plan.js';
import {labelsFor} from './messages.js';

const words = {
    en: {
        title: 'Merge plans', target: 'Merge into', from: 'Bring in from', choose: 'Choose a branch',
        create: 'Create candidate', duplicate: 'Duplicate', play: 'Playtest', candidate: 'Candidate',
        copiedFrom: 'Copied from', unconfirmed: 'Unconfirmed changes', problems: 'Project issues',
        loading: 'Reading branches…', empty: 'No other local or fetched branches.',
        help: 'Try a candidate in a separate player. Candidates are kept while this project stays open.',
        mergePlanNoBase: 'No common commit was found. Fetch more of the history and try again.',
        mergePlanMultipleBases: 'These branches have more than one common starting point.'
    },
    ja: {
        title: 'マージプラン', target: '取り込み先', from: '取り込み元', choose: 'ブランチを選ぶ',
        create: '候補を作成', duplicate: '複製', play: '試遊', candidate: '候補',
        copiedFrom: '複製元', unconfirmed: '未確認の変更', problems: '作品データの問題',
        loading: 'ブランチを読み込み中…', empty: 'ほかのローカルブランチや取得済みブランチがありません。',
        help: '候補を別のプレーヤーで試せます。候補はこの作品を開いている間保持されます。',
        mergePlanNoBase: '共通のコミットが見つかりません。履歴を取得してからやり直してください。',
        mergePlanMultipleBases: 'このブランチには共通の起点が複数あります。'
    }
};

export interface MergePlanSession {
    plans: MergePlan[];
}

interface Props {
    document: Document;
    locale: string;
    session: MergePlanSession;
    branch?: string;
    head: string | null;
    branches(current: string): Promise<MergePlanBranch[]>;
    create(expected: {branch: string; head: string}, from: string): Promise<MergePlan>;
    play(plan: MergePlan, title: string): Promise<void>;
}

export function MergePlanPanel({document, locale, session, branch, head, branches, create, play}: Props) {
    const text = locale.startsWith('ja') ? words.ja : words.en;
    const labels = labelsFor(locale);
    const [open, setOpen] = useState(false);
    const [available, setAvailable] = useState<MergePlanBranch[]>();
    const [selected, setSelected] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [, redraw] = useState(0);
    const dialog = useRef<HTMLDialogElement>(null);
    const operation = useRef(false);
    const activeSession = useRef<MergePlanSession | null>(session);
    activeSession.current = session;
    useEffect(() => () => {activeSession.current = null;}, []);
    const branchReader = useRef(branches);
    branchReader.current = branches;

    useEffect(() => {
        const current = dialog.current;
        if (open && current && !current.open) current.showModal();
    }, [open]);
    useEffect(() => {
        if (!open || !branch || !head) return;
        let active = true;
        setAvailable(undefined);
        void branchReader.current(branch).then(next => {
            if (active) setAvailable(next);
        }, () => {
            if (!active) return;
            setAvailable([]);
            setError(labels.failed);
        });
        return () => {active = false;};
    }, [open, branch, head, session, labels.failed]);

    const name = (index: number) => `${text.candidate} ${index + 1}`;
    const message = (failure: unknown) => {
        if (!(failure instanceof GitPanelError)) return labels.failed;
        const {code} = failure;
        if (code === 'mergePlanNoBase' || code === 'mergePlanMultipleBases') return text[code];
        const localized = labels[code as keyof typeof labels];
        return typeof localized === 'string' ? localized : labels.failed;
    };
    const act = async (action: () => Promise<void>) => {
        if (operation.current) return;
        operation.current = true;
        setBusy(true);
        setError('');
        try {
            await action();
        } catch (failure) {
            if (activeSession.current === session) setError(message(failure));
        } finally {
            operation.current = false;
            if (activeSession.current) setBusy(false);
        }
    };
    const add = (plan: MergePlan) => {
        if (activeSession.current !== session) return;
        session.plans.push(plan);
        redraw(value => value + 1);
    };
    const branchRef = available?.some(item => item.ref === selected) ? selected : '';
    const close = () => {
        setOpen(false);
        setAvailable(undefined);
        setSelected('');
        setError('');
    };
    return <>
        <button type="button" className="twgit-panel-action" disabled={(!branch || !head) && !session.plans.length}
            onClick={() => setOpen(true)}>{text.title}</button>
        {open && createPortal(<dialog ref={dialog} aria-label={text.title} className="twgit-merge-plan-dialog"
            onClose={close} onCancel={event => {if (busy) event.preventDefault();}}>
            <h2>{text.title}</h2>
            <p>{text.help}</p>
            {branch && head && <form className="twgit-merge-plan-create" onSubmit={event => {
                event.preventDefault();
                if (branchRef) void act(async () => add(await create({branch, head}, branchRef)));
            }}>
                <p>{text.target} <code>{branch}</code> <small>{head.slice(0, 12)}</small></p>
                <label>{text.from}{' '}
                    <select value={branchRef} disabled={busy || !available?.length}
                        onChange={event => setSelected(event.currentTarget.value)}>
                        <option value="">{text.choose}</option>
                        {available?.map(item => <option key={item.ref} value={item.ref}>{item.name}</option>)}
                    </select>
                </label>
                <button type="submit" disabled={busy || !branchRef}>{text.create}</button>
                {!available && <p role="status">{text.loading}</p>}
                {!!available && !available.length && !error && <p>{text.empty}</p>}
            </form>}
            {busy && <p role="status">{labels.loading}</p>}
            {error && <p role="alert">{error}</p>}
            {session.plans.map((plan, index) => {
                const title = name(index);
                const parent = session.plans.findIndex(item => item.id === plan.parentId);
                return <section key={plan.id} aria-label={title} className="twgit-merge-candidate">
                    <h3>{title}</h3>
                    <p><code>{plan.inputs.incoming.name} @{plan.inputs.incoming.oid.slice(0, 8)}</code> →{' '}
                        <code>{plan.inputs.current.name} @{plan.inputs.current.oid.slice(0, 8)}</code>
                        {parent >= 0 && <small> · {text.copiedFrom} {name(parent)}</small>}</p>
                    {plan.conflicts.length > 0 && <details>
                        <summary>{text.unconfirmed} · {plan.conflicts.length}</summary>
                        <ul>{plan.conflicts.map(conflict => <li key={conflict.id}><code>{conflict.path}</code></li>)}</ul>
                    </details>}
                    {plan.problems > 0 && <p>{text.problems} · {plan.problems}</p>}
                    <div className="twgit-merge-plan-actions">
                        <button type="button" disabled={busy} onClick={() => add(duplicateMergePlan(plan))}>{text.duplicate}</button>
                        <button type="button" disabled={busy} onClick={() => void act(() => play(plan, `${text.play} · ${title}`))}>
                            {text.play}</button>
                    </div>
                </section>;
            })}
            <form method="dialog" className="twgit-merge-plan-actions">
                <button type="submit" disabled={busy}>{labels.close}</button>
            </form>
        </dialog>, document.body)}
    </>;
}
