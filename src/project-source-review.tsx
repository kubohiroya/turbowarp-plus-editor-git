import React, {useEffect, useMemo, useRef, useState} from 'react';
import {BlockPreview, usePreviewSync} from './block-diff-preview.js';
import {isRecord, parseProjectSource, readProjectSourceDiff} from './project-source-patch.js';
import type {BlockSide} from './project-source-patch.js';
import {compareProjectForReview} from './project-source-review-model.js';
import type {ScriptReview, TargetReview} from './project-source-review-model.js';
import type {ProjectBlockRenderer} from './scratch-block-diff-renderer.js';
import type {ProjectBlockLocator} from './block-diff-location.js';
import type {LocationStatus} from './block-diff-preview.js';
import {currentCostume, useAssetImage, useCostumeImage} from './project-assets.js';
import {assetFileName, projectPropertyLabel} from './project-change-model.js';
import {hatName, legend, summaryPhrase} from './review-words.js';
import type {ProjectAssetLoader, ProjectVersion} from './project-assets.js';
import {changeReviewDraft, useReviewDraft} from './review-composer.js';
import {reviewLabelsFor} from './messages.js';

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
    /**
     * Where the reviewed marks are kept between reviews, such as `owner/repo#42`. Marks are stored in the browser with
     * the content of each script, so a mark stays until that script changes. Without it, marks last while the review is open.
     */
    rememberAs?: string;
    /**
     * Offers a comment field under each code change, kept in the review draft of this name (such as `owner/repo#42`) and
     * sent with the review.
     */
    commentAs?: string;
}

// Like the Editor's Code tab, a connected group of blocks is called code, and each item is named by its hat block.
const ja = {
    review: '変更レビュー', fullDescription: 'PR 本文を表示', checks: '確認してほしいこと', files: '変更ファイル', targets: '影響するステージ・スプライト',
    scripts: 'コードの変更', scriptCount: (count: number) => `コードの変更 · ${count} か所`,
    reviewed: '確認済み', before: '変更前', after: '変更後',
    updated: '変更', added: '追加', removed: '削除', reorganized: '再編', moved: '位置だけ', reordered: '並べ替え',
    stage: 'ステージ', otherSettings: 'そのほかの設定', legend: '色の見方',
    targetAdded: (name: string, stage: boolean) => stage ? 'ステージを追加' : `スプライト『${name}』を追加`,
    targetRemoved: (name: string, stage: boolean) => stage ? 'ステージを削除' : `スプライト『${name}』を削除`,
    assetOwner: (owner: string, kind: 'costume' | 'backdrop' | 'sound', name: string) => `${owner} の${kind === 'sound' ? '音' : kind === 'backdrop' ? '背景' : 'コスチューム'}『${name}』`,
    absent: 'この版にはこのコードがありません', loading: 'コードを描画中…',
    unavailable: 'このコードを描画できません。',
    related: '関連ファイル', properties: 'コード以外の変更', invalid: 'この作品の差分を読み込めません。',
    flag: '緑の旗が押されたとき', broadcast: 'を受け取ったとき', key: 'キーが押されたとき',
    click: 'このスプライトが押されたとき', script: 'コード', noChanges: '作品に内容の変更はありません。',
    comparison: '作品の変更', unreadable: '作品データとして読み込めないため、テキストの差分を表示します。',
    locate: '編集画面で強調', locating: '編集画面でブロックを検索中…', located: '編集画面で強調しました。',
    missingLocation: '編集画面に該当する版またはブロックがありません。'
};
const en: typeof ja = {
    review: 'Change review', fullDescription: 'Show full PR description', checks: 'Review checklist', files: 'Changed files', targets: 'Affected stages and sprites',
    scripts: 'Code changes', scriptCount: count => `Code changes · ${count}`,
    reviewed: 'Reviewed', before: 'Before', after: 'After',
    updated: 'Changed', added: 'Added', removed: 'Removed', reorganized: 'Reorganized', moved: 'Moved only', reordered: 'Reconnected',
    stage: 'Stage', otherSettings: 'Other settings', legend: 'Colours',
    targetAdded: (name, stage) => stage ? 'Added the stage' : `Added the sprite “${name}”`,
    targetRemoved: (name, stage) => stage ? 'Removed the stage' : `Removed the sprite “${name}”`,
    assetOwner: (owner, kind, name) => `${kind === 'sound' ? 'Sound' : kind === 'backdrop' ? 'Backdrop' : 'Costume'} “${name}” of ${owner}`,
    absent: 'No code in this version', loading: 'Rendering code…',
    unavailable: 'This code could not be rendered.',
    related: 'Related file', properties: 'Changes outside the code', invalid: 'This project diff could not be read.',
    flag: 'When green flag clicked', broadcast: 'received', key: 'When key pressed',
    click: 'When this sprite clicked', script: 'Code', noChanges: 'No changes to the project contents.',
    comparison: 'Project changes', unreadable: 'This file could not be read as project data, so its text diff is shown.',
    locate: 'Highlight in Editor', locating: 'Finding the block in the Editor…', located: 'Highlighted in the Editor.',
    missingLocation: 'This version or block is unavailable in the Editor.'
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
    if (block.opcode === 'event_whenbroadcastreceived') {
        const field = isRecord(block.fields) ? block.fields.BROADCAST_OPTION : undefined;
        const message = Array.isArray(field) && typeof field[0] === 'string' ? field[0] : '';
        if (message) return labels === ja ? `「${message}」${labels.broadcast}` : `“${message}” ${labels.broadcast}`;
    }
    return typeof block.opcode === 'string' && hatName(block.opcode, labels === ja ? 'ja' : 'en') || labels.script;
}

type BlockLocation = {locate?(side: BlockSide): void; status(side: BlockSide): LocationStatus | undefined};
const sideKey = (side: BlockSide) => JSON.stringify([side.target.isStage, side.target.name, side.id]);

/** Highlights the after version of a script in the Editor, one request per comparison, and cancels it on unmount. */
function useBlockLocation(comparison: Comparison, locateBlock?: ProjectBlockLocator): BlockLocation {
    const request = useRef<AbortController>();
    const [location, setLocation] = useState<{comparison: Comparison; key: string; locator: ProjectBlockLocator; status: LocationStatus}>();
    useEffect(() => () => request.current?.abort(), [comparison, locateBlock]);
    const locate = async (side: BlockSide) => {
        if (!locateBlock) return;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        const selected = {comparison, key: sideKey(side), locator: locateBlock};
        setLocation({...selected, status: 'locating'});
        let found = false;
        try {
            found = await locateBlock({target: side.target, id: side.id, version: 'after', parts: [], signal: controller.signal});
        } catch {
            // The host may replace the active project while resolving its workspace.
        }
        if (!controller.signal.aborted) setLocation({...selected, status: found ? 'located' : 'missingLocation'});
    };
    return {
        locate: locateBlock && (side => void locate(side)),
        status: side => location?.comparison === comparison && location.locator === locateBlock && location.key === sideKey(side) ?
            location.status : undefined
    };
}

/** What a script is called in a review: its hat block, or both hat blocks when the change replaced it. */
function scriptReviewTitle(script: ScriptReview, labels: typeof ja) {
    const beforeTitle = script.before[0] && scriptTitle(script.before[0], labels);
    const afterTitle = script.after[0] && scriptTitle(script.after[0], labels);
    return beforeTitle && afterTitle && beforeTitle !== afterTitle ? beforeTitle + ' → ' + afterTitle : afterTitle ?? beforeTitle;
}

type ScriptCommentField = {value: string; set(value: string, heading: string): void};

function ScriptComparison({script, labels, reviewed = false, setReviewed, renderBlock, loadAsset, location, expanded = false, comment, target}: {
    script: ScriptReview; labels: typeof ja; reviewed?: boolean; setReviewed?(value: boolean): void;
    /** The person's comment on this code, sent with the review. */
    comment?: ScriptCommentField; target?: TargetReview;
    renderBlock: ProjectBlockRenderer; loadAsset?: ProjectAssetLoader; location?: BlockLocation;
    /** Starts open, as in a tab that holds this one script. */
    expanded?: boolean;
}) {
    const [open, setOpen] = useState(expanded);
    const {sync, toggle} = usePreviewSync(labels === ja ? 'ja' : 'en');
    const status = script.kind;
    const locale = labels === ja ? 'ja' : 'en';
    const summary = script.summary.map(item => summaryPhrase(item, locale)).join(labels === ja ? '、' : ', ');
    const title = scriptReviewTitle(script, labels);
    return <details className="twgit-review-script" open={expanded || undefined}
        onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
        <summary>
            <span className="twgit-review-status">{labels[status]}</span>
            <strong>{title}</strong>
            {status === 'reorganized' && <small>{script.before.length} → {script.after.length}</small>}
            {summary && <small className="twgit-review-summary">{summary}</small>}
            {reviewed && <small>{labels.reviewed}</small>}
            {comment?.value && <small data-git-review-commented="">{reviewLabelsFor(locale).commented}</small>}
        </summary>
        {open && <>
            <div className="twgit-block-diff-sides">
                {(['before', 'after'] as const).map(version => <div key={version}>
                    {script[version].length ? script[version].map((side, index, sides) => <BlockPreview key={side.id} side={side}
                        title={sides.length > 1 ? `${labels[version]} ${index + 1}` : labels[version]}
                        marks={side.marks} renderBlock={renderBlock} withContext labels={labels}
                        version={version} loadAsset={loadAsset} sync={sync}
                        onLocate={version === 'after' && location?.locate ? () => location.locate!(side) : undefined}
                        locationStatus={version === 'after' ? location?.status(side) : undefined}/>) :
                        <BlockPreview title={labels[version]} renderBlock={renderBlock} withContext labels={labels}/>}
                </div>)}
            </div>
            {toggle}
            {setReviewed && <label className="twgit-review-checked"><input type="checkbox" checked={reviewed}
                onChange={event => setReviewed(event.currentTarget.checked)}/> {labels.reviewed}</label>}
            {comment && <label className="twgit-review-field twgit-review-comment">{reviewLabelsFor(locale).scriptComment}
                <textarea rows={3} value={comment.value} onChange={event => comment.set(event.currentTarget.value,
                    `${target?.isStage ? labels.stage : target?.name ?? ''} · ${title} · ${script.id}`)}/></label>}
        </>}
    </details>;
}

// Keys without a name people know are grouped as other settings; the keys stay in the title for those who look.
function propertyNames(keys: readonly string[], labels: typeof ja) {
    const locale = labels === ja ? 'ja' : 'en';
    const named = new Set<string>(), other: string[] = [];
    for (const key of keys) {
        const label = properties.get(key)?.[labels === ja ? 0 : 1] ?? projectPropertyLabel(key, locale);
        if (label === key) other.push(key);
        else named.add(label);
    }
    return <span title={keys.join(', ')}>{[...named, ...(other.length ? [labels.otherSettings] : [])].join(' · ')}</span>;
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
function ComparisonTargets({comparison, labels, renderBlock, loadAsset, locateBlock, review}: {
    comparison: Comparison; labels: typeof ja; renderBlock: ProjectBlockRenderer; loadAsset?: ProjectAssetLoader;
    locateBlock?: ProjectBlockLocator;
    review?: {file: string; keys: ReadonlySet<string>; set(key: string, value: boolean): void;
        comments?: {get(key: string): string; set(key: string, value: string, heading: string): void}};
}) {
    const location = useBlockLocation(comparison, locateBlock);
    return <>
        {comparison.properties.length > 0 && <p>{labels.properties} · {propertyNames(comparison.properties, labels)}</p>}
        {!comparison.targets.length && !comparison.properties.length && <p>{labels.noChanges}</p>}
        {comparison.targets.map(target => <section className="twgit-review-target" key={JSON.stringify([target.isStage, target.name])}>
            <h5><TargetThumbnails target={target} labels={labels} loadAsset={loadAsset}/>
                {target.isStage ? labels.stage : target.name}{target.scripts.length > 0 && <small>{labels.scriptCount(target.scripts.length)}</small>}</h5>
            {target.status !== 'updated' && <p className="twgit-review-target-status">
                {(target.status === 'added' ? labels.targetAdded : labels.targetRemoved)(target.name, target.isStage)}</p>}
            {target.status === 'updated' && target.properties.length > 0 && <p>{labels.properties} · {propertyNames(target.properties, labels)}</p>}
            {target.scripts.map(script => {
                const key = reviewKey(review?.file, target, script);
                const comments = review?.comments;
                return <ScriptComparison key={key} script={script} labels={labels} renderBlock={renderBlock} loadAsset={loadAsset}
                    location={location} reviewed={review?.keys.has(key)} setReviewed={review && (value => review.set(key, value))}
                    target={target} comment={comments && {value: comments.get(key), set: (value, heading) => comments.set(key, value, heading)}}/>;
            })}
        </section>)}
    </>;
}

function Legend({labels}: {labels: typeof ja}) {
    return <p className="twgit-review-legend" aria-label={labels.legend}>
        {legend(labels === ja ? 'ja' : 'en').map(([kind, text]) => <span key={kind} data-legend={kind}>{text}</span>)}
    </p>;
}

type RelatedEntry = {file: ProjectSourceReviewFile; comparison?: Comparison};

/** Finds who uses an asset file of the review: the costume or sound whose file name it is, in the project beside it. */
function assetOwner(path: string, status: 'added' | 'removed' | 'updated', entries: readonly RelatedEntry[]) {
    const parts = path.split('/');
    const name = parts.pop()!;
    const folder = parts.slice(0, -1).join('/');
    const version: ProjectVersion = status === 'removed' ? 'before' : 'after';
    for (const {file, comparison} of entries) {
        if (!comparison || !('patch' in file) || file.path.split('/').slice(0, -1).join('/') !== folder) continue;
        for (const target of comparison.targets) {
            const owner = target[version];
            if (!owner) continue;
            for (const kind of ['costumes', 'sounds'] as const) {
                const list = (owner as unknown as Record<string, unknown>)[kind];
                if (!Array.isArray(list)) continue;
                const entry = list.find(item => isRecord(item) && assetFileName(item) === name);
                if (isRecord(entry)) return {target, version, md5ext: name, loadAsset: file.loadAsset,
                    kind: kind === 'sounds' ? 'sound' as const : target.isStage ? 'backdrop' as const : 'costume' as const,
                    name: typeof entry.name === 'string' ? entry.name : name};
            }
        }
    }
    return null;
}

function RelatedFile({file, entries, labels}: {
    file: ProjectSourceReviewFile & {status: 'added' | 'removed' | 'updated'}; entries: readonly RelatedEntry[]; labels: typeof ja;
}) {
    const owner = assetOwner(file.path, file.status, entries);
    const image = useAssetImage(owner && owner.kind !== 'sound' ? owner.md5ext : undefined, owner?.version ?? 'after', owner?.loadAsset);
    if (!owner) return <p>{labels.related} · {labels[file.status]}</p>;
    const ownerName = owner.target.isStage ? labels.stage : owner.target.name;
    return <p className="twgit-review-asset">
        {image && <img src={image} alt=""/>}
        <span>{labels.assetOwner(ownerName, owner.kind, owner.name)} · {labels[file.status]}</span>
    </p>;
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
export function ProjectSourceComparison({before, after, renderBlock, locale = 'en', fallback, loadAsset, locateBlock, target}: ProjectSourceComparisonProps) {
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
        {!only && <Legend labels={labels}/>}
        {!only && <header className="twgit-review-overview">
            <dl>
                <div><dt>{labels.targets}</dt><dd>{comparison.targets.length}</dd></div>
                <div><dt>{labels.scripts}</dt><dd>{countScripts(comparison)}</dd></div>
            </dl>
        </header>}
        <ComparisonTargets comparison={comparison} labels={labels} renderBlock={renderBlock} loadAsset={loadAsset}
            locateBlock={locateBlock}/>
    </section>;
}

const reviewKey = (file: string | undefined, target: TargetReview, script: ScriptReview) =>
    JSON.stringify([file, target.isStage, target.name, script.id]);
// A short fingerprint of what a script shows, so a stored mark is dropped once the script changes.
const fingerprint = (value: unknown) => {
    let hash = 0x811c9dc5;
    for (const char of JSON.stringify(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
    return (hash >>> 0).toString(36);
};
// A side carries its whole stage or sprite; only the blocks of its own script decide whether a mark still holds.
const scriptBlocks = ({target, id}: ScriptReview['before'][number]) => {
    const blocks = target.blocks as Record<string, {parent?: unknown} | undefined>;
    const rootOf = (start: string) => {
        let current = start;
        for (let guard = 0; guard < 10000; guard++) {
            const parent = blocks[current]?.parent;
            if (typeof parent !== 'string' || !blocks[parent]) return current;
            current = parent;
        }
        return current;
    };
    return Object.keys(blocks).filter(key => rootOf(key) === id).sort().map(key => [key, blocks[key]]);
};
const scriptPrint = (script: ScriptReview) => fingerprint([script.kind, script.before.map(scriptBlocks), script.after.map(scriptBlocks)]);
const storageKey = (name: string) => `turbowarp-plus-git:reviewed:${name}`;
// Marks of reviews that are not remembered, shared by the tabs of one comparison while the page is open.
const memoryMarks = new Map<string, Record<string, string>>();
// Whoever shows the marks of a review, such as the review panel and the tabs of the same pull request.
const markListeners = new Map<string, Set<() => void>>();
const subscribeMarks = (name: string, listener: () => void) => {
    const listeners = markListeners.get(name) ?? new Set();
    markListeners.set(name, listeners.add(listener));
    return () => {
        listeners.delete(listener);
        if (!listeners.size) markListeners.delete(name);
    };
};
// Browser storage can be missing or refuse access; the marks then last while the review is open.
const readMarks = (name: string, remember = true): Record<string, string> => {
    if (!remember) return memoryMarks.get(name) ?? {};
    try {
        const value = JSON.parse(globalThis.localStorage?.getItem(storageKey(name)) ?? '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
};
const writeMarks = (name: string, marks: Record<string, string>, remember = true) => {
    if (!remember) {
        if (Object.keys(marks).length) memoryMarks.set(name, marks);
        else memoryMarks.delete(name);
    }
    try {
        if (remember && Object.keys(marks).length) globalThis.localStorage?.setItem(storageKey(name), JSON.stringify(marks));
        else if (remember) globalThis.localStorage?.removeItem(storageKey(name));
    } catch {
        // Not kept; the marks still work for this review.
    }
    markListeners.get(name)?.forEach(listener => listener());
};

export function ProjectSourceReview({title, description, verification, files, renderBlock, locale = 'en', rememberAs, commentAs}: ProjectSourceReviewProps) {
    const labels = locale.startsWith('ja') ? ja : en;
    const draft = useReviewDraft(commentAs);
    const commentsFor = (file: string) => commentAs && draft ? {
        get: (key: string) => draft.comments[key]?.body ?? '',
        set: (key: string, body: string, heading: string) => changeReviewDraft(commentAs, current => {
            const comments = {...current.comments};
            if (body) comments[key] = {file, heading, body};
            else delete comments[key];
            return {...current, comments};
        })
    } : undefined;
    const entries = useMemo(() => files.map(file => {
        if (!('patch' in file)) return {file};
        try {
            const projects = readProjectSourceDiff(file.patch, file.beforeSource);
            return {file, comparison: projects ? compareProjectForReview(...projects) : {targets: [], properties: []}};
        } catch {
            return {file, invalid: true};
        }
    }), [files]);
    // Each script of this review by its mark key, with what it shows now.
    const scriptPrints = useMemo(() => {
        const prints = new Map<string, string>();
        for (const {file, comparison} of entries) {
            for (const target of comparison?.targets ?? []) {
                for (const script of target.scripts) prints.set(reviewKey(file.path, target, script), scriptPrint(script));
            }
        }
        return prints;
    }, [entries]);
    const [checked, setChecked] = useState<{entries: typeof entries; marks: Record<string, string>}>();
    // A mark set in a tab of the same pull request shows here too.
    const [, refresh] = useState(0);
    useEffect(() => rememberAs ? subscribeMarks(rememberAs, () => {
        setChecked(undefined);
        refresh(count => count + 1);
    }) : undefined, [rememberAs]);
    const marks = checked?.entries === entries ? checked.marks : rememberAs ? readMarks(rememberAs) : {};
    const reviewed = new Set([...scriptPrints].filter(([key, print]) => marks[key] === print).map(([key]) => key));
    const setReviewed = (key: string, value: boolean) => {
        // Keep only marks that still match a script of this review.
        const next: Record<string, string> = {};
        for (const [name, print] of scriptPrints) if (marks[name] === print) next[name] = print;
        if (value) next[key] = scriptPrints.get(key)!;
        else delete next[key];
        // Writing tells the tabs of this review, and this panel, which then keeps the marks it has just set.
        if (rememberAs) writeMarks(rememberAs, next);
        setChecked({entries, marks: next});
    };
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
        <Legend labels={labels}/>
        <h3 className="twgit-review-files-title">{labels.files}</h3>
        {entries.map(({file, comparison, invalid}) => <section key={file.path} className="twgit-review-file">
            <header><h4>{file.previousPath ? file.previousPath + ' → ' + file.path : file.path}</h4>{file.summary && <p>{file.summary}</p>}</header>
            {'status' in file && <RelatedFile file={file} entries={entries} labels={labels}/>}
            {(invalid || file.unavailable) && <p role="alert">{labels.invalid}</p>}
            {comparison && <ComparisonTargets comparison={comparison} labels={labels} renderBlock={renderBlock}
                loadAsset={'loadAsset' in file ? file.loadAsset : undefined}
                locateBlock={'locateBlock' in file ? file.locateBlock : undefined}
                review={{file: file.path, keys: reviewed, set: setReviewed, comments: commentsFor(file.path)}}/>}
        </section>)}
    </section>;
}

/** The words of one tab of a project comparison opened as tabs. */
export function reviewTabWords(locale: string) {
    const labels = locale.startsWith('ja') ? ja : en;
    return {
        script: (script: ScriptReview) => `${scriptReviewTitle(script, labels)} · ${labels[script.kind]}`,
        target: (target: TargetReview) => target.isStage ? labels.stage : target.name,
        targetDetails: labels.properties,
        project: labels.comparison,
        noChanges: labels.noChanges
    };
}

/**
 * Where a tab keeps its reviewed mark: under `name` with the review of the same name, in the browser when
 * `remember` is set, or else while the page is open.
 */
export interface ReviewMarkPlace {
    name: string;
    remember: boolean;
    file: string;
    target: TargetReview;
}

function useReviewMark(place: ReviewMarkPlace | undefined, script: ScriptReview) {
    const [, refresh] = useState(0);
    useEffect(() => place && subscribeMarks(place.name, () => refresh(count => count + 1)), [place?.name]);
    if (!place) return {};
    const key = reviewKey(place.file, place.target, script);
    const print = scriptPrint(script);
    return {
        reviewed: readMarks(place.name, place.remember)[key] === print,
        setReviewed(value: boolean) {
            const marks = {...readMarks(place.name, place.remember)};
            if (value) marks[key] = print;
            else delete marks[key];
            writeMarks(place.name, marks, place.remember);
        }
    };
}

/** One script of a comparison, open, for a tab of its own. */
export function ScriptReviewTab({comparison, script, renderBlock, locale = 'en', loadAsset, locateBlock, mark}: {
    comparison: Comparison; script: ScriptReview; renderBlock: ProjectBlockRenderer; locale?: string;
    loadAsset?: ProjectAssetLoader; locateBlock?: ProjectBlockLocator;
    /** Offers the reviewed mark, shared with the review panel and other tabs that use the same place. */
    mark?: ReviewMarkPlace;
}) {
    const labels = locale.startsWith('ja') ? ja : en;
    const location = useBlockLocation(comparison, locateBlock);
    const {reviewed, setReviewed} = useReviewMark(mark, script);
    return <section className="twgit-block-diff twgit-review twgit-review-tab">
        <ScriptComparison script={script} labels={labels} renderBlock={renderBlock} loadAsset={loadAsset} location={location} expanded
            reviewed={reviewed} setReviewed={setReviewed}/>
        <Legend labels={labels}/>
    </section>;
}

/**
 * What changed in a stage or sprite outside its code, or in the project as a whole when no target is given,
 * for a tab of its own.
 */
export function TargetReviewTab({comparison, target, locale = 'en', loadAsset}: {
    comparison: Comparison; target?: TargetReview; locale?: string; loadAsset?: ProjectAssetLoader;
}) {
    const labels = locale.startsWith('ja') ? ja : en;
    if (!target) {
        return <section className="twgit-block-diff twgit-review twgit-review-tab">
            {comparison.properties.length > 0 ? <p>{labels.properties} · {propertyNames(comparison.properties, labels)}</p> :
                <p>{labels.noChanges}</p>}
        </section>;
    }
    return <section className="twgit-block-diff twgit-review twgit-review-tab">
        <h5><TargetThumbnails target={target} labels={labels} loadAsset={loadAsset}/>{target.isStage ? labels.stage : target.name}</h5>
        {target.status !== 'updated' && <p className="twgit-review-target-status">
            {(target.status === 'added' ? labels.targetAdded : labels.targetRemoved)(target.name, target.isStage)}</p>}
        {target.status === 'updated' && target.properties.length > 0 && <p>{labels.properties} · {propertyNames(target.properties, labels)}</p>}
        {target.scripts.length > 0 && <p>{labels.scriptCount(target.scripts.length)}</p>}
    </section>;
}
