import React, {useState} from 'react';
import {Diff, Hunk, parseDiff} from 'react-diff-view';
import {ProjectSourceComparison} from './project-source-review.js';
import type {FileChange, FileDiff} from './repository.js';
import type {labelsFor} from './messages.js';
import type {ProjectBlockRenderer} from './scratch-block-diff-renderer.js';
import type {ProjectAssetLoader} from './project-assets.js';

const en = {view: 'Show changes as', blocks: 'Blocks', text: 'Text'};
const ja: typeof en = {view: '変更の表示', blocks: 'ブロック', text: 'テキスト'};

/** Project sources are the files the panel opens as projects. */
export const isProjectSource = (path: string) => path.split('/').pop() === 'project.source.json';

/**
 * Shows one changed file. Project sources are compared as blocks by default, with their text diff one switch away.
 */
export function FileDiffView({change, diff, labels, locale, renderBlock, loadAsset}: {
    change: FileChange; diff: FileDiff | null; labels: ReturnType<typeof labelsFor>; locale: string;
    renderBlock?: ProjectBlockRenderer; loadAsset?: ProjectAssetLoader;
}) {
    const [view, setView] = useState<'blocks' | 'text'>('blocks');
    const names = locale.startsWith('ja') ? ja : en;
    const parsed = diff?.patch ? parseDiff(diff.patch)[0] : null;
    const text = <>
        <p>{labels.mode} · {change.oldMode?.toString(8) || '—'} → {change.newMode?.toString(8) || '—'}</p>
        {diff && <p>{diff.beforeSize} → {diff.afterSize} {labels.bytes}</p>}
        {diff?.binary && <p>{labels.binary}</p>}
        {diff?.tooLarge && <p>{labels.large}</p>}
        {parsed && <Diff viewType="unified" diffType={parsed.type} hunks={parsed.hunks}>
            {hunks => hunks.map(hunk => <Hunk key={hunk.content} hunk={hunk}/>)}</Diff>}
        {diff && !diff.binary && !diff.tooLarge && !parsed?.hunks.length && <p>{labels.unchanged}</p>}
    </>;
    const sources = renderBlock && diff?.text && isProjectSource(change.path) ? diff.text : null;
    return <>
        <h3>{change.path}</h3>
        {sources && <div className="twgit-view-switch" role="group" aria-label={names.view}>
            {(['blocks', 'text'] as const).map(mode => <button key={mode} type="button" aria-pressed={view === mode}
                data-git-view={mode} onClick={() => setView(mode)}>{names[mode]}</button>)}
        </div>}
        {sources && view === 'blocks' ? <ProjectSourceComparison renderBlock={renderBlock!} locale={locale} fallback={text} loadAsset={loadAsset}
            before={change.before === null ? null : sources.before} after={change.after === null ? null : sources.after}/> : text}
    </>;
}
