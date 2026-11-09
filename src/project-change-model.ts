import type {ChangeGroup} from './repository.js';
import type {ProjectSource, ProjectTarget} from './project-source-patch.js';

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

/** Arranges the changed files of one project folder by stage, sprite and element. Pure; reads nothing. */
export function organizeProjectChanges(input: OrganizeProjectChangesInput): ProjectChangeList {
    void input;
    throw new Error('Not implemented yet.');
}
