import React, {useMemo, useState} from 'react';
import {BlockPreview, usePreviewSync} from './block-diff-preview.js';
import {isRecord, parseProjectSource, readProjectSourceDiff} from './project-source-patch.js';
import type {BlockSide} from './project-source-patch.js';
import {compareProjectForReview} from './project-source-review-model.js';
import type {ScriptReview, TargetReview} from './project-source-review-model.js';
import type {ProjectBlockRenderer} from './scratch-block-diff-renderer.js';
import type {ProjectBlockLocator} from './block-diff-location.js';
import {currentCostume, useCostumeImage} from './project-assets.js';
import type {ProjectAssetLoader, ProjectVersion} from './project-assets.js';

type Comparison = ReturnType<typeof compareProjectForReview>;

export type ProjectSourceReviewFile = {
    path: string;
    summary?: string;
    previousPath?: string;
    unavailable?: boolean;
} & ({patch: string; beforeSource?: string; loadAsset?: ProjectAssetLoader;
    /** Offers "Highlight in Editor" on this file's after version, which the caller has matched with the open project. */
    locateBlock?: ProjectBlockLocator} | {status: 'added' | 'removed' | 'updated'});

export interface ProjectSourceReviewProps {
    title: string;
    description?: string;
    verification?: readonly string[];
    files: readonly ProjectSourceReviewFile[];
    renderBlock: ProjectBlockRenderer;
    locale?: string;
}

// Like the Editor's Code tab, a connected group of blocks is called code, and each item is named by its hat block.
const ja = {
    review: '変更レビュー', fullDescription: 'PR 本文を表示', checks: '確認してほしいこと', files: '変更ファイル', targets: '影響するステージ・スプライト',
    scripts: 'コードの変更', scriptCount: (count: number) => `コードの変更 · ${count} か所`,
    reviewed: '確認済み', before: '変更前', after: '変更後',
    updated: '変更', added: '追加', removed: '削除', reorganized: '再編',
    absent: 'この版にはこのコードがありません', loading: 'コードを描画中…',
    unavailable: 'このコードを描画できません。',
    related: '関連ファイル', properties: 'コード以外の変更', invalid: 'この作品の差分を読み込めません。',
    flag: '緑の旗が押されたとき', broadcast: 'を受け取ったとき', key: 'キーが押されたとき',
    click: 'このスプライトが押されたとき', script: 'コード', noChanges: '作品に内容の変更はありません。',
    comparison: '作品の変更', unreadable: '作品データとして読み込めないため、テキストの差分を表示します。'
};
const en: typeof ja = {
    review: 'Change review', fullDescription: 'Show full PR description', checks: 'Review checklist', files: 'Changed files', targets: 'Affected stages and sprites',
    scripts: 'Code changes', scriptCount: count => `Code changes · ${count}`,
    reviewed: 'Reviewed', before: 'Before', after: 'After',
    updated: 'Changed', added: 'Added', removed: 'Removed', reorganized: 'Reorganized',
    absent: 'No code in this version', loading: 'Rendering code…',
    unavailable: 'This code could not be rendered.',
    related: 'Related file', properties: 'Changes outside the code', invalid: 'This project diff could not be read.',
    flag: 'When green flag clicked', broadcast: 'received', key: 'When key pressed',
    click: 'When this sprite clicked', script: 'Code', noChanges: 'No changes to the project contents.',
    comparison: 'Project changes', unreadable: 'This file could not be read as project data, so its text diff is shown.'
};

const properties = new Map<string, readonly [string, string]>([
    ['variables', ['変数', 'Variables']], ['lists', ['リスト', 'Lists']], ['broadcasts', ['メッセージ', 'Broadcast messages']],
    ['costumes', ['コスチューム・背景', 'Costumes and backdrops']], ['sounds', ['音', 'Sounds']],
    ['comments', ['コメント', 'Comments']], ['monitors', ['モニター', 'Monitors']], ['extensions', ['拡張機能', 'Extensions']],
    ['x', ['X 座標', 'X position']], ['y', ['Y 座標', 'Y position']], ['visible', ['表示状態', 'Visibility']],
    ['direction', ['向き', 'Direction']], ['size', ['大きさ', 'Size']], ['currentCostume', ['表示するコスチューム', 'Selected costume']]
]);

function scriptTitle(side: BlockSide, labels: typeof ja) {
    const block = side.target.blocks[side.id];
    if (!isRecord(block)) return labels.script;
    if (block.opcode === 'event_whenflagclicked') return labels.flag;
    if (block.opcode === 'event_whenthisspriteclicked') return labels.click;
    if (block.opcode === 'event_whenkeypressed') return labels.key;
    if (block.opcode === 'event_whenbroadcastreceived') {
        const field = isRecord(block.fields) ? block.fields.BROADCAST_OPTION : undefined;
        const message = Array.isArray(field) && typeof field[0] === 'string' ? field[0] : '';
        if (message) return labels === ja ? `「${message}」${labels.broadcast}` : `“${message}” ${labels.broadcast}`;
    }
    return typeof block.opcode === 'string' ? block.opcode : labels.script;
}

function ScriptComparison({script, labels, reviewed = false, setReviewed, renderBlock, loadAsset}: {
    script: ScriptReview; labels: typeof ja; reviewed?: boolean; setReviewed?(value: boolean): void;
    renderBlock: ProjectBlockRenderer; loadAsset?: ProjectAssetLoader;
}) {
    const [open, setOpen] = useState(false);
    const {sync, toggle} = usePreviewSync(labels === ja ? 'ja' : 'en');
    const status = !script.before.length ? 'added' : !script.after.length ? 'removed' :
        script.before.length !== 1 || script.after.length !== 1 ? 'reorganized' : 'updated';
    const beforeTitle = script.before[0] && scriptTitle(script.before[0], labels);
    const afterTitle = script.after[0] && scriptTitle(script.after[0], labels);
    const title = beforeTitle && afterTitle && beforeTitle !== afterTitle ? beforeTitle + ' → ' + afterTitle : afterTitle ?? beforeTitle;
    return <details className="twgit-review-script" onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
        <summary>
            <span className="twgit-review-status">{labels[status]}</span>
            <strong>{title}</strong>
            {status === 'reorganized' && <small>{script.before.length} → {script.after.length}</small>}
            {reviewed && <small>{labels.reviewed}</small>}
        </summary>
        {open && <>
            <div className="twgit-block-diff-sides">
                {(['before', 'after'] as const).map(version => <div key={version}>
                    {script[version].length ? script[version].map((side, index, sides) => <BlockPreview key={side.id} side={side}
                        title={sides.length > 1 ? `${labels[version]} ${index + 1}` : labels[version]}
                        marks={side.marks} renderBlock={renderBlock} withContext labels={labels}
                        version={version} loadAsset={loadAsset} sync={sync}/>) :
                        <BlockPreview title={labels[version]} renderBlock={renderBlock} withContext labels={labels}/>}
                </div>)}
            </div>
            {toggle}
            {setReviewed && <label className="twgit-review-checked"><input type="checkbox" checked={reviewed}
                onChange={event => setReviewed(event.currentTarget.checked)}/> {labels.reviewed}</label>}
        </>}
    </details>;
}

function propertyNames(keys: readonly string[], labels: typeof ja) {
    return keys.map(key => properties.get(key)?.[labels === ja ? 0 : 1] ?? key).join(' · ');
}

/**
 * The current costume (the backdrop for the stage) of each version of a target that has one. A changed costume shows
 * before → after. Nothing is shown until an image is read, so the heading falls back to the name alone.
 */
function TargetThumbnails({target, labels, loadAsset}: {target: TargetReview; labels: typeof ja; loadAsset?: ProjectAssetLoader}) {
    const images = {before: useCostumeImage(target.before, 'before', loadAsset), after: useCostumeImage(target.after, 'after', loadAsset)};
    const costumes = {before: target.before && currentCostume(target.before), after: target.after && currentCostume(target.after)};
    const changed = !!costumes.before && !!costumes.after && costumes.before.md5ext !== costumes.after.md5ext;
    // An unchanged costume is the same file in both versions, so either read shows it.
    const versions: ProjectVersion[] = changed ? ['before', 'after'] : [images.after ? 'after' : 'before'];
    const shown = versions.filter(version => images[version]);
    if (!shown.length) return null;
    return <span className="twgit-review-thumbnails">
        {shown.map((version, index) => <React.Fragment key={version}>
            {index > 0 && <span aria-hidden="true">→</span>}
            <img src={images[version]!} title={costumes[version]?.name || undefined}
                alt={changed ? `${labels[version]}: ${costumes[version]?.name ?? ''}` : ''}/>
        </React.Fragment>)}
    </span>;
}

/** Lists the changed stages and sprites of one project file, each with its code comparisons. */
function ComparisonTargets({comparison, labels, renderBlock, loadAsset, review}: {
    comparison: Comparison; labels: typeof ja; renderBlock: ProjectBlockRenderer; loadAsset?: ProjectAssetLoader;
    review?: {file: string; keys: ReadonlySet<string>; set(key: string, value: boolean): void};
}) {
    return <>
        {comparison.properties.length > 0 && <p>{labels.properties} · {propertyNames(comparison.properties, labels)}</p>}
        {!comparison.targets.length && !comparison.properties.length && <p>{labels.noChanges}</p>}
        {comparison.targets.map(target => <section className="twgit-review-target" key={JSON.stringify([target.isStage, target.name])}>
            <h5><TargetThumbnails target={target} labels={labels} loadAsset={loadAsset}/>
                {target.name}{target.scripts.length > 0 && <small>{labels.scriptCount(target.scripts.length)}</small>}</h5>
            {target.properties.length > 0 && <p>{labels.properties} · {propertyNames(target.properties, labels)}</p>}
            {target.scripts.map(script => {
                const key = JSON.stringify([review?.file, target.isStage, target.name, script.id]);
                return <ScriptComparison key={key} script={script} labels={labels} renderBlock={renderBlock} loadAsset={loadAsset}
                    reviewed={review?.keys.has(key)} setReviewed={review && (value => review.set(key, value))}/>;
            })}
        </section>)}
    </>;
}

const countScripts = (comparison: Comparison) => comparison.targets.reduce((count, target) => count + target.scripts.length, 0);

export interface ProjectSourceComparisonProps {
    /** The earlier project.source.json, or `null` when the file did not exist yet. */
    before: string | null;
    /** The later project.source.json, or `null` when the file was removed. */
    after: string | null;
    renderBlock: ProjectBlockRenderer;
    locale?: string;
    /** Shown after an explanation when either version cannot be read as a project. Without it, only an error is shown. */
    fallback?: React.ReactNode;
    /** Reads the images of both versions for thumbnails. Without it, stages and sprites are shown by name. */
    loadAsset?: ProjectAssetLoader;
    /** Offers "Highlight in Editor" on the after version, which the caller has matched with the open project. */
    locateBlock?: ProjectBlockLocator;
    /** Shows only the code of this stage or sprite, without the overview and the changes outside the code. */
    target?: {isStage: boolean; name: string};
}

/** Compares two versions of a project.source.json by stage, sprite and code, as the pull request review does. */
export function ProjectSourceComparison({before, after, renderBlock, locale = 'en', fallback, loadAsset, target}: ProjectSourceComparisonProps) {
    const labels = locale.startsWith('ja') ? ja : en;
    const only = target && JSON.stringify([target.isStage, target.isStage || target.name]);
    const comparison = useMemo(() => {
        let result;
        try {
            result = compareProjectForReview(parseProjectSource(before), parseProjectSource(after));
        } catch {
            return null;
        }
        if (!only) return result;
        return {properties: [], targets: result.targets.filter(item => JSON.stringify([item.isStage, item.isStage || item.name]) === only)
            .map(item => ({...item, properties: []}))};
    }, [before, after, only]);
    if (!comparison) return fallback === undefined ? <p role="alert">{labels.invalid}</p> :
        <><p role="alert" className="twgit-review-unreadable">{labels.unreadable}</p>{fallback}</>;
    return <section className="twgit-block-diff twgit-review twgit-review-comparison" aria-label={labels.comparison}>
        {!only && <header className="twgit-review-overview">
            <dl>
                <div><dt>{labels.targets}</dt><dd>{comparison.targets.length}</dd></div>
                <div><dt>{labels.scripts}</dt><dd>{countScripts(comparison)}</dd></div>
            </dl>
        </header>}
        <ComparisonTargets comparison={comparison} labels={labels} renderBlock={renderBlock} loadAsset={loadAsset}/>
    </section>;
}

export function ProjectSourceReview({title, description, verification, files, renderBlock, locale = 'en'}: ProjectSourceReviewProps) {
    const labels = locale.startsWith('ja') ? ja : en;
    const entries = useMemo(() => files.map(file => {
        if (!('patch' in file)) return {file};
        try {
            const projects = readProjectSourceDiff(file.patch, file.beforeSource);
            return {file, comparison: projects ? compareProjectForReview(...projects) : {targets: [], properties: []}};
        } catch {
            return {file, invalid: true};
        }
    }), [files]);
    const [checked, setChecked] = useState<{entries: typeof entries; keys: Set<string>}>();
    const reviewed = checked?.entries === entries ? checked.keys : new Set<string>();
    const setReviewed = (key: string, value: boolean) => setChecked(previous => {
        const keys = new Set(previous?.entries === entries ? previous.keys : []);
        if (value) keys.add(key);
        else keys.delete(key);
        return {entries, keys};
    });
    const targets = entries.reduce((total, entry) => total + (entry.comparison?.targets.length ?? 0), 0);
    const scripts = entries.reduce((total, entry) => total + (entry.comparison ? countScripts(entry.comparison) : 0), 0);
    const body = description?.trim();
    const longBody = !!body && body.length > 420;
    const excerpt = longBody ? body.slice(0, 250).trimEnd() + '…' : body;
    return <section className="twgit-block-diff twgit-review" aria-label={labels.review}>
        <header className="twgit-review-overview">
            <p>{labels.review}</p>
            <h2>{title}</h2>
            {excerpt && <p className="twgit-review-description">{excerpt}</p>}
            <dl>
                <div><dt>{labels.files}</dt><dd>{entries.length}</dd></div>
                <div><dt>{labels.targets}</dt><dd>{targets}</dd></div>
                <div><dt>{labels.scripts}</dt><dd>{scripts}</dd></div>
                {scripts > 0 && <div><dt>{labels.reviewed}</dt><dd>{reviewed.size} / {scripts}</dd></div>}
            </dl>
            {longBody && <details className="twgit-review-body">
                <summary>{labels.fullDescription}</summary>
                <p className="twgit-review-description">{body}</p>
            </details>}
            {!!verification?.length && <div className="twgit-review-checklist">
                <h3>{labels.checks}</h3>
                <ul>{verification.map((item, index) => <li key={index}>{item}</li>)}</ul>
            </div>}
        </header>
        <h3 className="twgit-review-files-title">{labels.files}</h3>
        {entries.map(({file, comparison, invalid}) => <section key={file.path} className="twgit-review-file">
            <header><h4>{file.previousPath ? file.previousPath + ' → ' + file.path : file.path}</h4>{file.summary && <p>{file.summary}</p>}</header>
            {'status' in file && <p>{labels.related} · {labels[file.status]}</p>}
            {(invalid || file.unavailable) && <p role="alert">{labels.invalid}</p>}
            {comparison && <ComparisonTargets comparison={comparison} labels={labels} renderBlock={renderBlock}
                loadAsset={'loadAsset' in file ? file.loadAsset : undefined}
                review={{file: file.path, keys: reviewed, set: setReviewed}}/>}
        </section>)}
    </section>;
}
