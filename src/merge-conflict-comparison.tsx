import React, {useState} from 'react';
import {render, unmountComponentAtNode} from 'react-dom';
import {BlockPreview} from './block-diff-preview.js';
import type {FolderConflict} from './project-folder-merge.js';
import {mergePlanPathLabel, type MergePlan, type MergePlanSeed} from './merge-plan.js';
import {mergeJson} from './merge-json.js';
import type {PlaytestConflict} from './merge-playtest.js';
import {isRecord, parseProjectSource, type BlockPart} from './project-source-patch.js';
import type {MergeSide} from './project-source-merge.js';
import type {ProjectBlockRenderer} from './scratch-block-diff-renderer.js';

const sides = ['current', 'incoming', 'base'] as const;
const decode = new TextDecoder('utf-8', {fatal: true});
const messages = (locale: string) => locale.startsWith('ja') ? {
    compare: '比較元を開く', close: '閉じる', current: '取り込み先', incoming: '取り込み元', base: '共通の元',
    absent: 'この版には競合箇所がありません。', loading: 'コードを描画中…', unavailable: '比較元を表示できません。'
} : {
    compare: 'Open comparison sources', close: 'Close', current: 'Current', incoming: 'Incoming', base: 'Common base',
    absent: 'The conflict location does not exist in this version.', loading: 'Rendering code…',
    unavailable: 'This comparison source could not be displayed.'
};

export const mergeComparisonLabel = (locale: string) => messages(locale).compare;

export function openMergeConflictComparison(document: Document, locale: string, plan: MergePlan, seed: MergePlanSeed,
    conflictId: string, renderBlock: ProjectBlockRenderer, point?: PlaytestConflict) {
    const text = messages(locale);
    const conflict = seed.conflicts.find(item => item.id === conflictId);
    if (!conflict) return;
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'twgit-restore-dialog twgit-conflict-comparison';
    dialog.setAttribute('aria-label', text.compare);
    document.body.append(dialog);
    render(<Comparison plan={plan} seed={seed} conflict={conflict} text={text} renderBlock={renderBlock} point={point}
        close={() => dialog.close()}/>, dialog);
    dialog.addEventListener('close', () => {
        unmountComponentAtNode(dialog);
        dialog.remove();
        (previousFocus as HTMLElement | null)?.focus();
    }, {once: true});
    dialog.showModal();
}

function Comparison({plan, seed, conflict, text, renderBlock, point, close}: {
    plan: MergePlan; seed: MergePlanSeed; conflict: FolderConflict; text: ReturnType<typeof messages>;
    renderBlock: ProjectBlockRenderer; point?: PlaytestConflict; close(): void;
}) {
    const [side, select] = useState<MergeSide>('current');
    const value = seed.state.versions.get(conflict.path)?.[side];
    const title = `${text[side]} @${(side === 'base' ? plan.inputs.base : plan.inputs[side].oid).slice(0, 12)}`;
    const version = comparisonVersion(conflict, side, value, point);
    return <>
        <h2>{text.compare}</h2>
        <p>{mergePlanPathLabel(conflict.path)}{conflict.type === 'project' && conflict.conflict.location.target &&
            ` · ${conflict.conflict.location.target}`}</p>
        <div>
            {sides.map(key => <button key={key} type="button" aria-pressed={side === key}
                onClick={() => select(key)}>{text[key]}</button>)}
        </div>
        <section key={side} aria-label={title}>
            {version.block ? <>
                {version.missing && <p>{text.absent}</p>}
                <BlockPreview side={version.block} title={title} parts={version.parts} renderBlock={renderBlock}
                    withContext labels={text}/>
            </> : <>
                <h3>{title}</h3>
                {version.text !== undefined ? <pre style={{maxHeight: '50vh', overflow: 'auto'}}>{version.text}</pre> :
                    <p>{version.missing ? text.absent : text.unavailable}</p>}
            </>}
        </section>
        <button type="button" onClick={close}>{text.close}</button>
    </>;
}

function comparisonVersion(item: FolderConflict, side: MergeSide, bytes: Uint8Array | null | undefined, point?: PlaytestConflict) {
    if (bytes === undefined) return {};
    if (bytes === null) return {missing: true};
    try {
        if (item.type === 'text') return {text: item[side].join('\n')};
        if (item.type === 'json') {
            const text = JSON.stringify(item.conflict[side], null, 2);
            return text === undefined ? {missing: true} : {text};
        }
        if (item.type === 'file') return {text: bytes.length <= 256 * 1024 ? decode.decode(bytes) : undefined};
        const {location, base, current, incoming} = item.conflict;
        if (location.type !== 'scripts') {
            const text = JSON.stringify(item.conflict[side], null, 2);
            return text === undefined ? {missing: true} : {text};
        }
        const {targets} = parseProjectSource(decode.decode(bytes));
        const target = targets.find(target => target.name === location.target) ??
            targets.find(target => location.blockIds.some(id => Object.hasOwn(target.blocks, id)));
        if (!target) return {missing: true};
        const path = mergeJson(base, current, incoming).conflicts.find(({path}) =>
            point ? path[0] === point.focus && path[2] === point.input : typeof path[0] === 'string')?.path;
        const focus = point?.focus ?? path?.[0] ?? location.blockIds[0];
        const hit = typeof focus === 'string' && Object.hasOwn(target.blocks, focus);
        const id = hit ? focus : [point?.script, ...location.blockIds].find((id): id is string =>
            id !== undefined && Object.hasOwn(target.blocks, id));
        if (!id) return {missing: true};
        const kind = path?.[1] === 'fields' ? 'field' : 'input';
        const block = target.blocks[id];
        const container = isRecord(block) ? block[kind === 'field' ? 'fields' : 'inputs'] : undefined;
        const name = point?.input ?? path?.[2];
        const hasPart = typeof name === 'string' && isRecord(container) && Object.hasOwn(container, name);
        const parts: BlockPart[] = hit && hasPart ? [{kind, name}] : [];
        return {block: {target, id}, parts, missing: !hit || (typeof name === 'string' && !hasPart)};
    } catch {
        return {};
    }
}
