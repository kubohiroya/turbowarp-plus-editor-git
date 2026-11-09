import React, {useEffect, useState} from 'react';
import {organizeProjectChanges, projectPropertyLabel} from './project-change-model.js';
import type {ChangedFile, ProjectChangeList, ProjectElementChange, ProjectTargetChanges} from './project-change-model.js';
import {parseProjectSource} from './project-source-patch.js';
import {useAssetImage, useCostumeImage} from './project-assets.js';
import type {ProjectAssetLoader, ProjectVersion} from './project-assets.js';
import {ProjectSourceComparison} from './project-source-review.js';
import type {ChangeGroup, FileChange, Repository, Snapshot} from './repository.js';
import type {ProjectBlockRenderer} from './scratch-block-diff-renderer.js';

const en = {
    title: 'Project changes', stage: 'Stage', code: (count: number) => `Code · ${count} ${count === 1 ? 'change' : 'changes'}`,
    costumes: 'Costume', backdrops: 'Backdrop', sounds: 'Sound', data: 'Variables and messages', settings: 'Other settings',
    project: 'Whole project', other: 'Files outside the project', added: 'Added', removed: 'Removed', updated: 'Changed',
    files: 'Files and Git groups', before: 'Before', after: 'After', absent: 'Not in this version',
    loading: 'Reading the project changes…', unreadable: 'The project data could not be read, so the changes are listed by file.',
    fileList: 'List by file', property: 'Item', format: 'Format', rate: 'Sample rate', samples: 'Samples', file: 'File name',
    noImage: 'No image', groups: {staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked', commit: 'Commit'} as Record<ChangeGroup, string>
};
const ja: typeof en = {
    title: '作品の変更', stage: 'ステージ', code: count => `コード · ${count} か所`,
    costumes: 'コスチューム', backdrops: '背景', sounds: '音', data: '変数・リスト・メッセージ', settings: 'そのほかの設定',
    project: '作品全体', other: '作品に属さないファイル', added: '追加', removed: '削除', updated: '変更',
    files: 'ファイルと Git の区分', before: '変更前', after: '変更後', absent: 'この版にはありません',
    loading: '作品の変更を読み込み中…', unreadable: '作品データを読み込めないため、ファイル単位で一覧にします。',
    fileList: 'ファイル単位の一覧', property: '項目', format: '形式', rate: 'サンプリング周波数', samples: 'サンプル数', file: 'ファイル名',
    noImage: '画像なし', groups: {staged: 'ステージ済み', unstaged: '未ステージ', untracked: '未追跡', commit: 'コミット'}
};
type Labels = typeof en;
export const projectChangeLabels = (locale: string): Labels => locale.startsWith('ja') ? ja : en;

export interface ProjectChanges {
    list: ProjectChangeList;
    sources: {before: string | null; after: string | null};
    loadAsset: ProjectAssetLoader;
}

/**
 * Reads the selected project folder in the last commit and the working tree (or a commit and its parent) and arranges
 * the changed files by stage, sprite and element. `undefined` while there is no project; `'loading'` and `'unreadable'`
 * tell the panel to keep the list by file.
 */
export function useProjectChanges(repository: Repository | null, snapshot: Snapshot | null, project: string | null,
    commit: string | null, changes: readonly FileChange[]): ProjectChanges | 'loading' | 'unreadable' | undefined {
    const [result, setResult] = useState<{changes: readonly FileChange[]; value: ProjectChanges | 'unreadable'}>();
    const active = !!repository && !!snapshot && project !== null && changes.length > 0;
    useEffect(() => {
        if (!repository || !snapshot || project === null || !changes.length) return;
        let current = true;
        const comparison = commit ? {kind: 'commit' as const, commit} : {kind: 'worktree' as const};
        void repository.readProject(snapshot, project, comparison).then(read => {
            if (!current) return;
            let list: ProjectChangeList;
            try {
                list = organizeProjectChanges({folder: project,
                    before: read.before === null ? null : parseProjectSource(read.before),
                    after: read.after === null ? null : parseProjectSource(read.after),
                    assetsDirectory: read.assetsDirectory, files: changes.map(({path, group}) => ({path, group}))});
            } catch {
                setResult({changes, value: 'unreadable'});
                return;
            }
            setResult({changes, value: {list, sources: {before: read.before, after: read.after},
                loadAsset: repository.projectAssetLoader(snapshot, project, comparison)}});
        }, () => {if (current) setResult({changes, value: 'unreadable'});});
        return () => {current = false;};
    }, [repository, snapshot, project, commit, changes]);
    if (!active) return undefined;
    return result?.changes === changes ? result.value : 'loading';
}

function TargetHeading({target, labels, loadAsset}: {target: ProjectTargetChanges; labels: Labels; loadAsset: ProjectAssetLoader}) {
    const version: ProjectVersion = target.after ? 'after' : 'before';
    const image = useCostumeImage(target[version], version, loadAsset);
    return <h4 className="twgit-element-target">
        {image ? <img src={image} alt=""/> : <span className="twgit-element-thumbnail"/>}
        <span>{target.isStage ? labels.stage : target.name}</span>
        {target.status !== 'updated' && <small className="twgit-review-status">{labels[target.status]}</small>}
    </h4>;
}

function elementTitle(element: ProjectElementChange, target: ProjectTargetChanges | null, labels: Labels, locale: string) {
    switch (element.kind) {
    case 'code': return labels.code(element.scripts ?? 0);
    case 'costumes': return `${target?.isStage ? labels.backdrops : labels.costumes} · ${element.name ?? ''}`;
    case 'sounds': return `${labels.sounds} · ${element.name ?? ''}`;
    default: {
        const names = (element.properties ?? []).map(key => projectPropertyLabel(key, locale)).join('・');
        return target ? `${element.kind === 'data' ? labels.data : labels.settings} · ${names}` : names;
    }
    }
}

function ElementRow({element, target, labels, locale, loadAsset, selected, busy, onSelect}: {
    element: ProjectElementChange; target: ProjectTargetChanges | null; labels: Labels; locale: string;
    loadAsset: ProjectAssetLoader; selected: boolean; busy: boolean; onSelect(): void;
}) {
    const version: ProjectVersion = element.md5ext?.after ? 'after' : 'before';
    const image = useAssetImage(element.kind === 'costumes' ? element.md5ext?.[version] : undefined, version, loadAsset);
    return <li><button className="twgit-file twgit-element" data-git-element={element.kind} disabled={busy} aria-pressed={selected}
        onClick={onSelect}>
        {element.kind === 'costumes' && (image ? <img src={image} alt=""/> : <span className="twgit-element-thumbnail"/>)}
        <span className="twgit-element-name">{elementTitle(element, target, labels, locale)}</span>
        {element.status !== 'updated' && <small className="twgit-review-status">{labels[element.status]}</small>}
    </button></li>;
}

/** The change list arranged by the project's stage, sprites and elements, with files outside the project after them. */
export function ProjectChangeListView({changes, selected, locale, busy, onSelect, onSelectFile, fileList}: {
    changes: ProjectChanges; selected: string | null; locale: string; busy: boolean;
    onSelect(key: string): void; onSelectFile(file: ChangedFile): void; fileList: React.ReactNode;
}) {
    const labels = projectChangeLabels(locale);
    const {list, loadAsset} = changes;
    return <section className="twgit-element-list" aria-label={labels.title}>
        {list.targets.map(target => <section key={target.key}>
            <TargetHeading target={target} labels={labels} loadAsset={loadAsset}/>
            <ul>{target.elements.map(element => <ElementRow key={element.key} element={element} target={target} labels={labels}
                locale={locale} loadAsset={loadAsset} selected={selected === element.key} busy={busy} onSelect={() => onSelect(element.key)}/>)}</ul>
        </section>)}
        {list.project.length > 0 && <section>
            <h4 className="twgit-element-target"><span>{labels.project}</span></h4>
            <ul>{list.project.map(element => <ElementRow key={element.key} element={element} target={null} labels={labels}
                locale={locale} loadAsset={loadAsset} selected={selected === element.key} busy={busy} onSelect={() => onSelect(element.key)}/>)}</ul>
        </section>}
        {list.other.length > 0 && <section>
            <h4 className="twgit-element-target"><span>{labels.other}</span></h4>
            <ul>{list.other.map(file => <li key={file.group + ':' + file.path}><button className="twgit-file" data-git-other={file.group}
                disabled={busy} onClick={() => onSelectFile(file)}>{file.path} <small>{labels.groups[file.group]}</small></button></li>)}</ul>
        </section>}
        <details className="twgit-file-list"><summary>{labels.fileList}</summary>{fileList}</details>
    </section>;
}

export function findElement(list: ProjectChangeList, key: string | null) {
    if (key === null) return null;
    for (const target of list.targets) {
        const element = target.elements.find(item => item.key === key);
        if (element) return {element, target};
    }
    const element = list.project.find(item => item.key === key);
    return element ? {element, target: null} : null;
}

function Picture({md5ext, version, loadAsset, labels, title}: {
    md5ext?: string; version: ProjectVersion; loadAsset: ProjectAssetLoader; labels: Labels; title: string;
}) {
    const image = useAssetImage(md5ext, version, loadAsset);
    return <figure className="twgit-element-picture">
        <figcaption>{title}</figcaption>
        {!md5ext ? <p>{labels.absent}</p> : image ? <img src={image} alt={title}/> : <p>{labels.noImage}</p>}
    </figure>;
}

const show = (value: unknown) => {
    if (value === undefined) return '—';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 400 ? text.slice(0, 400) + '…' : text;
};

/** The details of one selected row: its code, pictures or values in both versions, and the files behind it. */
export function ProjectElementView({changes, selection, locale, renderBlock, onSelectFile}: {
    changes: ProjectChanges; selection: {element: ProjectElementChange; target: ProjectTargetChanges | null}; locale: string;
    renderBlock?: ProjectBlockRenderer; onSelectFile(file: ChangedFile): void;
}) {
    const labels = projectChangeLabels(locale);
    const {element, target} = selection;
    const record = (version: ProjectVersion): Record<string, unknown> | undefined => {
        if (element.kind === 'costumes' || element.kind === 'sounds') return element[version];
        if (!target) {
            const source = changes.sources[version];
            try {
                return source === null ? undefined : parseProjectSource(source) as Record<string, unknown>;
            } catch {
                return undefined;
            }
        }
        return target[version] as Record<string, unknown> | undefined;
    };
    const rows = element.kind === 'sounds' ? [['name', 'name'], ['dataFormat', labels.format], ['rate', labels.rate],
        ['sampleCount', labels.samples], ['md5ext', labels.file]] as const :
        (element.properties ?? []).map(key => [key, projectPropertyLabel(key, locale)] as const);
    return <section className="twgit-element-view" aria-label={elementTitle(element, target, labels, locale)}>
        <h3>{target && <span>{target.isStage ? labels.stage : target.name} · </span>}{elementTitle(element, target, labels, locale)}</h3>
        {element.kind === 'code' && target && renderBlock && <ProjectSourceComparison before={changes.sources.before}
            after={changes.sources.after} renderBlock={renderBlock} locale={locale} loadAsset={changes.loadAsset}
            target={{isStage: target.isStage, name: target.name}}/>}
        {element.kind === 'costumes' && <div className="twgit-element-pictures">
            {(['before', 'after'] as const).map(version => <Picture key={version} md5ext={element.md5ext?.[version]} version={version}
                loadAsset={changes.loadAsset} labels={labels} title={`${labels[version]} · ${String(element[version]?.name ?? '')}`}/>)}
        </div>}
        {element.kind !== 'code' && element.kind !== 'costumes' && <table className="twgit-element-values">
            <thead><tr><th>{labels.property}</th><th>{labels.before}</th><th>{labels.after}</th></tr></thead>
            <tbody>{rows.map(([key, name]) => <tr key={key}>
                <th scope="row">{name}</th>
                <td>{record('before') ? show(record('before')![key]) : labels.absent}</td>
                <td>{record('after') ? show(record('after')![key]) : labels.absent}</td>
            </tr>)}</tbody>
        </table>}
        <details className="twgit-element-files"><summary>{labels.files}</summary>
            <ul>{element.files.map(file => <li key={file.group + ':' + file.path}><button className="twgit-file" type="button"
                onClick={() => onSelectFile(file)}>{file.path} <small>{labels.groups[file.group]}</small></button></li>)}</ul>
        </details>
    </section>;
}
