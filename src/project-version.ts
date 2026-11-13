import * as git from 'isomorphic-git';
import type {createMutationFs} from './mutation-fs.js';
import {GitPanelError, pathParts} from './filesystem.js';

export function projectScope(folder: string): string {
    const parts = pathParts(folder);
    if (parts.join('/') !== folder || parts.some(part => !safePart(part))) throw new GitPanelError('invalid');
    return folder;
}

function safePart(part: string): boolean {
    return part.toLowerCase() !== '.git' && !/[\\\x00-\x1f\x7f]/u.test(part);
}

/** The sb3-toolchain project inputs, relative to the selected project's root. */
export function projectVersionFile(path: string): boolean {
    const parts = pathParts(path);
    if (!parts.length || parts.join('/') !== path || parts.some(part => !safePart(part))) return false;
    return parts.length === 1 ? ['project.source.json', 'sb3-source.json', 'embedded-extensions.json'].includes(path) :
        ['assets', 'extensions'].includes(parts[0]);
}

export interface ProjectRestorePlan {
    oid: string;
    folder: string;
    branch: string;
    head: string;
    changes: {path: string; before: string | null; after: string | null}[];
}

type GitOptions = {fs: ReturnType<typeof createMutationFs>['fs']; dir: string; gitdir: string; cache: object};

/** Use the same tree and path selection for the confirmation and for applying it. */
export async function planProjectRestore(options: GitOptions, oid: string, folder: string): Promise<ProjectRestorePlan> {
    const scope = projectScope(folder);
    if (!/^[a-f0-9]{40}$/.test(oid)) throw new GitPanelError('invalid');
    await git.readCommit({...options, oid});
    const branch = await git.currentBranch(options);
    const head = await git.resolveRef({...options, ref: 'HEAD'});
    if (!branch) throw new GitPanelError('unsupported');
    const prefix = scope ? scope + '/' : '';
    const sourcePath = prefix + 'project.source.json';
    const file = async (entry: git.WalkerEntry | null) => {
        if (!entry || await entry.type() === 'tree') return null;
        if (await entry.type() !== 'blob' || await entry.mode() !== 0o100644) throw new GitPanelError('unsupported');
        return entry.oid();
    };
    let hasProject = false;
    const changes = await git.walk({...options, trees: [git.TREE({ref: head}), git.TREE({ref: oid})],
        map: async (path, [before, after]) => {
            if (path === '.') return;
            if (!path.startsWith(prefix)) return prefix.startsWith(path + '/') ? undefined : null;
            const relative = path.slice(prefix.length);
            if (!projectVersionFile(relative)) {
                return ['', 'assets', 'extensions'].includes(relative) ? undefined : null;
            }
            const change = {path, before: await file(before), after: await file(after)};
            if (path === sourcePath && change.after) hasProject = true;
            return change.before !== change.after ? change : undefined;
        }}) as ProjectRestorePlan['changes'];
    if (!hasProject) throw new GitPanelError('versionMissing');
    return {oid, folder, branch, head, changes: changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)};
}
