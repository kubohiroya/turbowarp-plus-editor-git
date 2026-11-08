import React, {useMemo, useState} from 'react';
import {BlockPreview} from './block-diff-preview.js';
import {isRecord, readProjectSourceDiff} from './project-source-patch.js';
import type {BlockSide} from './project-source-patch.js';
import {compareProjectForReview} from './project-source-review-model.js';
import type {ScriptReview} from './project-source-review-model.js';
import type {ProjectBlockRenderer} from './scratch-block-diff-renderer.js';

export type ProjectSourceReviewFile = {
    path: string;
    summary?: string;
    previousPath?: string;
    unavailable?: boolean;
} & ({patch: string; beforeSource?: string} | {status: 'added' | 'removed' | 'updated'});

export interface ProjectSourceReviewProps {
    title: string;
    description?: string;
    verification?: readonly string[];
    files: readonly ProjectSourceReviewFile[];
    renderBlock: ProjectBlockRenderer;
    locale?: string;
}

const ja = {
    review: '変更レビュー', fullDescription: 'PR 本文を表示', checks: '確認してほしいこと', files: '変更ファイル', targets: '影響するステージ・スプライト',
    scripts: 'スクリプトの比較', reviewed: '確認済み', reviewedScripts: 'スクリプト確認済み', before: '変更前', after: '変更後',
    updated: '変更', added: '追加', removed: '削除', reorganized: '再編',
    absent: 'この版にはスクリプトがありません', loading: 'スクリプトを描画中…',
    unavailable: 'このスクリプトを描画できません。',
    related: '関連ファイル', properties: 'コード以外の変更', invalid: 'この作品の差分を読み込めません。',
    flag: '緑の旗が押されたとき', broadcast: 'を受け取ったとき', key: 'キーが押されたとき',
    click: 'このスプライトが押されたとき', script: 'スクリプト', noChanges: '作品に内容の変更はありません。'
};
const en: typeof ja = {
    review: 'Change review', fullDescription: 'Show full PR description', checks: 'Review checklist', files: 'Changed files', targets: 'Affected stages and sprites',
    scripts: 'Script comparisons', reviewed: 'Reviewed', reviewedScripts: 'Reviewed scripts', before: 'Before', after: 'After',
    updated: 'Changed', added: 'Added', removed: 'Removed', reorganized: 'Reorganized',
    absent: 'No script in this version', loading: 'Rendering script…',
    unavailable: 'This script could not be rendered.',
    related: 'Related file', properties: 'Changes outside the code', invalid: 'This project diff could not be read.',
    flag: 'When green flag clicked', broadcast: 'received', key: 'When key pressed',
    click: 'When this sprite clicked', script: 'Script', noChanges: 'No changes to the project contents.'
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

function ScriptComparison({script, labels, reviewed, setReviewed, renderBlock}: {
    script: ScriptReview; labels: typeof ja; reviewed: boolean; setReviewed(value: boolean): void;
    renderBlock: ProjectBlockRenderer;
}) {
    const [open, setOpen] = useState(false);
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
                        marks={side.marks} renderBlock={renderBlock} withContext labels={labels}/>) :
                        <BlockPreview title={labels[version]} renderBlock={renderBlock} withContext labels={labels}/>}
                </div>)}
            </div>
            <label className="twgit-review-checked"><input type="checkbox" checked={reviewed}
                onChange={event => setReviewed(event.currentTarget.checked)}/> {labels.reviewed}</label>
        </>}
    </details>;
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
    const targets = entries.reduce((total, entry) => total + (entry.comparison?.targets.length ?? 0), 0);
    const scripts = entries.reduce((total, entry) =>
        total + (entry.comparison?.targets.reduce((count, target) => count + target.scripts.length, 0) ?? 0), 0);
    const body = description?.trim();
    const longBody = !!body && body.length > 420;
    const excerpt = longBody ? body.slice(0, 250).trimEnd() + '…' : body;
    const propertyNames = (keys: readonly string[]) => keys.map(key => properties.get(key)?.[labels === ja ? 0 : 1] ?? key).join(' · ');
    return <section className="twgit-block-diff twgit-review" aria-label={labels.review}>
        <header className="twgit-review-overview">
            <p>{labels.review}</p>
            <h2>{title}</h2>
            {excerpt && <p className="twgit-review-description">{excerpt}</p>}
            <dl>
                <div><dt>{labels.files}</dt><dd>{entries.length}</dd></div>
                <div><dt>{labels.targets}</dt><dd>{targets}</dd></div>
                <div><dt>{labels.scripts}</dt><dd>{scripts}</dd></div>
                {scripts > 0 && <div><dt>{labels.reviewedScripts}</dt><dd>{reviewed.size} / {scripts}</dd></div>}
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
            {comparison && <>
                {comparison.properties.length > 0 && <p>{labels.properties} · {propertyNames(comparison.properties)}</p>}
                {!comparison.targets.length && !comparison.properties.length && <p>{labels.noChanges}</p>}
                {comparison.targets.map(target => <section className="twgit-review-target" key={JSON.stringify([target.isStage, target.name])}>
                    <h5>{target.name}{target.scripts.length > 0 && <small>{labels.scripts} · {target.scripts.length}</small>}</h5>
                    {target.properties.length > 0 && <p>{labels.properties} · {propertyNames(target.properties)}</p>}
                    {target.scripts.map(script => {
                        const key = JSON.stringify([file.path, target.isStage, target.name, script.id]);
                        return <ScriptComparison key={key} script={script} labels={labels} renderBlock={renderBlock} reviewed={reviewed.has(key)}
                            setReviewed={value => setChecked(previous => {
                                const keys = new Set(previous?.entries === entries ? previous.keys : []);
                                if (value) keys.add(key);
                                else keys.delete(key);
                                return {entries, keys};
                            })}/>;
                    })}
                </section>)}
            </>}
        </section>)}
    </section>;
}
