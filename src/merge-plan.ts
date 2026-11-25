import {GitPanelError} from './filesystem.js';
import {
    mergeProjectFolder, resolveProjectFolder, type FileVersions, type FolderConflict, type FolderMergeResult
} from './project-folder-merge.js';
import type {MergeSide} from './project-source-merge.js';
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

async function materialize(plan: Omit<MergePlan, 'contentId' | 'problems'>, seed: MergePlanSeed): Promise<MergePlanBuild> {
    const result = resolveProjectFolder(seed, plan.choices);
    const files = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const [path, content] of result.files) {
        if (content !== null) files.set(path, Uint8Array.from(content));
    }
    if (!files.has('project.source.json') || !files.has('sb3-source.json')) throw new GitPanelError('versionMissing');
    return {plan: {...plan, contentId: await contentId(files), problems: result.problems.length}, files};
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

export function reviseMergePlan(plan: MergePlan, seed: MergePlanSeed, choices: MergePlanChoices) {
    const specific = Object.fromEntries(plan.conflicts.flatMap(({id}) => {
        const side = choices[id];
        return side === 'base' || side === 'current' || side === 'incoming' ? [[id, side]] : [];
    }));
    return materialize({...plan, id: crypto.randomUUID(), previousId: plan.id,
        createdAt: Math.max(Date.now(), plan.createdAt + 1), choices: specific}, seed);
}

/** Every playtest receives a fresh copy of the selected generation's project files. */
export function mergePlanPreviewFiles(files: MergePlanFiles): MergePlanFiles {
    return new Map([...files].filter(([path]) => projectVersionFile(path) ||
        path === 'block-palette.json' || path === '.tw-plus/workspace.json').map(([path, bytes]) => [path, bytes.slice()]));
}
