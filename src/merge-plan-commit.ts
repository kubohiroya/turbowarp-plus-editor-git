import * as git from 'isomorphic-git';
import {errorCode, GitPanelError, pathParts} from './filesystem.js';
import {mergePlanConflictResolved, mergePlanContentId, mergePlanPreviewFiles, type MergePlan, type MergePlanFiles} from './merge-plan.js';
import {checkProject, parseSourceProject} from './project-source-merge.js';
import {projectScope} from './project-version.js';

type ReadOptions = {fs: git.PromiseFsClient & {promises: {stat(path: string): Promise<{isDirectory(): boolean}>}};
    dir: string; gitdir: string; cache: object};
type Change = {path: string; relative: string; before: string | null; after: string | null};
export type ValidateMergeProject = (files: MergePlanFiles) => void;

function readStat(options: ReadOptions, path: string) {
    return options.fs.promises.stat('/' + path).catch(error => {
        if (['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '')) return null;
        throw error;
    });
}

export async function assertMergeCommitTips(options: ReadOptions, {inputs: {current, incoming}}: MergePlan) {
    if (current.ref !== 'refs/heads/' + current.name || current.ref === incoming.ref ||
        !/^refs\/(?:heads|remotes\/origin)\/.+/u.test(incoming.ref)) throw new GitPanelError('mergeCommitInvalid');
    projectScope(current.ref);
    projectScope(incoming.ref);
    for (const path of ['index.lock', 'HEAD.lock', 'packed-refs.lock', current.ref + '.lock', incoming.ref + '.lock',
        'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        if (await readStat(options, '.git/' + path)) throw new GitPanelError('locked');
    }
    const resolve = (ref: string) => git.resolveRef({...options, ref}).catch(error => {
        if (errorCode(error) === 'NotFoundError') throw new GitPanelError('mergeCommitTipsChanged');
        throw error;
    });
    if (await git.currentBranch(options) !== current.name || await resolve('HEAD') !== current.oid ||
        await resolve(current.ref) !== current.oid || await resolve(incoming.ref) !== incoming.oid) {
        throw new GitPanelError('mergeCommitTipsChanged');
    }
}

/** Ignored files still cannot be overwritten. The browser cannot replace directory/file kinds transactionally. */
async function assertNewPathsFree(options: ReadOptions, changes: readonly Change[]) {
    const checked = new Set<string>();
    for (const {path, before, after} of changes) {
        if (before || !after) continue;
        if (await readStat(options, path)) throw new GitPanelError('mergeCommitDirty');
        let parent = '';
        for (const part of pathParts(path).slice(0, -1)) {
            parent = parent ? parent + '/' + part : part;
            if (checked.has(parent)) continue;
            const stat = await readStat(options, parent);
            if (stat && !stat.isDirectory()) throw new GitPanelError('unsupported');
            checked.add(parent);
        }
    }
}

export async function assertMergeCommitClean(options: ReadOptions, prepared = false) {
    const status = await git.statusMatrix({...options, refresh: false});
    if (status.some(([, head, worktree, stage]) => worktree !== stage || (!prepared && head !== stage))) {
        throw new GitPanelError('mergeCommitDirty');
    }
}

/** A merge records both parents for the repository, so do not silently discard an incoming change outside the plan. */
async function currentFiles(options: ReadOptions, plan: MergePlan, prefix: string) {
    const paths = new Map<string, string>();
    const {base, current, incoming} = plan.inputs;
    await git.walk({...options, trees: [base, current.oid, incoming.oid].map(ref => git.TREE({ref})),
        map: async (path, [old, ours, theirs]) => {
            if (path === '.') return true;
            if (!prefix || path.startsWith(prefix)) {
                if (!ours || await ours.type() === 'tree') return true;
                if (await ours.type() !== 'blob' || await ours.mode() !== 0o100644) throw new GitPanelError('unsupported');
                paths.set(path, await ours.oid());
                return true;
            }
            const types = await Promise.all([old, ours, theirs].map(entry => entry?.type()));
            if (prefix.startsWith(path + '/')) {
                if (types.some(type => type && type !== 'tree')) throw new GitPanelError('mergeCommitOutsideProject');
                return true;
            }
            const version = async (entry: git.WalkerEntry | null) =>
                entry ? `${await entry.mode()}:${await entry.oid()}` : null;
            const [baseVersion, currentVersion, incomingVersion] = await Promise.all([old, ours, theirs].map(version));
            if (incomingVersion === baseVersion || incomingVersion === currentVersion) return null;
            if (types.every(type => !type || type === 'tree')) return true;
            throw new GitPanelError('mergeCommitOutsideProject');
        }});
    return paths;
}

export async function prepareMergeCommit(options: ReadOptions, plan: MergePlan, files: MergePlanFiles,
    validate: ValidateMergeProject): Promise<Change[]> {
    const folder = projectScope(plan.folder);
    await assertMergeCommitTips(options, plan);
    if (plan.inputs.base === plan.inputs.incoming.oid || plan.inputs.current.oid === plan.inputs.incoming.oid) {
        throw new GitPanelError('mergeCommitIntegrated');
    }
    if (plan.conflicts.some(({id}) => !mergePlanConflictResolved(plan, id))) throw new GitPanelError('mergeCommitUnresolved');
    if (await mergePlanContentId(files) !== plan.contentId) throw new GitPanelError('mergeCommitInvalid');
    try {
        const source = files.get('project.source.json');
        const project = source && parseSourceProject(new TextDecoder('utf-8', {fatal: true}).decode(source));
        if (!project || checkProject(project).length) throw new Error('Invalid project references');
        validate(mergePlanPreviewFiles(files));
    } catch {
        throw new GitPanelError('mergeCommitInvalid');
    }
    await assertMergeCommitClean(options);
    const prefix = folder ? folder + '/' : '';
    const old = await currentFiles(options, plan, prefix);
    const modified = new Map<string, Change>();
    const sorted = [...files.keys()].sort();
    for (const relative of sorted) {
        if (!relative || projectScope(relative) !== relative) throw new GitPanelError('mergeCommitInvalid');
        const parts = relative.split('/');
        if (parts.some((_, index) => index > 0 && files.has(parts.slice(0, index).join('/')))) {
            throw new GitPanelError('mergeCommitInvalid');
        }
        const path = prefix + relative;
        const before = old.get(path) ?? null;
        const {oid: after} = await git.hashBlob({object: files.get(relative)!});
        old.delete(path);
        if (before !== after) modified.set(path, {path, relative, before, after});
    }
    for (const [path, before] of old) modified.set(path, {path, relative: path.slice(prefix.length), before, after: null});
    const changes = [...modified.values()].sort((a, b) => a.path < b.path ? -1 : 1);
    await assertNewPathsFree(options, changes);
    return changes;
}
