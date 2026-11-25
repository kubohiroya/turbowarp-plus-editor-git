import {GitPanelError} from './filesystem.js';
import {
    mergeProjectFolder, resolveProjectFolder, type FileVersions, type FolderConflict, type FolderMergeResult
} from './project-folder-merge.js';
import {checkProject, formatProjectSource, parseSourceProject, type MergeSide, type SourceTarget} from './project-source-merge.js';
import {equal, isRecord} from './project-source-patch.js';
import {projectVersionFile} from './project-version.js';

export interface MergePlanBranch {
    name: string;
    ref: string;
}

type MergePlanTip = MergePlanBranch & {oid: string};

interface MergePlanInputs {
    base: string;
    current: MergePlanTip;
    incoming: MergePlanTip;
}

export type MergePlanChoices = Readonly<Record<string, MergeSide>>;
export type MergePlanFiles = ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
export type MergePlanSeed = FolderMergeResult;

export interface MergePlanConflict {
    id: string;
    path: string;
    type: FolderConflict['type'];
    target?: string;
    detail?: string;
}

/** One immutable generation of a plan. The candidate's bytes and three-way inputs are stored separately. */
export interface MergePlan {
    readonly id: string;
    readonly planId: string;
    readonly previousId: string | null;
    readonly copiedFrom: string | null;
    readonly seedId: string;
    readonly contentId: string;
    readonly createdAt: number;
    readonly folder: string;
    readonly inputs: MergePlanInputs;
    readonly conflicts: readonly MergePlanConflict[];
    readonly choices: MergePlanChoices;
    readonly problems: number;
    readonly edited?: boolean;
}

export interface MergePlanBuild {
    plan: MergePlan;
    files: MergePlanFiles;
    seed?: MergePlanSeed;
}

function summarize({id, path, type, ...rest}: FolderConflict): MergePlanConflict {
    const result = {id, path, type};
    if ('conflict' in rest && 'location' in rest.conflict) {
        const {location} = rest.conflict;
        const detail = location.type === 'property' ? location.path.join('.') : undefined;
        return {...result, target: location.target ?? undefined, detail};
    }
    if ('index' in rest) return {...result, detail: String(rest.index + 1)};
    return result;
}

async function contentId(files: MergePlanFiles) {
    const hash = async (bytes: Uint8Array<ArrayBuffer>) =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value =>
            value.toString(16).padStart(2, '0')).join('');
    const listing: Array<[string, string]> = [];
    for (const [path, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        listing.push([path, await hash(bytes)]);
    }
    return hash(new TextEncoder().encode(JSON.stringify(listing)));
}

function resolveFiles(seed: MergePlanSeed, choices: MergePlanChoices) {
    const result = resolveProjectFolder(seed, choices);
    const files = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const [path, content] of result.files) {
        if (content !== null) files.set(path, Uint8Array.from(content));
    }
    if (!files.has('project.source.json') || !files.has('sb3-source.json')) throw new GitPanelError('versionMissing');
    return {files, problems: result.problems.length};
}

async function snapshot(plan: Omit<MergePlan, 'contentId' | 'problems'>, files: MergePlanFiles, problems: number): Promise<MergePlanBuild> {
    return {plan: {...plan, contentId: await contentId(files), problems}, files};
}

function materialize(plan: Omit<MergePlan, 'contentId' | 'problems'>, seed: MergePlanSeed) {
    const {files, problems} = resolveFiles(seed, plan.choices);
    return snapshot(plan, files, problems);
}

export async function createMergePlan(folder: string, inputs: MergePlanInputs, versions: ReadonlyMap<string, FileVersions>) {
    const seed = mergeProjectFolder(versions);
    const id = crypto.randomUUID();
    const built = await materialize({
        id, planId: id, previousId: null, copiedFrom: null, seedId: id,
        createdAt: Date.now(), folder, inputs, conflicts: seed.conflicts.map(summarize), choices: {}
    }, seed);
    return {...built, seed};
}

/** Both plans start from the same snapshot. The copy gets an independent set of subsequent generations. */
export function duplicateMergePlan(plan: MergePlan): MergePlan {
    const id = crypto.randomUUID();
    return {...plan, id, planId: id, previousId: null, copiedFrom: plan.id, createdAt: Math.max(Date.now(), plan.createdAt + 1)};
}

const nextGeneration = (plan: MergePlan) =>
    ({...plan, id: crypto.randomUUID(), previousId: plan.id, createdAt: Math.max(Date.now(), plan.createdAt + 1)});

export function reviseMergePlan(plan: MergePlan, seed: MergePlanSeed, choices: MergePlanChoices, edited?: MergePlanFiles) {
    const specific = Object.fromEntries(plan.conflicts.flatMap(({id}) => {
        const side = choices[id];
        return side === 'base' || side === 'current' || side === 'incoming' ? [[id, side]] : [];
    }));
    const next = {...nextGeneration(plan), choices: specific};
    if (!plan.edited) return materialize(next, seed);
    if (!edited) throw new GitPanelError('versionMissing');
    // Reapply manual changes to the new choices. Never silently replace a hand-edited script.
    const base = resolveFiles(seed, plan.choices).files;
    const incoming = resolveFiles(seed, specific).files;
    const paths = new Set([...base.keys(), ...edited.keys(), ...incoming.keys()]);
    const combined = mergeProjectFolder(new Map([...paths].map(path => [path, {
        base: base.get(path) ?? null, current: edited.get(path) ?? null, incoming: incoming.get(path) ?? null
    }])));
    if (combined.conflicts.length) throw new GitPanelError('mergePlanEditConflict');
    return materialize({...next, choices: specific}, combined);
}

export interface MergePlanCodeEdit {
    before: string;
    after: string;
}

const targetKey = (target: SourceTarget) => target.isStage ? 'stage' : 'sprite:' + target.name;
const decoder = new TextDecoder('utf-8', {fatal: true});
const encoder = new TextEncoder();
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const entries = (value: unknown) => Object.entries(record(value));

function updateEntries(original: unknown, before: unknown, after: unknown,
    change: (saved: unknown, prior: unknown, value: unknown) => unknown = (_saved, _prior, value) => value) {
    const result = new Map(entries(original));
    const prior = new Map(entries(before));
    const next = new Map(entries(after));
    for (const [id, value] of next) {
        if (equal(prior.get(id), value)) continue;
        const updated = change(result.get(id), prior.get(id), value);
        if (updated !== undefined) result.set(id, updated);
    }
    for (const id of prior.keys()) if (!next.has(id)) result.delete(id);
    return Object.fromEntries(result);
}

/** Apply only code changes relative to the loaded VM. Keep the candidate's assets and initial runtime state. */
export async function editMergePlan(plan: MergePlan, files: MergePlanFiles, edit: MergePlanCodeEdit) {
    const path = 'project.source.json';
    const original = files.get(path);
    if (!original) throw new GitPanelError('versionMissing');
    const project = parseSourceProject(decoder.decode(original));
    const before = parseSourceProject(edit.before);
    const after = parseSourceProject(edit.after);
    if (!project || !before || !after) throw new GitPanelError('mergePlanEditUnsupported');
    const oldTargets = new Map(before.targets.map(target => [targetKey(target), target]));
    const newTargets = new Map(after.targets.map(target => [targetKey(target), target]));
    const previousUrls = record(before.extensionURLs);
    if (project.targets.length !== oldTargets.size || project.targets.length !== newTargets.size ||
        entries(after.extensionURLs).some(([id, url]) => !Object.hasOwn(previousUrls, id) || !equal(previousUrls[id], url))) {
        throw new GitPanelError('mergePlanEditUnsupported');
    }
    let changed = false;
    for (const target of project.targets) {
        const key = targetKey(target);
        const old = oldTargets.get(key);
        const next = newTargets.get(key);
        if (!old || !next || !equal(old.costumes, next.costumes) || !equal(old.sounds, next.sounds)) {
            throw new GitPanelError('mergePlanEditUnsupported');
        }
        if (!equal(record(old.blocks), record(next.blocks)) || !equal(record(old.comments), record(next.comments))) {
            // Keep the entire block graph and its comments together because the VM can serialize different block IDs.
            target.blocks = record(next.blocks);
            target.comments = record(next.comments);
            changed = true;
        }
        const broadcasts = updateEntries(target.broadcasts, old.broadcasts, next.broadcasts);
        if (!equal(record(target.broadcasts), broadcasts)) {
            target.broadcasts = broadcasts;
            changed = true;
        }
        for (const field of ['variables', 'lists'] as const) {
            const value = updateEntries(target[field], old[field], next[field], (saved, prior, entry) => {
                if (!Array.isArray(entry)) throw new GitPanelError('mergePlanEditUnsupported');
                if (Array.isArray(prior) && prior[0] === entry[0] && equal(prior.slice(2), entry.slice(2))) return;
                return [entry[0], Array.isArray(saved) ? saved[1] : field === 'variables' ? 0 : [], ...entry.slice(2)];
            });
            if (equal(record(target[field]), value)) continue;
            target[field] = value;
            changed = true;
        }
    }
    if (!changed) throw new GitPanelError('mergePlanEditUnchanged');
    if (!equal(before.extensions, after.extensions) && Array.isArray(after.extensions)) project.extensions = after.extensions;
    const updated = new Map(files);
    updated.set(path, encoder.encode(formatProjectSource(project)));
    return snapshot({...nextGeneration(plan), edited: true}, updated, checkProject(project).length);
}

/** Every playtest receives a fresh copy of the selected generation's project files. */
export function mergePlanPreviewFiles(files: MergePlanFiles): MergePlanFiles {
    return new Map([...files].filter(([path]) => projectVersionFile(path) ||
        path === 'block-palette.json' || path === '.tw-plus/workspace.json').map(([path, bytes]) => [path, bytes.slice()]));
}
