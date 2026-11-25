import {GitPanelError} from './filesystem.js';
import {mergeProjectFolder, type FileVersions, type FolderConflict} from './project-folder-merge.js';
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

export interface MergePlan {
    readonly id: string;
    readonly parentId: string | null;
    readonly folder: string;
    readonly inputs: MergePlanInputs;
    readonly conflicts: readonly Pick<FolderConflict, 'id' | 'path' | 'type'>[];
    readonly problems: number;
    /** Gives the player a new copy of the candidate's source, without unrelated repository files. */
    previewFiles(): ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
}

export function createMergePlan(folder: string, inputs: MergePlanInputs, versions: ReadonlyMap<string, FileVersions>): MergePlan {
    const merged = mergeProjectFolder(versions);
    const files = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const {path, content} of merged.files) {
        if (content !== null) files.set(path, Uint8Array.from(content));
    }
    if (!files.has('project.source.json') || !files.has('sb3-source.json')) throw new GitPanelError('versionMissing');
    return {
        id: crypto.randomUUID(),
        parentId: null,
        folder,
        inputs,
        conflicts: merged.conflicts.map(({id, path, type}) => ({id, path, type})),
        problems: merged.problems.length,
        previewFiles: () => {
            const project = new Map<string, Uint8Array<ArrayBuffer>>();
            for (const [path, content] of files) {
                if (projectVersionFile(path) || path === 'block-palette.json' || path === '.tw-plus/workspace.json') {
                    project.set(path, content.slice());
                }
            }
            return project;
        }
    };
}

/** Copies the plan's identity and lineage. Both plans start from the same immutable candidate. */
export function duplicateMergePlan(plan: MergePlan): MergePlan {
    return {...plan, id: crypto.randomUUID(), parentId: plan.id};
}
