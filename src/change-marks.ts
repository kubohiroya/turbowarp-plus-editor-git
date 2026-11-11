import type {FileChange} from './repository.js';

/** How a file stands in Git, as a folder explorer marks it. */
export type ChangeMark = 'added' | 'modified' | 'deleted' | 'untracked';

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
