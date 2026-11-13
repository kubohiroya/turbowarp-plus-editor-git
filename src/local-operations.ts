import * as git from 'isomorphic-git';
import {createReadOnlyFs, errorCode, GitPanelError, pathParts} from './filesystem.js';
import {createMutationFs} from './mutation-fs.js';
import {planProjectRestore, projectVersionFile} from './project-version.js';
import type {ProjectRestorePlan} from './project-version.js';

/** The name and email a commit records. */
export type GitAuthor = {name: string; email: string};
export type LocalOperation =
    | {kind: 'stage'; paths: readonly string[]}
    | {kind: 'unstage'; paths: readonly string[]}
    | {kind: 'commit'; message: string; author?: GitAuthor}
    | {kind: 'restoreProject'; plan: ProjectRestorePlan; author?: GitAuthor}
    /**
     * Creates `name` at HEAD, at the commit `at`, or at `origin/<name>` with `fromRemote`, and switches to it with
     * `checkout`. With `reuse` (only with `at`), a branch `name` that already points at `at` is switched to instead of
     * failing, and one that points elsewhere fails with `pullRequestBranch` and is never moved.
     */
    | {kind: 'createBranch'; name: string; fromRemote?: boolean; at?: string; checkout: boolean; reuse?: boolean}
    | {kind: 'switchBranch'; name: string};

/**
 * The local branch a pull request is opened on: `pr/<number>`, a name `git check-ref-format --branch` accepts. It is
 * created at the fetched head (`pullRequestRef(number)`) and is an ordinary branch afterwards.
 */
export const pullRequestBranch = (number: number) => `pr/${number}`;

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR', 'NotFoundError'].includes(errorCode(error) ?? '');

export interface CommitSelection {
    branch: string;
    head: string | null;
    files: readonly {path: string; oid: string | null}[];
}

interface QueuedCommit {
    selection: CommitSelection;
    timestamp: number;
    prepared(oid: string): Promise<void>;
}

let mutationTail = Promise.resolve();
export function withGitMutationLock<T>(execute: () => Promise<T>) {
    if (globalThis.navigator?.locks) return navigator.locks.request('tw-plus-git-mutation', execute);
    const result = mutationTail.then(execute);
    mutationTail = result.then(() => {}, () => {});
    return result;
}

/**
 * Stages, unstages or commits in the granted repository. Like pull, Git's writes are collected first and applied
 * after the files they replace are checked again; a failure part way puts back what was applied. Only `.git/index`,
 * objects and the current branch ref are written. The work tree and `.git/config` are never written.
 */
export async function runLocalOperation(root: FileSystemDirectoryHandle, operation: LocalOperation, guard: () => void) {
    return withGitMutationLock(() => applyLocalOperation(root, operation, guard));
}

/** The queue holds the Git mutation lock from its journal read through its final state write. */
export function applyQueuedCommit(root: FileSystemDirectoryHandle, message: string, author: GitAuthor | undefined,
    guard: () => void, queued: QueuedCommit) {
    return applyLocalOperation(root, {kind: 'commit', message, author}, guard, queued);
}

async function applyLocalOperation(root: FileSystemDirectoryHandle, operation: LocalOperation, guard: () => void,
    queued?: QueuedCommit) {
    const execute = async () => {
        guard();
        let commitOid: string | undefined;
        const switching = operation.kind === 'switchBranch' || (operation.kind === 'createBranch' && operation.checkout);
        const transaction = createMutationFs(root, switching || operation.kind === 'restoreProject');
        const options = {fs: transaction.fs, dir: '/', gitdir: '/.git', cache: {}};
        const read = createReadOnlyFs(root).promises;
        const exists = async (path: string) => {
            try {
                await read.stat(path);
                return true;
            } catch (error) {
                if (missing(error)) return false;
                throw error;
            }
        };
        const stage = async (paths: readonly string[]) => {
            // The browser cannot see executable bits or links: staging such a file would change its mode in Git.
            const modes = new Map<string, number>();
            await git.walk({...options, trees: [git.STAGE()], map: async (path, [entry]) => {
                if (entry && path !== '.' && await entry.type() === 'blob') modes.set(path, await entry.mode());
                return true;
            }});
            for (const path of paths) {
                pathParts(path);
                const mode = modes.get(path);
                if (mode !== undefined && mode !== 0o100644) throw new GitPanelError('unsupported');
                if (await exists('/' + path)) await git.add({...options, filepath: path});
                else await git.remove({...options, filepath: path});
            }
        };
        // Another tool is in the middle of a merge, rebase or its own write: leave the repository to it.
        for (const path of ['/.git/index.lock', '/.git/MERGE_HEAD', '/.git/CHERRY_PICK_HEAD', '/.git/REVERT_HEAD',
            '/.git/rebase-merge', '/.git/rebase-apply']) {
            if (await exists(path)) throw new GitPanelError('locked');
        }
        if (operation.kind === 'restoreProject') {
            const {plan} = operation;
            const fresh = await planProjectRestore(options, plan.oid, plan.folder);
            if (fresh.branch !== plan.branch || fresh.head !== plan.head ||
                JSON.stringify(fresh.changes) !== JSON.stringify(plan.changes)) throw new GitPanelError('changed');
            if (!fresh.changes.length) throw new GitPanelError('versionIdentical');
            await assertIndex(options, fresh.head, new Map(), false).catch(error => {
                if (error instanceof GitPanelError && error.code === 'changed') throw new GitPanelError('restoreUnsafe');
                throw error;
            });
            const prefix = plan.folder ? plan.folder + '/' : '';
            const statuses = await git.statusMatrix({...options, refresh: false,
                filepaths: plan.folder ? [plan.folder] : undefined,
                filter: path => path.startsWith(prefix) && projectVersionFile(path.slice(prefix.length))});
            if (statuses.some(([, head, worktree]) => head && head !== worktree)) throw new GitPanelError('restoreUnsafe');

            for (const {path, before, after} of fresh.changes) {
                if (!after || before) continue;
                const parents = pathParts(path);
                parents.pop();
                let directory = '';
                for (const part of parents) {
                    directory += '/' + part;
                    const stat = await options.fs.promises.stat(directory).catch(error => {
                        if (missing(error)) return null;
                        throw error;
                    });
                    if (stat && !stat.isDirectory()) throw new GitPanelError('restoreUnsafe');
                }
                if (await exists('/' + path)) throw new GitPanelError('restoreUnsafe');
            }
            const oldFiles = fresh.changes.map(({path, before: oid}) => ({path, oid}));
            await assertWorktree(options.fs, oldFiles).catch(error => {
                if (error instanceof GitPanelError && error.code === 'changed') throw new GitPanelError('restoreUnsafe');
                throw error;
            });
            const author = await commitAuthor(options, operation.author);
            for (const {path, after} of fresh.changes) {
                if (after) {
                    const {blob} = await git.readBlob({...options, oid: after});
                    const parents = pathParts(path);
                    parents.pop();
                    let directory = '';
                    for (const part of parents) {
                        directory += '/' + part;
                        try {await options.fs.promises.mkdir(directory);}
                        catch (error) {if (errorCode(error) !== 'EEXIST') throw error;}
                    }
                    await options.fs.promises.writeFile('/' + path, blob);
                    await git.updateIndex({...options, filepath: path, oid: after, mode: 0o100644, add: true});
                } else {
                    await options.fs.promises.unlink('/' + path);
                    await git.remove({...options, filepath: path});
                }
            }
            const selected = new Map(fresh.changes.map(({path, after}) => [path, after]));
            await assertIndex(options, fresh.head, selected, true);
            commitOid = await git.commit({...options, author, parent: [fresh.head],
                message: `Restore ${plan.folder || 'project'} from ${plan.oid}\n`});
        } else if (operation.kind === 'createBranch' || operation.kind === 'switchBranch') {
            const name = operation.name.trim();
            const local = `refs/heads/${name}`;
            if (switching) {
                // Like pull: switching rewrites the work tree, so it starts from a clean one.
                if ((await git.statusMatrix({...options, refresh: false})).some(([, head, worktree, stage]) =>
                    head !== worktree || head !== stage)) throw new GitPanelError('switchUnsafe');
            }
            if (operation.kind === 'createBranch') {
                let object: string;
                if (operation.reuse && operation.at === undefined) throw new GitPanelError('invalid');
                if (operation.at !== undefined) {
                    if (operation.fromRemote || !/^[0-9a-f]{40}$/.test(operation.at)) throw new GitPanelError('invalid');
                    object = await git.readCommit({...options, oid: operation.at})
                        .then(() => operation.at!, () => {throw new GitPanelError('invalid');});
                } else if (operation.fromRemote) {
                    try {
                        object = await git.resolveRef({...options, ref: `refs/remotes/origin/${name}`});
                    } catch {
                        throw new GitPanelError('invalid');
                    }
                } else {
                    object = await git.resolveRef({...options, ref: 'HEAD'}).catch(() => {throw new GitPanelError('unsupported');});
                }
                let existing: string | undefined;
                if (operation.reuse && (await git.listBranches(options)).includes(name)) {
                    existing = await git.resolveRef({...options, ref: local});
                    // Never move a branch the person may have recorded on: only the same commit is reused.
                    if (existing !== object) throw new GitPanelError('pullRequestBranch');
                }
                if (existing === undefined) {
                    // Git keeps branches as files under refs/heads, so `pr` and `pr/7` cannot both exist.
                    const conflict = (await git.listBranches(options)).some(branch =>
                        branch !== name && (name.startsWith(`${branch}/`) || branch.startsWith(`${name}/`)));
                    if (conflict) throw new GitPanelError('branchConflict');
                }
                if (existing === undefined) try {
                    // The ref first: isomorphic-git's checkout of a missing branch would write tracking config.
                    await git.branch({...options, ref: name, object, checkout: false});
                } catch (error) {
                    const code = (error as {code?: string})?.code;
                    if (code === 'AlreadyExistsError') throw new GitPanelError('branchExists');
                    if (code === 'InvalidRefNameError') throw new GitPanelError('branchName');
                    throw error;
                }
            } else if (!(await git.listBranches(options)).includes(name)) {
                throw new GitPanelError('invalid');
            }
            if (switching) {
                // Executable bits, links and submodules cannot be written from the browser.
                const commit = await git.resolveRef({...options, ref: local});
                await git.walk({...options, trees: [git.TREE({ref: commit})], map: async (path, [entry]) => {
                    if (!entry || path === '.') return true;
                    const type = await entry.type();
                    if (type === 'tree') return true;
                    if (type !== 'blob' || await entry.mode() !== 0o100644) throw new GitPanelError('unsupported');
                    return true;
                }});
                await git.checkout({...options, ref: name});
                if (await git.currentBranch(options) !== name) throw new GitPanelError('changed');
            }
        } else if (operation.kind === 'stage') {
            await stage(operation.paths);
        } else if (operation.kind === 'unstage') {
            for (const path of operation.paths) {
                pathParts(path);
                await git.resetIndex({...options, filepath: path});
            }
        } else {
            const message = operation.message.trim();
            if (!message) throw new GitPanelError('commitMessage');
            const ref = await git.currentBranch(options);
            if (!ref) throw new GitPanelError('unsupported');
            const {name, email} = await commitAuthor(options, operation.author);
            if (queued) {
                const {head, branch, files} = queued.selection;
                if (ref !== branch || await readLocalRef(options, 'HEAD') !== head) throw new GitPanelError('changed');
                const selected = new Map(files.map(file => [file.path, file.oid]));
                await assertIndex(options, head, selected, false);
                await assertWorktree(options.fs, files);
                await stage([...selected.keys()]);
                await assertIndex(options, head, selected, true);
            }
            const staged = (await git.statusMatrix({...options, refresh: false})).some(([, head, , stage]) => head !== stage);
            if (!staged) throw new GitPanelError('nothingStaged');
            const author = queued ? {name, email, timestamp: queued.timestamp, timezoneOffset: 0} : {name, email};
            commitOid = await git.commit({...options, message: message + '\n', author, committer: queued ? author : undefined});
            if (queued) {
                await queued.prepared(commitOid);
                // A journal write can yield to another editor or a command-line tool.
                await assertWorktree(createReadOnlyFs(root), queued.selection.files);
            }
        }
        guard();
        await transaction.commit(guard);
        return commitOid;
    };
    return execute();
}

type GitReadOptions = Omit<Parameters<typeof git.resolveRef>[0], 'ref'>;

async function commitAuthor(options: GitReadOptions, fallback?: GitAuthor): Promise<GitAuthor> {
    const configured = async (path: string) => {
        const value = await git.getConfig({...options, path});
        return typeof value === 'string' && value.trim() ? value : undefined;
    };
    const name = await configured('user.name') ?? fallback?.name?.trim();
    const email = await configured('user.email') ?? fallback?.email?.trim();
    if (!name || !email) throw new GitPanelError('author');
    return {name, email};
}

export async function readLocalRef(options: GitReadOptions, ref: string) {
    try {return await git.resolveRef({...options, ref});}
    catch (error) {
        if (errorCode(error) !== 'NotFoundError') throw error;
        return null;
    }
}

async function assertWorktree(fs: {promises: Pick<ReturnType<typeof createReadOnlyFs>['promises'], 'readFile'>},
    files: CommitSelection['files']) {
    for (const {path, oid} of files) {
        let actual: string | null = null;
        try {
            const bytes = await fs.promises.readFile('/' + path) as Uint8Array;
            actual = (await git.hashBlob({object: bytes})).oid;
        } catch (error) {
            if (!missing(error)) throw error;
        }
        if (actual !== oid) throw new GitPanelError('changed');
    }
}

/** Refuse unrelated staged changes and any staged version that the approved worktree bytes would replace. */
async function assertIndex(options: GitReadOptions, head: string | null, selected: Map<string, string | null>, prepared: boolean) {
    const seen = new Set<string>();
    const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    await git.walk({...options, trees: [git.TREE({ref: head ?? emptyTree}), git.STAGE()],
        map: async (path, [before, staged]) => {
            if (path === '.') return true;
            const beforeType = await before?.type();
            const stagedType = await staged?.type();
            const old = before && beforeType !== 'tree' ? {oid: await before.oid(), mode: await before.mode()} : null;
            const next = staged && stagedType !== 'tree' ? {oid: await staged.oid(), mode: await staged.mode()} : null;
            const differs = old?.oid !== next?.oid || old?.mode !== next?.mode;
            if (selected.has(path)) {
                seen.add(path);
                if ((old && old.mode !== 0o100644) || (next && next.mode !== 0o100644)) throw new GitPanelError('unsupported');
            }
            if ((differs || (prepared && selected.has(path))) &&
                (!selected.has(path) || selected.get(path) !== (next?.oid ?? null))) throw new GitPanelError('changed');
            return true;
        }});
    if (prepared && [...selected].some(([path, oid]) => oid !== null && !seen.has(path))) throw new GitPanelError('changed');
}
