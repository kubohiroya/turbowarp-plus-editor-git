import type {ChangeGroup} from './repository.js';
import {equal, isRecord, targetKey} from './project-source-patch.js';
import type {ProjectSource, ProjectTarget} from './project-source-patch.js';
import {compareProjectForReview} from './project-source-review-model.js';

/** One changed file of the repository, with the Git group it was listed under. A path can appear in several groups. */
export interface ChangedFile {
    path: string;
    group: ChangeGroup;
}

export type ProjectElementKind = 'code' | 'costumes' | 'sounds' | 'data' | 'settings';
export type ProjectChangeStatus = 'added' | 'removed' | 'updated';

/** One row of the project-shaped change list: something a person recognizes in the Editor. */
export interface ProjectElementChange {
    /** Stable within one list, for React keys and selection. */
    key: string;
    kind: ProjectElementKind;
    status: ProjectChangeStatus;
    /** Costume or sound name; absent for code, data and settings rows. */
    name?: string;
    /** The costume or sound entry in each version, for costume and sound rows. */
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    /** Asset file names (`md5ext`) of each version, for costume and sound rows. */
    md5ext?: {before?: string; after?: string};
    /**
     * Changed property keys, for data and settings rows (for example `variables`, `x`, `visible`), and for
     * project-level rows (`monitors`, `extensions`, `meta`).
     */
    properties?: string[];
    /** Number of changed code items (as counted by the review comparison), for code rows. */
    scripts?: number;
    /** The changed repository files behind this row, so the details view can show them with their Git groups. */
    files: ChangedFile[];
}

export interface ProjectTargetChanges {
    key: string;
    name: string;
    isStage: boolean;
    status: ProjectChangeStatus;
    before?: ProjectTarget;
    after?: ProjectTarget;
    /** In the order code, costumes, sounds, data, settings; costumes and sounds in their order in the target. */
    elements: ProjectElementChange[];
}

export interface ProjectChangeList {
    /** The stage first, then sprites in project order; removed targets after the existing ones. */
    targets: ProjectTargetChanges[];
    /** Project-level changes outside the targets (monitors, extensions, meta and other top-level keys). */
    project: ProjectElementChange[];
    /** Changed files that belong to no element: sb3-source.json, embedded-extensions.json, unreferenced assets and the rest. */
    other: ChangedFile[];
}

export interface OrganizeProjectChangesInput {
    /** The project folder relative to the repository root, `''` for the root. */
    folder: string;
    /** The project data of each version, `null` where the version has no project file. */
    before: ProjectSource | null;
    after: ProjectSource | null;
    /** The assets directory of each version, relative to the folder (from sb3-source.json; `assets` by default). */
    assetsDirectory: {before: string; after: string};
    /** Every changed file in the folder, from all Git groups. */
    files: readonly ChangedFile[];
}

const targetDataKeys = ['variables', 'lists', 'broadcasts'] as const;
const nonSettingKeys = new Set(['blocks', 'costumes', 'sounds', ...targetDataKeys]);

const propertyLabels = new Map<string, readonly [string, string]>([
    ['variables', ['変数', 'Variables']], ['lists', ['リスト', 'Lists']], ['broadcasts', ['メッセージ', 'Broadcast messages']],
    ['costumes', ['コスチューム・背景', 'Costumes and backdrops']], ['sounds', ['音', 'Sounds']], ['blocks', ['コード', 'Code']],
    ['x', ['X 座標', 'X position']], ['y', ['Y 座標', 'Y position']], ['size', ['大きさ', 'Size']],
    ['direction', ['向き', 'Direction']], ['visible', ['表示状態', 'Visibility']],
    ['currentCostume', ['表示するコスチューム', 'Selected costume']], ['layerOrder', ['重なり順', 'Layer order']],
    ['volume', ['音量', 'Volume']], ['comments', ['コメント', 'Comments']], ['draggable', ['ドラッグ可否', 'Draggable']],
    ['rotationStyle', ['回転方法', 'Rotation style']], ['tempo', ['テンポ', 'Tempo']],
    ['videoTransparency', ['ビデオの透明度', 'Video transparency']], ['videoState', ['ビデオの状態', 'Video state']],
    ['textToSpeechLanguage', ['音声合成の言語', 'Text to speech language']], ['monitors', ['モニター', 'Monitors']],
    ['extensions', ['拡張機能', 'Extensions']], ['meta', ['作品の情報', 'Project metadata']]
]);

/** The Japanese or English name of a project or target property key; unknown keys are returned as they are. */
export function projectPropertyLabel(key: string, locale = 'en'): string {
    return propertyLabels.get(key)?.[locale.startsWith('ja') ? 0 : 1] ?? key;
}

/** The asset file name of a costume or sound entry: `md5ext`, or `assetId.dataFormat`; `''` when it has neither. */
export function assetFileName(entry: Record<string, unknown>): string {
    if (typeof entry.md5ext === 'string') return entry.md5ext;
    return typeof entry.assetId === 'string' && typeof entry.dataFormat === 'string' ? entry.assetId + '.' + entry.dataFormat : '';
}

function joinPath(...parts: string[]) {
    return parts.flatMap(part => part.split('/')).filter(part => part !== '' && part !== '.').join('/');
}

function statusOf(before: unknown, after: unknown): ProjectChangeStatus {
    return before === undefined ? 'added' : after === undefined ? 'removed' : 'updated';
}

function entriesOf(target: ProjectTarget | undefined, kind: 'costumes' | 'sounds') {
    const list = (target as Record<string, unknown> | undefined)?.[kind];
    return Array.isArray(list) ? list.filter(isRecord) : [];
}

function nameOf(entry: Record<string, unknown>) {
    return typeof entry.name === 'string' ? entry.name : '';
}

/** Pairs the entries of two versions by name (repeated names pair in order): after's order first, then removed ones. */
function pairEntries(before: Record<string, unknown>[], after: Record<string, unknown>[]) {
    const remaining = new Map<string, Record<string, unknown>[]>();
    for (const entry of before) {
        const queue = remaining.get(nameOf(entry));
        if (queue) queue.push(entry);
        else remaining.set(nameOf(entry), [entry]);
    }
    const pairs: {name: string; before?: Record<string, unknown>; after?: Record<string, unknown>}[] = [];
    for (const entry of after) pairs.push({name: nameOf(entry), before: remaining.get(nameOf(entry))?.shift(), after: entry});
    for (const entry of before) {
        const queue = remaining.get(nameOf(entry));
        if (queue?.[0] === entry) pairs.push({name: nameOf(entry), before: queue.shift()});
    }
    return pairs;
}

function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>, skip: (key: string) => boolean) {
    return [...new Set([...Object.keys(after), ...Object.keys(before)])].filter(key => !skip(key) && !equal(before[key], after[key]));
}

/** Arranges the changed files of one project folder by stage, sprite and element. Pure; reads nothing. */
export function organizeProjectChanges(input: OrganizeProjectChangesInput): ProjectChangeList {
    const {folder, files, assetsDirectory} = input;
    const normalize = (project: ProjectSource | null): ProjectSource => project === null ? {targets: []} :
        {...project, targets: project.targets.map(target => ({...target, blocks: target.blocks ?? {}}))};
    const before = normalize(input.before), after = normalize(input.after);
    const projectPath = joinPath(folder, 'project.source.json');
    const projectFiles = files.filter(file => file.path === projectPath);
    const explained = new Set<string>();
    let projectUsed = false;
    const useProject = () => {
        projectUsed = true;
        return [...projectFiles];
    };
    const filesAt = (paths: (string | undefined)[]) => {
        const wanted = new Set(paths.filter((path): path is string => path !== undefined));
        const found = files.filter(file => wanted.has(file.path));
        for (const file of found) explained.add(file.path);
        return found;
    };

    const review = compareProjectForReview(before, after);
    const scripts = new Map(review.targets.map(target => [targetKey((target.after ?? target.before)!), target.scripts.length]));
    const oldTargets = new Map(before.targets.map(target => [targetKey(target), target]));
    const newTargets = new Map(after.targets.map(target => [targetKey(target), target]));
    const keys = [...new Set([...after.targets, ...before.targets].map(targetKey))];
    keys.sort((a, b) => Number(b === 'stage') - Number(a === 'stage'));

    const targets: ProjectTargetChanges[] = [];
    for (const key of keys) {
        const a = oldTargets.get(key), b = newTargets.get(key);
        const status = statusOf(a, b);
        const elements: ProjectElementChange[] = [];
        const count = scripts.get(key) ?? 0;
        if (count) {
            elements.push({key: JSON.stringify([key, 'code', '']), kind: 'code', status, scripts: count, files: useProject()});
        }
        for (const kind of ['costumes', 'sounds'] as const) {
            const seen = new Map<string, number>();
            for (const pair of pairEntries(entriesOf(a, kind), entriesOf(b, kind))) {
                const md5ext = {before: pair.before && assetFileName(pair.before) || undefined, after: pair.after && assetFileName(pair.after) || undefined};
                const differs = !equal(pair.before, pair.after);
                const assets = filesAt([md5ext.before && joinPath(folder, assetsDirectory.before, md5ext.before),
                    md5ext.after && joinPath(folder, assetsDirectory.after, md5ext.after)]);
                if (!differs && !assets.length) continue;
                const repeat = seen.get(pair.name) ?? 0;
                seen.set(pair.name, repeat + 1);
                elements.push({
                    key: JSON.stringify(repeat ? [key, kind, pair.name, repeat] : [key, kind, pair.name]), kind, status: statusOf(pair.before, pair.after),
                    name: pair.name, before: pair.before, after: pair.after, md5ext, files: [...(differs ? useProject() : []), ...assets]
                });
            }
        }
        if (a && b) {
            const oldFields = a as unknown as Record<string, unknown>, newFields = b as unknown as Record<string, unknown>;
            const data = changedKeys(oldFields, newFields, property => !(targetDataKeys as readonly string[]).includes(property));
            if (data.length) elements.push({key: JSON.stringify([key, 'data', '']), kind: 'data', status, properties: data, files: useProject()});
            const settings = changedKeys(oldFields, newFields, property => nonSettingKeys.has(property));
            if (settings.length) {
                elements.push({key: JSON.stringify([key, 'settings', '']), kind: 'settings', status, properties: settings, files: useProject()});
            }
        } else {
            projectUsed = true;
        }
        if (status !== 'updated' || elements.length) {
            const {name, isStage} = (b ?? a)!;
            targets.push({key, name, isStage, status, before: a, after: b, elements});
        }
    }

    const project = changedKeys(before, after, key => key === 'targets').map((property): ProjectElementChange => ({
        key: JSON.stringify(['project', 'settings', property]), kind: 'settings', status: statusOf(before[property], after[property]),
        properties: [property], files: useProject()
    }));
    if (projectUsed) explained.add(projectPath);
    return {targets, project, other: files.filter(file => !explained.has(file.path))};
}
