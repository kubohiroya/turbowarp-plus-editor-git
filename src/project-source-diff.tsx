import React, {useEffect, useMemo, useRef, useState} from 'react';
import {compareProjectBlocks, readProjectSourceDiff} from './project-source-patch.js';
import type {BlockChange} from './project-source-patch.js';
import type {ProjectBlockLocator} from './block-diff-location.js';
import type {ProjectBlockRenderer} from './scratch-block-diff-renderer.js';
import {BlockPreview, usePreviewSync} from './block-diff-preview.js';
import type {LocationStatus} from './block-diff-preview.js';
import './project-source-diff.css';

export {createGitHubPullRequests, gitHubRepositoryFromOrigin} from './github-pull-requests.js';
export {ProjectSourceComparison, ProjectSourceReview} from './project-source-review.js';
export {ProjectComparisonDialog, openProjectComparison} from './project-comparison.js';
export {openProjectSourceTabs} from './project-source-tabs.js';
export type {ProjectSourceTabsFile, ProjectSourceTabsOptions} from './project-source-tabs.js';
export type {ProjectComparisonAction, ProjectComparisonDialogProps, ProjectComparisonOptions, ProjectComparisonSection} from './project-comparison.js';
export type {ProjectSourceComparisonProps, ProjectSourceReviewFile, ProjectSourceReviewProps} from './project-source-review.js';

export {createScratchBlocksDiffLocator} from './block-diff-location.js';
export type {ProjectBlockLocation, ProjectBlockLocator, ScratchBlockLocationWorkspace} from './block-diff-location.js';
export type {BlockPart} from './project-source-patch.js';
export {createProjectSourceDiff} from './project-source-patch.js';
export {compareProjectForReview} from './project-source-review-model.js';
export type {ScriptChangeKind, ScriptReview, ScriptReviewSide, ScriptSummaryItem, TargetReview} from './project-source-review-model.js';
export {currentCostume} from './project-assets.js';
export {assetFileName, organizeProjectChanges, projectPropertyLabel} from './project-change-model.js';
export type {ChangedFile, OrganizeProjectChangesInput, ProjectChangeList, ProjectChangeStatus, ProjectElementChange, ProjectElementKind,
    ProjectTargetChanges} from './project-change-model.js';
export type {ProjectAssetLoader, ProjectVersion} from './project-assets.js';
export {createScratchBlocksDiffRenderer} from './scratch-block-diff-renderer.js';
export type {BlockPreviewView, BlockPreviewViewport, ProjectBlockRenderer, ProjectBlockRendering, ScratchBlockDiffRendererOptions,
    ScratchBlocksPort} from './scratch-block-diff-renderer.js';
export {createPreviewSync} from './block-diff-preview.js';
export type {PreviewSync} from './block-diff-preview.js';

const en = {
    title: 'Block changes', before: 'Before', after: 'After', added: 'Added', removed: 'Removed', updated: 'Changed',
    inputs: 'Inputs', fields: 'Fields', opcode: 'Block type', mutation: 'Block shape', position: 'Position',
    connection: 'Connections', properties: 'Other block properties',
    absent: 'No block on this side', omitted: (count: number) => `${count} unchanged blocks omitted from the change list`,
    context: 'Highlight in the surrounding code', more: 'Show more changes', noChanges: 'No block changes.',
    locate: 'Highlight in Editor', locating: 'Finding the block in the Editor…', located: 'Highlighted in the Editor.',
    missingLocation: 'This version or block is unavailable in the Editor. Open its surrounding code here.',
    partLegend: 'Orange outlines mark changed inputs and fields.',
    otherChanges: 'The project also has changes outside its block code.',
    invalid: 'This diff could not be read. Use a full-context project diff, or provide the original project.',
    loading: 'Rendering blocks…', unavailable: 'This block could not be rendered. Check the block definitions available in the host.'
};
const ja: typeof en = {
    title: 'ブロックの変更', before: '変更前', after: '変更後', added: '追加', removed: '削除', updated: '変更',
    inputs: '入力値', fields: 'フィールド', opcode: 'ブロックの種類', mutation: 'ブロックの形', position: '位置',
    connection: 'つなぎ方', properties: 'その他のブロック属性',
    absent: 'この側にはブロックがありません', omitted: count => `変更のないブロック ${count} 個を一覧から省略`,
    context: '元のコード内で強調', more: '続きを表示', noChanges: 'ブロックの変更はありません。',
    locate: '編集画面で強調', locating: '編集画面でブロックを検索中…', located: '編集画面で強調しました。',
    missingLocation: '編集画面に該当する版またはブロックがありません。元のコードをここで展開できます。',
    partLegend: 'オレンジの枠は、変更された入力欄やフィールドです。',
    otherChanges: 'ブロックのコード以外にも作品の変更があります。',
    invalid: '差分を読み込めません。全体の文脈を含む差分を使うか、変更前の作品を指定してください。',
    loading: 'ブロックを描画中…', unavailable: 'ブロックを描画できません。ホストのブロック定義を確認してください。'
};

export interface ProjectSourceBlockDiffProps {
    patch: string;
    /** Supply the original JSON if the unified patch omits context. */
    beforeSource?: string;
    renderBlock: ProjectBlockRenderer;
    locateBlock?: ProjectBlockLocator;
    locale?: string;
}

type Version = 'before' | 'after';

const propertyLabels = new Map<string, keyof typeof en>([
    ['inputs', 'inputs'], ['fields', 'fields'], ['opcode', 'opcode'], ['mutation', 'mutation'],
    ['x', 'position'], ['y', 'position'], ['next', 'connection'], ['parent', 'connection'], ['topLevel', 'connection']
]);

function ChangeCard({change, renderBlock, labels, onLocate, location}: {
    change: BlockChange; renderBlock: ProjectBlockRenderer; labels: typeof en;
    onLocate?: (version: Version) => void; location?: {version: Version; status: LocationStatus};
}) {
    const [withContext, setWithContext] = useState(false);
    const {sync, toggle} = usePreviewSync(labels === en ? 'en' : 'ja');
    const notes = [...new Set(change.fields.map(field => labels[propertyLabels.get(field) ?? 'properties']))];
    const name = (change.after ?? change.before)!.target.name;
    return <article className={`twgit-block-diff-card twgit-block-diff-${change.kind}`}>
        <header>
            <h3><span>{labels[change.kind]}</span> {name}</h3>
            {!!notes.length && <p>{notes.join(' · ')}</p>}
            {!!change.parts.length && <p className="twgit-block-diff-legend">{labels.partLegend}</p>}
        </header>
        <div className="twgit-block-diff-sides">
            {(['before', 'after'] as const).map(version => <BlockPreview key={version} side={change[version]} title={labels[version]}
                renderBlock={renderBlock} withContext={withContext} labels={labels} parts={change.parts}
                onLocate={onLocate && (() => onLocate(version))} version={version} sync={sync}
                locationStatus={location?.version === version ? location.status : undefined}/>)}
        </div>
        {toggle}
        <label><input type="checkbox" checked={withContext} onChange={event => setWithContext(event.currentTarget.checked)}/> {labels.context}</label>
    </article>;
}

const pageSize = 12;
const empty = {changes: [], unchanged: 0, otherChanges: false};

export function ProjectSourceBlockDiff({patch, beforeSource, renderBlock, locateBlock, locale = 'en'}: ProjectSourceBlockDiffProps) {
    const labels = locale.startsWith('ja') ? ja : en;
    const result = useMemo(() => {
        try {
            const projects = readProjectSourceDiff(patch, beforeSource);
            return projects ? compareProjectBlocks(...projects) : empty;
        } catch {
            return null;
        }
    }, [patch, beforeSource]);
    const [page, setPage] = useState({result, visible: pageSize});
    const request = useRef<AbortController>();
    const [location, setLocation] = useState<{result: typeof result; key: string; version: Version; locator: ProjectBlockLocator; status: LocationStatus}>();
    useEffect(() => () => request.current?.abort(), [result, locateBlock]);
    const locate = async (change: BlockChange, version: Version) => {
        const side = change[version];
        if (!side || !locateBlock) return;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        const selected = {result, key: change.key, version, locator: locateBlock};
        setLocation({...selected, status: 'locating'});
        let found = false;
        try {
            found = await locateBlock({...side, version, parts: change.parts, signal: controller.signal});
        } catch {
            // The host may replace the active project while resolving its workspace.
        }
        if (!controller.signal.aborted) setLocation({...selected, status: found ? 'located' : 'missingLocation'});
    };
    if (!result) return <p role="alert">{labels.invalid}</p>;
    const visible = page.result === result ? page.visible : pageSize;
    return <section className="twgit-block-diff" aria-label={labels.title}>
        <h2>{labels.title} · {result.changes.length}</h2>
        {result.unchanged > 0 && <p>{labels.omitted(result.unchanged)}</p>}
        {result.otherChanges && <p>{labels.otherChanges}</p>}
        {!result.changes.length && <p>{labels.noChanges}</p>}
        {result.changes.slice(0, visible).map(change => <ChangeCard key={change.key} change={change} renderBlock={renderBlock} labels={labels}
            onLocate={locateBlock && (version => void locate(change, version))}
            location={location?.result === result && location.locator === locateBlock && location.key === change.key ? location : undefined}/>)}
        {visible < result.changes.length && <button type="button" onClick={() => setPage({result, visible: visible + pageSize})}>{labels.more}</button>}
    </section>;
}
