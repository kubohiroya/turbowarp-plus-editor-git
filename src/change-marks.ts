import type {FileChange} from './repository.js';

/** How a file stands in Git, as a folder explorer marks it. */
export type ChangeMark = 'added' | 'modified' | 'deleted' | 'untracked';
export type FileVersion = {oid: string; mode: number};
export type FileStatus = {
    change?: ChangeMark;
    staged?: boolean;
    revision?: 'committed' | 'pushed' | 'merged';
};

export type MergedFileVersions = ReadonlyMap<string, readonly FileVersion[]>;

/**
 * The marks of the working tree's changes under `folder` (a path inside the repository, '' for its root), by path
 * relative to `folder`. A file with both staged and unstaged changes is marked as its working tree stands.
 */
export function changeMarks(changes: readonly FileChange[], folder: string): Map<string, ChangeMark> {
    const prefix = folder.replace(/^\/+|\/+$/gu, '');
    const marks = new Map<string, ChangeMark>();
    for (const group of ['staged', 'unstaged', 'untracked'] as const) {
        for (const change of changes) {
            if (change.group !== group) continue;
            if (prefix && !change.path.startsWith(prefix + '/')) continue;
            const path = prefix ? change.path.slice(prefix.length + 1) : change.path;
            marks.set(path, group === 'untracked' ? 'untracked' : !change.after ? 'deleted' : !change.before ? 'added' : 'modified');
        }
    }
    return marks;
}

/** Compares the saved file with HEAD, then checks the upstream and merge evidence for clean files. */
export function fileStatuses(changes: readonly FileChange[], committed: ReadonlyMap<string, FileVersion>,
    upstream: ReadonlyMap<string, FileVersion>, merged: MergedFileVersions, folder: string): Map<string, FileStatus> {
    const prefix = folder ? folder + '/' : '';
    const indexed = new Map(changes.filter(change => change.group === 'staged').map(change => [change.path, change]));
    const working = new Map(changes.filter(change => change.group === 'unstaged' || change.group === 'untracked')
        .map(change => [change.path, change]));
    const statuses = new Map<string, FileStatus>();
    for (const path of new Set([...indexed.keys(), ...working.keys()])) {
        if (!path.startsWith(prefix)) continue;
        const index = indexed.get(path);
        const disk = working.get(path);
        const before = (index ?? disk)!.before;
        const after = (disk ?? index)!.after;
        const modeChanged = (index ?? disk)!.oldMode !== (disk ?? index)!.newMode;
        const staged = Boolean(index);
        let change: ChangeMark | undefined;
        if (before !== after || modeChanged) {
            if (after === null) change = 'deleted';
            else if (before === null) change = staged ? 'added' : 'untracked';
            else change = 'modified';
        }
        if (change || staged) statuses.set(path.slice(prefix.length), {change, staged});
    }
    for (const [path, version] of committed) {
        if (!path.startsWith(prefix)) continue;
        const relative = path.slice(prefix.length);
        if (statuses.has(relative)) continue;
        const matches = (other: FileVersion | undefined) => other?.oid === version.oid && other.mode === version.mode;
        const revision = merged.get(path)?.some(matches) ? 'merged' : matches(upstream.get(path)) ? 'pushed' : 'committed';
        statuses.set(relative, {revision});
    }
    return statuses;
}
