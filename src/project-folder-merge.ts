import {isRecord} from './project-source-patch.js';
import {defaultKey, mergeJson, orderKeys, writeJsonPath, type JsonConflict} from './merge-json.js';
import {mergeText, renderText, type TextMergeResult} from './merge-text.js';
import {
    formatProjectSource, mergeProjectSource, parseSourceProject, resolveProjectSource,
    type MergeSide, type ProjectConflict, type ProjectMergeResult, type ProjectProblem, type SourceProject
} from './project-source-merge.js';

/** A file's bytes, or `null` when the file does not exist on that side. */
export type FileBytes = Uint8Array | null;

export interface FileVersions {
    base: FileBytes;
    current: FileBytes;
    incoming: FileBytes;
}

export type FolderConflict =
    | {id: string; path: string; type: 'project'; conflict: ProjectConflict}
    | {id: string; path: string; type: 'json'; conflict: JsonConflict}
    /** The `index`-th conflicting run of lines in a text file. */
    | {id: string; path: string; type: 'text'; index: number; base: string[]; current: string[]; incoming: string[]}
    /** A whole file: binary, unreadable, or removed on one side and changed on the other. */
    | {id: string; path: string; type: 'file'; base: FileBytes; current: FileBytes; incoming: FileBytes};

export type FileMergeKind = 'project' | 'json' | 'text' | 'asset' | 'file';

export interface FileMergeResult {
    path: string;
    kind: FileMergeKind;
    /** The content to start from: merged, with each conflict keeping the base. */
    content: FileBytes;
    conflicts: FolderConflict[];
}

export interface FolderMergeResult {
    /** Every path that exists on any side, sorted. */
    files: FileMergeResult[];
    conflicts: FolderConflict[];
    /** Problems in the merged project as it starts. */
    problems: ProjectProblem[];
    /** @internal State used by {@link resolveProjectFolder}. */
    readonly state: FolderMergeState;
}

interface FolderMergeState {
    versions: ReadonlyMap<string, FileVersions>;
    projectPath: string;
    assetsDirectory: string;
    project?: ProjectMergeResult;
    json: Map<string, {value: unknown; conflicts: JsonConflict[]}>;
    text: Map<string, TextMergeResult>;
    sideProjects: Array<SourceProject | null>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});

export function sameBytes(a: FileBytes, b: FileBytes): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** The side that a file takes without looking inside it, if the sides do not both change it differently. */
function trivial({base, current, incoming}: FileVersions): FileBytes | undefined {
    if (sameBytes(current, incoming) || sameBytes(base, incoming)) return current;
    if (sameBytes(base, current)) return incoming;
    return undefined;
}

function decode(bytes: FileBytes): string | null | undefined {
    if (bytes === null) return null;
    try {
        const text = decoder.decode(bytes);
        return text.includes('\u0000') ? undefined : text;
    } catch {
        return undefined;
    }
}

function parseJson(text: string | null): unknown {
    return text === null ? undefined : JSON.parse(text);
}

/** Reads `sb3-source.json` from the merged side contents for the project path and the assets directory. */
function readManifest(versions: ReadonlyMap<string, FileVersions>) {
    const manifest = versions.get('sb3-source.json');
    for (const bytes of [manifest?.current, manifest?.incoming, manifest?.base]) {
        try {
            const value = parseJson(decode(bytes ?? null) ?? null);
            if (isRecord(value)) {
                return {
                    projectPath: typeof value.project === 'string' ? value.project : 'project.source.json',
                    assetsDirectory: typeof value.assetsDirectory === 'string' ? value.assetsDirectory : 'assets'
                };
            }
        } catch {
            // Try the next side.
        }
    }
    return {projectPath: 'project.source.json', assetsDirectory: 'assets'};
}

/** The asset file names (`<assetId>.<dataFormat>`) that a project's costumes and sounds use. */
export function projectAssetNames(project: SourceProject | null | undefined): Set<string> {
    const names = new Set<string>();
    for (const target of project?.targets ?? []) {
        for (const list of [target.costumes, target.sounds]) {
            if (!Array.isArray(list)) continue;
            for (const asset of list) {
                if (!isRecord(asset)) continue;
                if (typeof asset.md5ext === 'string') names.add(asset.md5ext);
                else if (typeof asset.assetId === 'string' && typeof asset.dataFormat === 'string') {
                    names.add(`${asset.assetId}.${asset.dataFormat}`);
                }
            }
        }
    }
    return names;
}

/** Asset file names found anywhere in the conflict values, so that taking a side finds its files. */
function conflictValuesAssets(conflicts: readonly ProjectConflict[]): Set<string> {
    const names = new Set<string>();
    const visit = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(visit);
        else if (isRecord(value)) {
            if (typeof value.md5ext === 'string') names.add(value.md5ext);
            else if (typeof value.assetId === 'string' && typeof value.dataFormat === 'string') {
                names.add(`${value.assetId}.${value.dataFormat}`);
            }
            Object.values(value).forEach(visit);
        }
    };
    for (const conflict of conflicts) [conflict.base, conflict.current, conflict.incoming].forEach(visit);
    return names;
}

/**
 * Three-way merge of a project folder. `versions` maps each path (relative to the folder, with `/`) to its bytes on
 * each side. `project.source.json` merges by scripts (see `mergeProjectSource`), other JSON files key by key, text
 * files line by line, and asset files follow the merged project: an asset stays when the project uses it.
 */
export function mergeProjectFolder(versions: ReadonlyMap<string, FileVersions>): FolderMergeResult {
    const {projectPath, assetsDirectory} = readManifest(versions);
    const state: FolderMergeState = {versions, projectPath, assetsDirectory, json: new Map(), text: new Map(),
        sideProjects: []};
    const files: FileMergeResult[] = [];
    const project = versions.get(projectPath);
    let projectResult: ProjectMergeResult | undefined;
    if (project) {
        const sides = [project.base, project.current, project.incoming].map(bytes => {
            try {
                return parseSourceProject(decode(bytes) ?? null);
            } catch {
                return undefined;
            }
        });
        if (sides.every(side => side !== undefined)) {
            state.sideProjects = sides as Array<SourceProject | null>;
            const quick = trivial(project);
            if (quick === undefined) {
                projectResult = mergeProjectSource(sides[0]!, sides[1]!, sides[2]!);
                state.project = projectResult;
                files.push({path: projectPath, kind: 'project', content: encoder.encode(formatProjectSource(projectResult.project)),
                    conflicts: projectResult.conflicts.map(conflict => ({id: `${projectPath}#${conflict.id}`, path: projectPath,
                        type: 'project' as const, conflict}))});
            } else {
                files.push({path: projectPath, kind: 'project', content: quick, conflicts: []});
            }
        } else {
            files.push(mergeFile(projectPath, project, state));
        }
    }

    const mergedProject = projectResult?.project ?? parseMaybe(files.find(file => file.path === projectPath)?.content);
    const keep = projectAssetNames(mergedProject);
    for (const name of conflictValuesAssets(projectResult?.conflicts ?? [])) keep.add(name);
    const referencedSomewhere = new Set(state.sideProjects.flatMap(side => [...projectAssetNames(side)]));

    for (const [path, sides] of versions) {
        if (path === projectPath) continue;
        const asset = assetName(path, assetsDirectory);
        if (asset !== undefined && (keep.has(asset) || referencedSomewhere.has(asset))) {
            files.push({path, kind: 'asset', content: keep.has(asset) ? sides.current ?? sides.incoming ?? sides.base : null,
                conflicts: []});
            continue;
        }
        files.push(mergeFile(path, sides, state));
    }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const manifestFile = files.find(file => file.path === manifestPath);
    if (manifestFile) {
        const present = new Set(files.filter(file => file.content !== null).map(file => file.path));
        manifestFile.content = rewriteManifest(manifestFile.content, versions, path => present.has(path), assetsDirectory);
    }
    return {files, conflicts: files.flatMap(file => file.conflicts), problems: projectResult?.problems ?? [], state};
}

function parseMaybe(bytes: FileBytes | undefined): SourceProject | null {
    try {
        return parseSourceProject(decode(bytes ?? null) ?? null);
    } catch {
        return null;
    }
}

function assetName(path: string, assetsDirectory: string): string | undefined {
    const prefix = assetsDirectory.replace(/\/+$/, '') + '/';
    if (!path.startsWith(prefix)) return undefined;
    const name = path.slice(prefix.length);
    return name.includes('/') ? undefined : name;
}

const manifestPath = 'sb3-source.json';
const screenStateEntry = 'tw-plus/workspace.json';
const screenStatePath = '.tw-plus/workspace.json';

function withoutArchiveEntries(value: unknown) {
    if (!isRecord(value)) return value;
    const {archiveEntries: _, ...rest} = value;
    return rest;
}

/**
 * `archiveEntries` in `sb3-source.json` must list `project.json` and exactly the asset files (and the screen state
 * when it was listed), or the folder does not open. It is rebuilt from the final files, in the merged order of the
 * sides' lists, with assets that no side listed at the end.
 */
function rewriteManifest(content: FileBytes, versions: ReadonlyMap<string, FileVersions>, present: (path: string) => boolean,
    assetsDirectory: string): FileBytes {
    const text = decode(content);
    if (!text) return content;
    let manifest: unknown;
    try {
        manifest = JSON.parse(text);
    } catch {
        return content;
    }
    if (!isRecord(manifest)) return content;
    const sides = versions.get(manifestPath);
    const lists = [sides?.base, sides?.current, sides?.incoming].map(bytes => {
        try {
            const value = parseJson(decode(bytes ?? null) ?? null);
            return isRecord(value) && Array.isArray(value.archiveEntries) ?
                value.archiveEntries.filter((entry): entry is string => typeof entry === 'string') : [];
        } catch {
            return [];
        }
    });
    if (lists.every(list => !list.length) && !Array.isArray(manifest.archiveEntries)) return content;
    const prefix = assetsDirectory.replace(/\/+$/, '') + '/';
    const assets = [...versions.keys()].filter(path => assetName(path, assetsDirectory) !== undefined && present(path))
        .map(path => path.slice(prefix.length));
    const wanted = (entry: string) => entry === 'project.json' || assets.includes(entry) ||
        (entry === screenStateEntry && present(screenStatePath));
    const entries = orderKeys(lists[0], lists[1], lists[2]).filter(wanted);
    if (!entries.includes('project.json')) entries.unshift('project.json');
    for (const asset of [...assets].sort()) if (!entries.includes(asset)) entries.push(asset);
    const ordered: Record<string, unknown> = {};
    let placed = false;
    for (const [key, value] of Object.entries(manifest)) {
        if (key === 'archiveEntries') placed = true;
        ordered[key] = key === 'archiveEntries' ? entries : value;
    }
    if (!placed) ordered.archiveEntries = entries;
    const next = `${JSON.stringify(ordered, null, 2)}\n`;
    return next === text ? content : encoder.encode(next);
}

function mergeFile(path: string, sides: FileVersions, state: FolderMergeState): FileMergeResult {
    const quick = trivial(sides);
    if (quick !== undefined) return {path, kind: 'file', content: quick, conflicts: []};
    const fileConflict = (): FileMergeResult => ({path, kind: 'file', content: sides.base, conflicts: [{
        id: `${path}#file`, path, type: 'file', base: sides.base, current: sides.current, incoming: sides.incoming
    }]});
    if (sides.current === null || sides.incoming === null) return fileConflict();
    const texts = [sides.base, sides.current, sides.incoming].map(decode);
    if (texts.some(text => text === undefined)) return fileConflict();
    const [base, current, incoming] = texts as Array<string | null>;
    if (path.endsWith('.json')) {
        try {
            const values = [base, current, incoming].map(parseJson).map(value => path === manifestPath ?
                withoutArchiveEntries(value) : value);
            const merged = mergeJson(values[0], values[1], values[2], {arrayKey: () => undefined});
            state.json.set(path, merged);
            return {path, kind: 'json', content: encoder.encode(formatJson(merged.value, values, texts as Array<string | null>)),
                conflicts: merged.conflicts.map(conflict => ({id: `${path}#${JSON.stringify(conflict.path)}`, path,
                    type: 'json' as const, conflict}))};
        } catch {
            // Not valid JSON on some side: merge it as text.
        }
    }
    const merged = mergeText(base ?? '', current!, incoming!);
    state.text.set(path, merged);
    let index = 0;
    return {path, kind: 'text', content: encoder.encode(merged.text), conflicts: merged.chunks.flatMap(chunk =>
        chunk.type === 'conflict' ? [{id: `${path}#text:${index}`, path, type: 'text' as const, index: index++,
            base: chunk.base, current: chunk.current, incoming: chunk.incoming}] : [])};
}

/** Keeps a side's exact text when the merged value equals it, and formats it like the toolchain otherwise. */
function formatJson(value: unknown, values: unknown[], texts: Array<string | null>): string {
    for (const index of [1, 2, 0]) {
        if (texts[index] !== null && JSON.stringify(values[index]) === JSON.stringify(value)) return texts[index]!;
    }
    return `${JSON.stringify(value, null, 2)}\n`;
}

export interface FolderResolution {
    /** The final content of every path (`null` removes it). */
    files: Map<string, FileBytes>;
    /** Problems in the final project; resolve them before committing. */
    problems: ProjectProblem[];
    /** Conflicts without a choice; they keep the base. */
    unresolved: string[];
}

/**
 * The folder after taking the chosen side for each conflict (by `FolderConflict.id`). Asset files follow the final
 * project: an asset that a side's project used is kept exactly when the final project uses it.
 */
export function resolveProjectFolder(result: FolderMergeResult, choices: Readonly<Record<string, MergeSide>>): FolderResolution {
    const {state} = result;
    const files = new Map<string, FileBytes>();
    const choiceFor = (id: string) => choices[id];
    let finalProject: SourceProject | null = null;
    let problems: ProjectProblem[] = [];
    for (const file of result.files) {
        if (file.kind === 'asset') continue;
        if (file.kind === 'project' && state.project) {
            const prefix = `${file.path}#`;
            const projectChoices: Record<string, MergeSide> = {};
            for (const [id, side] of Object.entries(choices)) if (id.startsWith(prefix)) projectChoices[id.slice(prefix.length)] = side;
            const resolved = resolveProjectSource(state.project, projectChoices);
            finalProject = resolved.project;
            problems = resolved.problems;
            files.set(file.path, encoder.encode(formatProjectSource(resolved.project)));
            continue;
        }
        if (file.kind === 'json') {
            const merged = state.json.get(file.path)!;
            const value = structuredClone(merged.value);
            let root: unknown = value;
            for (const conflict of file.conflicts) {
                if (conflict.type !== 'json') continue;
                const side = choiceFor(conflict.id);
                if (!side || side === 'base') continue;
                if (!conflict.conflict.path.length) root = structuredClone(conflict.conflict[side]);
                else writeJsonPath(root, conflict.conflict.path, structuredClone(conflict.conflict[side]), defaultKey);
            }
            const versions = state.versions.get(file.path)!;
            const texts = [versions.base, versions.current, versions.incoming].map(bytes => decode(bytes) ?? null);
            files.set(file.path, root === undefined ? null :
                encoder.encode(formatJson(root, texts.map(text => text === null ? undefined : JSON.parse(text)), texts)));
            continue;
        }
        if (file.kind === 'text') {
            const merged = state.text.get(file.path)!;
            files.set(file.path, encoder.encode(renderText(merged.chunks, file.conflicts.map(conflict => choiceFor(conflict.id)))));
            continue;
        }
        const conflict = file.conflicts[0];
        const side = conflict ? choiceFor(conflict.id) : undefined;
        files.set(file.path, conflict && conflict.type === 'file' && side ? conflict[side] : file.content);
        if (file.kind === 'project') finalProject = parseMaybe(files.get(file.path));
    }
    if (!state.project) finalProject = parseMaybe(files.get(state.projectPath));
    const used = projectAssetNames(finalProject);
    for (const file of result.files) {
        if (file.kind !== 'asset') continue;
        const sides = state.versions.get(file.path)!;
        files.set(file.path, used.has(assetName(file.path, state.assetsDirectory)!) ?
            sides.current ?? sides.incoming ?? sides.base : null);
    }
    if (files.has(manifestPath)) {
        files.set(manifestPath, rewriteManifest(files.get(manifestPath)!, state.versions,
            path => files.get(path) != null, state.assetsDirectory));
    }
    return {files, problems, unresolved: result.conflicts.filter(conflict => !choices[conflict.id]).map(conflict => conflict.id)};
}
