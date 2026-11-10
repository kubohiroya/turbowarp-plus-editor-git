import * as git from 'isomorphic-git';
import {createReadOnlyFs, errorCode, GitPanelError, pathParts} from './filesystem.js';
import {createMutationFs} from './mutation-fs.js';

/** The name and email a commit records. */
export type GitAuthor = {name: string; email: string};
export type LocalOperation =
    | {kind: 'stage'; paths: readonly string[]}
    | {kind: 'unstage'; paths: readonly string[]}
    | {kind: 'commit'; message: string; author?: GitAuthor};

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR', 'NotFoundError'].includes(errorCode(error) ?? '');

/**
 * Stages, unstages or commits in the granted repository. Like pull, Git's writes are collected first and applied
 * after the files they replace are checked again; a failure part way puts back what was applied. Only `.git/index`,
 * objects and the current branch ref are written. The work tree and `.git/config` are never written.
 */
export async function runLocalOperation(root: FileSystemDirectoryHandle, operation: LocalOperation, guard: () => void) {
    const execute = async () => {
        guard();
        const transaction = createMutationFs(root, false);
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
            if (await exists(path)) throw new GitPanelError('changed');
        }
        if (operation.kind === 'stage') {
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
