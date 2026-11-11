import * as git from 'isomorphic-git';
import {createReadOnlyFs, errorCode, GitPanelError, pathParts} from './filesystem.js';
import {createMutationFs} from './mutation-fs.js';

/** The name and email a commit records. */
export type GitAuthor = {name: string; email: string};
export type LocalOperation =
    | {kind: 'stage'; paths: readonly string[]}
    | {kind: 'unstage'; paths: readonly string[]}
    | {kind: 'commit'; message: string; author?: GitAuthor}
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

/**
 * Stages, unstages or commits in the granted repository. Like pull, Git's writes are collected first and applied
 * after the files they replace are checked again; a failure part way puts back what was applied. Only `.git/index`,
 * objects and the current branch ref are written. The work tree and `.git/config` are never written.
 */
export async function runLocalOperation(root: FileSystemDirectoryHandle, operation: LocalOperation, guard: () => void) {
    const execute = async () => {
        guard();
        const switching = operation.kind === 'switchBranch' || (operation.kind === 'createBranch' && operation.checkout);
        const transaction = createMutationFs(root, switching);
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
        // Another tool is in the middle of a merge, rebase or its own write: leave the repository to it.
        for (const path of ['/.git/index.lock', '/.git/MERGE_HEAD', '/.git/CHERRY_PICK_HEAD', '/.git/REVERT_HEAD',
            '/.git/rebase-merge', '/.git/rebase-apply']) {
            if (await exists(path)) throw new GitPanelError('locked');
        }
        if (operation.kind === 'createBranch' || operation.kind === 'switchBranch') {
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
            // The browser cannot see executable bits or links: staging such a file would change its mode in Git.
            const modes = new Map<string, number>();
            await git.walk({...options, trees: [git.STAGE()], map: async (path, [entry]) => {
                if (entry && path !== '.' && await entry.type() === 'blob') modes.set(path, await entry.mode());
                return true;
            }});
            for (const path of operation.paths) {
                pathParts(path);
                const mode = modes.get(path);
                if (mode !== undefined && mode !== 0o100644) throw new GitPanelError('unsupported');
                if (await exists('/' + path)) await git.add({...options, filepath: path});
                else await git.remove({...options, filepath: path});
            }
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
            const configured = async (path: string) => {
                const value = await git.getConfig({...options, path});
                return typeof value === 'string' && value.trim() ? value : undefined;
            };
            // The repository's own identity first; the Editor's setting only fills in what Git does not have.
            const name = await configured('user.name') ?? operation.author?.name?.trim();
            const email = await configured('user.email') ?? operation.author?.email?.trim();
            if (!name || !email) throw new GitPanelError('author');
            const staged = (await git.statusMatrix({...options, refresh: false})).some(([, head, , stage]) => head !== stage);
            if (!staged) throw new GitPanelError('nothingStaged');
            await git.commit({...options, message: message + '\n', author: {name, email}});
        }
        guard();
        await transaction.commit(guard);
    };
    return globalThis.navigator?.locks ? navigator.locks.request('tw-plus-git-mutation', execute) : execute();
}
