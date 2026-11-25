import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {GitPanelError} from './filesystem.js';
import {duplicateMergePlan, editMergePlan, mergePlanConflictResolved, reviseMergePlan, type MergePlan, type MergePlanBranch,
    type MergePlanBuild, type MergePlanChoices, type MergePlanCodeEdit, type MergePlanFiles} from './merge-plan.js';
import type {MergePlanJournal, MergePlanScope} from './merge-plan-journal.js';
import {mergePlanImportLimit, prepareMergePlanImport, type MergePlanImport} from './merge-plan-import.js';
import {mergePlaytestRequest, type MergePlaytestRequest} from './merge-playtest.js';
import {createMergePlanPlaytest, createMergePlanReader, type MergePlanSharePort} from './merge-plan-sharing.js';
import type {PlaytestObserver} from './merge-playtest-observation.js';
import type {MergeSide} from './project-source-merge.js';
import {labelsFor} from './messages.js';

const words = {
    en: {
        title: 'Merge plans', target: 'Merge into', from: 'Bring in from', choose: 'Choose a branch',
        create: 'Create candidate', duplicate: 'Duplicate', play: 'Playtest', candidate: 'Candidate',
        copiedFrom: 'Copied from', unconfirmed: 'Unconfirmed changes', problems: 'Project issues',
        loading: 'Reading branches…', empty: 'No other local or fetched branches.',
        help: 'Choose a side to save a new generation, or playtest a saved generation in a separate player.',
        temporary: 'This folder supports session storage only. Candidates are kept until you reload or close the Editor.',
        storageFailed: 'Could not load or save the merge plans. The previous generations are unchanged.',
        edit: 'Choose versions for conflicting changes', generation: 'Generation', save: 'Save as new generation',
        editCode: 'Edit blocks', edited: 'Edited in the block editor',
        importCandidate: 'Import a revised candidate', importFile: 'Candidate changes file', importBase: 'Base generation ID',
        importContent: 'Base content ID', importReview: 'Review the file changes before saving this generation.',
        importResolutions: 'Use the imported changes for these conflicts', imported: 'Includes imported changes',
        add: 'Add', replace: 'Replace', delete: 'Delete', cancelImport: 'Cancel import',
        mergePlanImportFormat: 'Choose a version 1 candidate changes JSON file within the size limit.',
        mergePlanImportBase: 'Select the generation named by the file, or ask for changes based on this generation.',
        mergePlanImportInvalid: 'The imported project has invalid references, files or conflict resolutions.',
        mergePlanImportUnchanged: 'The file makes no changes to this generation.',
        mergePlanEditConflict: 'The new choice overlaps a manual edit. Choose it in an earlier generation, or keep the manual edit.',
        provisional: 'Unconfirmed', base: 'Common base', current: 'Current', incoming: 'Incoming',
        mergePlanNoBase: 'No common commit was found. Fetch more of the history and try again.',
        mergePlanMultipleBases: 'These branches have more than one common starting point.',
        share: 'Share via MCP', stopShare: 'Stop MCP sharing', token: 'MCP bearer token',
        sharing: 'This connection can read saved generations, debugger state, requested variables and recent logs for this project.'
    },
    ja: {
        title: 'マージプラン', target: '取り込み先', from: '取り込み元', choose: 'ブランチを選ぶ',
        create: '候補を作成', duplicate: '複製', play: '試遊', candidate: '候補',
        copiedFrom: '複製元', unconfirmed: '未確認の変更', problems: '作品データの問題',
        loading: 'ブランチを読み込み中…', empty: 'ほかのローカルブランチや取得済みブランチがありません。',
        help: '競合箇所の採用元を選んで新しい世代を保存し、保存した世代を別のプレーヤーで試せます。',
        temporary: 'このフォルダの候補は、Editorを再読み込みするか閉じるまで保持されます。',
        storageFailed: 'マージプランを読み込みまたは保存できませんでした。保存済みの世代は残っています。',
        edit: '競合箇所の採用元を選ぶ', generation: '世代', save: '新しい世代として保存',
        editCode: 'ブロックを編集', edited: 'ブロックを直接編集済み',
        importCandidate: '修正候補を取り込む', importFile: '修正候補のファイル', importBase: '元の世代ID',
        importContent: '元の内容ID', importReview: 'ファイルの変更を確認してから、新しい世代として保存してください。',
        importResolutions: '次の競合に取り込んだ変更を採用する', imported: '外部から取り込んだ変更を含む',
        add: '追加', replace: '置換', delete: '削除', cancelImport: '取り込みをキャンセル',
        mergePlanImportFormat: '形式がバージョン1で、サイズ上限内の修正候補JSONを選んでください。',
        mergePlanImportBase: 'ファイルが指定する元の世代を選ぶか、この世代を元にした修正を用意してください。',
        mergePlanImportInvalid: '取り込んだ作品の参照・ファイル・競合の指定に問題があります。',
        mergePlanImportUnchanged: 'この世代に取り込める変更がありません。',
        mergePlanEditConflict: '採用元の変更と直接編集が重なっています。前の世代で採用元を選ぶか、直接編集の内容を残してください。',
        provisional: '未確認', base: '共通の元', current: '取り込み先', incoming: '取り込み元',
        mergePlanNoBase: '共通のコミットが見つかりません。履歴を取得してからやり直してください。',
        mergePlanMultipleBases: 'このブランチには共通の起点が複数あります。',
        share: 'MCPで共有', stopShare: 'MCP共有を停止', token: 'MCPアクセストークン',
        sharing: 'この接続で、この作品の保存済み世代、試遊の停止位置、指定された変数・リスト、直近のログを読み取れます。'
    }
};

interface Props {
    document: Document;
    locale: string;
    context: object;
    journal: MergePlanJournal;
    persistent: boolean;
    branch?: string;
    head: string | null;
    branches(current: string): Promise<MergePlanBranch[]>;
    scope(): Promise<MergePlanScope & {guard(): void}>;
    create(expected: {branch: string; head: string}, from: string): Promise<MergePlanBuild>;
    play(plan: MergePlan, files: MergePlanFiles, title: string, playtest: MergePlaytestRequest, observe?: PlaytestObserver): Promise<void>;
    share?: MergePlanSharePort;
    validate?(files: MergePlanFiles): void;
    edit?(plan: MergePlan, files: MergePlanFiles, title: string, save: (edit: MergePlanCodeEdit) => Promise<string>):
        Promise<string | undefined>;
}

export function MergePlanPanel({document, locale, context, journal, persistent, branch, head, branches, scope, create, play, edit,
    share, validate}: Props) {
    const text = locale.startsWith('ja') ? words.ja : words.en;
    const labels = labelsFor(locale);
    const [open, setOpen] = useState(false);
    const [available, setAvailable] = useState<MergePlanBranch[]>();
    const [selected, setSelected] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [plans, setPlans] = useState<MergePlan[]>();
    const [storageError, setStorageError] = useState(false);
    const dialog = useRef<HTMLDialogElement>(null);
    const operation = useRef(false);
    const activeContext = useRef<object | null>(context);
    activeContext.current = context;
    useEffect(() => () => {activeContext.current = null;}, []);
    const branchReader = useRef(branches);
    branchReader.current = branches;
    const scopeReader = useRef(scope);
    scopeReader.current = scope;
    const playtest = useMemo(createMergePlanPlaytest, [context]);
    const [connection, setConnection] = useState<{url: string; token: string; context: object}>();
    const sharing = connection?.context === context ? connection : undefined;
    useEffect(() => {
        if (!sharing || !share) return;
        return () => {void share.stop(sharing.token).catch(() => {});};
    }, [share, sharing]);

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
    }, [open, branch, head, context, labels.failed]);
    useEffect(() => {
        if (!open) return;
        let active = true;
        setPlans(undefined);
        setStorageError(false);
        void scopeReader.current().then(async current => {
            const saved = await journal.list(current);
            current.guard();
            if (active) setPlans(saved);
        }).catch(() => {
            if (active) setStorageError(true);
        });
        return () => {active = false;};
    }, [open, context, journal]);

    const name = (index: number) => `${text.candidate} ${index + 1}`;
    const message = (failure: unknown) => {
        if (!(failure instanceof GitPanelError)) return labels.failed;
        const {code} = failure;
        if (Object.hasOwn(text, code)) return text[code as keyof typeof text];
        const localized = labels[code as keyof typeof labels];
        return typeof localized === 'string' ? localized : labels.failed;
    };
    const act = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
        if (operation.current) return undefined;
        operation.current = true;
        setBusy(true);
        setError('');
        try {
            const result = await action();
            return activeContext.current === context ? result : undefined;
        } catch (failure) {
            if (activeContext.current === context) setError(failure instanceof DOMException ? text.storageFailed : message(failure));
        } finally {
            operation.current = false;
            if (activeContext.current) setBusy(false);
        }
    };
    const add = async (plan: MergePlan, files?: MergePlanFiles, seed?: MergePlanBuild['seed']) => {
        if (activeContext.current !== context) throw new GitPanelError('changed');
        const current = await scope();
        current.guard();
        if (current.folder !== plan.folder) throw new GitPanelError('changed');
        await journal.append({root: current.root, folder: current.folder}, plan, files, seed);
        current.guard();
        setPlans(previous => [...(previous ?? []), plan]);
        return plan.id;
    };
    const branchRef = available?.some(item => item.ref === selected) ? selected : '';
    const groups = new Map<string, MergePlan[]>();
    for (const plan of plans ?? []) {
        const existing = groups.get(plan.planId);
        if (existing) existing.push(plan);
        else groups.set(plan.planId, [plan]);
    }
    const names = new Map([...groups.keys()].map((id, index) => [id, name(index)]));
    const close = () => {
        setOpen(false);
        setAvailable(undefined);
        setSelected('');
        setError('');
    };
    return <>
        <button type="button" className="twgit-panel-action"
            onClick={() => setOpen(true)}>{text.title}</button>
        {open && createPortal(<dialog ref={dialog} aria-label={text.title} className="twgit-merge-plan-dialog"
            onClose={close} onCancel={event => {if (busy) event.preventDefault();}}>
            <h2>{text.title}</h2>
            <p>{text.help}</p>
            {!persistent && <p>{text.temporary}</p>}
            {share && (sharing ? <div className="twgit-merge-plan-sharing">
                <p>{text.sharing}</p>
                <label>MCP URL <input readOnly value={sharing.url} onFocus={event => event.currentTarget.select()}/></label>
                <label>{text.token} <input readOnly value={sharing.token} onFocus={event => event.currentTarget.select()}/></label>
                <button type="button" disabled={busy} onClick={() => void act(async () => {
                    await share.stop(sharing.token);
                    setConnection(undefined);
                })}>{text.stopShare}</button>
            </div> : <button type="button" disabled={busy || !plans} onClick={() => void act(async () => {
                const current = await scope();
                const read = createMergePlanReader(journal, current, playtest);
                const result = await share.start({repository: current.root.name, folder: current.folder}, read);
                if (!result) return;
                if (activeContext.current === context) setConnection({...result, context});
                else await share.stop(result.token);
            })}>{text.share}</button>)}
            {storageError && <p role="alert">{text.storageFailed}</p>}
            {branch && head && <form className="twgit-merge-plan-create" onSubmit={event => {
                event.preventDefault();
                if (branchRef) void act(async () => {
                    const {plan, files, seed} = await create({branch, head}, branchRef);
                    return add(plan, files, seed);
                });
            }}>
                <p>{text.target} <code>{branch}</code> <small>{head.slice(0, 12)}</small></p>
                <label>{text.from}{' '}
                    <select value={branchRef} disabled={busy || !available?.length}
                        onChange={event => setSelected(event.currentTarget.value)}>
                        <option value="">{text.choose}</option>
                        {available?.map(item => <option key={item.ref} value={item.ref}>{item.name}</option>)}
                    </select>
                </label>
                <button type="submit" disabled={busy || !branchRef || !plans}>{text.create}</button>
                {!available && <p role="status">{text.loading}</p>}
                {!!available && !available.length && !error && <p>{text.empty}</p>}
            </form>}
            {busy && <p role="status">{labels.loading}</p>}
            {error && <p role="alert">{error}</p>}
            {[...groups].map(([id, generations]) => {
                const original = plans?.find(plan => plan.id === generations[0].copiedFrom);
                return <Candidate key={id} text={text} name={names.get(id)!} generations={generations} busy={busy}
                    copiedFrom={original && names.get(original.planId)}
                    duplicate={plan => void act(() => add(duplicateMergePlan(plan)))}
                    play={(plan, title) => void act(async () => {
                        const files = await journal.files(plan);
                        return play(plan, files, title, mergePlaytestRequest(plan, files, await journal.seed(plan)), sharing && playtest.observe(plan));
                    })}
                    edit={edit && ((plan, title) => act(async () => {
                        const files = await journal.files(plan);
                        return edit(plan, files, title, async changes => {
                            const revision = await editMergePlan(plan, files, changes);
                            return add(revision.plan, revision.files);
                        });
                    }))}
                    prepareImport={validate && ((plan, file) => act(async () => {
                        if (file.size > mergePlanImportLimit) throw new GitPanelError('mergePlanImportFormat');
                        const content = await file.text();
                        return prepareMergePlanImport(plan, await journal.files(plan), content, validate);
                    }))}
                    saveImport={draft => act(async () => {
                        const revision = await draft.save();
                        return add(revision.plan, revision.files);
                    })}
                    revise={(plan, choices) => act(async () => {
                        const revision = await reviseMergePlan(plan, await journal.seed(plan), choices,
                            plan.edited ? await journal.files(plan) : undefined);
                        return add(revision.plan, revision.files);
                    })}/>;
            })}
            <form method="dialog" className="twgit-merge-plan-actions">
                <button type="submit" disabled={busy}>{labels.close}</button>
            </form>
        </dialog>, document.body)}
    </>;
}

function Candidate({text, name, generations, busy, copiedFrom, duplicate, play, revise, edit, prepareImport, saveImport}: {
    text: typeof words.en;
    name: string;
    generations: MergePlan[];
    busy: boolean;
    copiedFrom?: string;
    duplicate(plan: MergePlan): void;
    play(plan: MergePlan, title: string): void;
    edit?(plan: MergePlan, title: string): Promise<string | undefined>;
    revise(plan: MergePlan, choices: MergePlanChoices): Promise<string | undefined>;
    prepareImport?(plan: MergePlan, file: File): Promise<MergePlanImport | undefined>;
    saveImport(draft: MergePlanImport): Promise<string | undefined>;
}) {
    const [selected, setSelected] = useState('');
    const plan = generations.find(item => item.id === selected) ?? generations[generations.length - 1];
    const generation = (index: number) => `${text.generation} ${index + 1}`;
    const unconfirmed = plan.conflicts.filter(conflict => !mergePlanConflictResolved(plan, conflict.id)).length;
    const title = `${name} · ${generation(generations.indexOf(plan))}`;
    return <section aria-label={name} className="twgit-merge-candidate">
        <h3>{name}</h3>
        <p><code>{plan.inputs.incoming.name} @{plan.inputs.incoming.oid.slice(0, 8)}</code> →{' '}
            <code>{plan.inputs.current.name} @{plan.inputs.current.oid.slice(0, 8)}</code>
            {copiedFrom && <small> · {text.copiedFrom} {copiedFrom}</small>}</p>
        <label>{text.generation}{' '}
            <select value={plan.id} disabled={busy} onChange={event => setSelected(event.currentTarget.value)}>
                {generations.map((item, index) => <option key={item.id} value={item.id}>{generation(index)}</option>)}
            </select>
        </label>
        {plan.edited && <p>{plan.imported ? text.imported : text.edited}</p>}
        {plan.conflicts.length > 0 && <details>
            <summary>{text.edit} · {text.unconfirmed} {unconfirmed}</summary>
            <ConflictChoices key={plan.id} text={text} plan={plan} busy={busy}
                save={async choices => {
                    const id = await revise(plan, choices);
                    if (id) setSelected(id);
                }}/>
        </details>}
        {plan.problems > 0 && <p>{text.problems} · {plan.problems}</p>}
        <div className="twgit-merge-plan-actions">
            <button type="button" disabled={busy} onClick={() => duplicate(plan)}>{text.duplicate}</button>
            {edit && <button type="button" disabled={busy} onClick={async () => {
                const id = await edit(plan, `${text.editCode} · ${title}`);
                if (id) setSelected(id);
            }}>{text.editCode}</button>}
            <button type="button" disabled={busy} onClick={() => play(plan, `${text.play} · ${title}`)}>{text.play}</button>
        </div>
        {prepareImport && <CandidateImport key={plan.id} text={text} plan={plan} busy={busy}
            prepare={file => prepareImport(plan, file)}
            save={async draft => {
                const id = await saveImport(draft);
                if (id) setSelected(id);
            }}/>}
    </section>;
}

const conflictLabel = (conflict: MergePlan['conflicts'][number]) =>
    [conflict.path, conflict.target, conflict.detail].filter(Boolean).join(' · ');

function CandidateImport({text, plan, busy, prepare, save}: {
    text: typeof words.en; plan: MergePlan; busy: boolean;
    prepare(file: File): Promise<MergePlanImport | undefined>;
    save(draft: MergePlanImport): Promise<void>;
}) {
    const [draft, setDraft] = useState<MergePlanImport>();
    return <details className="twgit-merge-import">
        <summary>{text.importCandidate}</summary>
        <p>{text.importBase} <code>{plan.id}</code><br/>{text.importContent} <code>{plan.contentId}</code></p>
        <label>{text.importFile}{' '}
            <input type="file" accept=".json,application/json" disabled={busy} onChange={async event => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                setDraft(undefined);
                if (file) setDraft(await prepare(file));
            }}/>
        </label>
        {draft && <form onSubmit={event => {event.preventDefault(); if (!busy) void save(draft);}}>
            <p>{text.importReview}</p>
            <ul>{draft.changes.map(({path, kind}) => <li key={path}>{text[kind]} <code>{path}</code></li>)}</ul>
            {!!draft.resolutions.length && <>
                <p>{text.importResolutions}</p>
                <ul>{draft.resolutions.map(conflict => <li key={conflict.id}>{conflictLabel(conflict)}</li>)}</ul>
            </>}
            <button type="submit" disabled={busy}>{text.save}</button>{' '}
            <button type="button" disabled={busy} onClick={() => setDraft(undefined)}>{text.cancelImport}</button>
        </form>}
    </details>;
}

function ConflictChoices({text, plan, busy, save}: {
    text: typeof words.en; plan: MergePlan; busy: boolean; save(choices: MergePlanChoices): Promise<void>;
}) {
    const [choices, setChoices] = useState<Record<string, MergeSide>>(() => ({...plan.choices}));
    const changed = plan.conflicts.some(({id}) => choices[id] !== plan.choices[id]);
    return <form onSubmit={event => {event.preventDefault(); if (changed && !busy) void save(choices);}}>
        <ol className="twgit-merge-choices">
            {plan.conflicts.map(conflict => <li key={conflict.id}>
                <label>{conflictLabel(conflict)}
                    <select value={choices[conflict.id] ?? ''} disabled={busy} onChange={event => {
                        const side = event.currentTarget.value as MergeSide | '';
                        setChoices(previous => {
                            const next = {...previous};
                            if (side) next[conflict.id] = side;
                            else delete next[conflict.id];
                            return next;
                        });
                    }}>
                        <option value="">{plan.importedResolutions?.includes(conflict.id) ? text.imported : text.provisional}</option>
                        <option value="base">{text.base}</option>
                        <option value="current">{text.current} · {plan.inputs.current.name}</option>
                        <option value="incoming">{text.incoming} · {plan.inputs.incoming.name}</option>
                    </select>
                </label>
            </li>)}
        </ol>
        <button type="submit" disabled={!changed || busy}>{text.save}</button>
    </form>;
}
