import git from 'isomorphic-git';
import {createReadOnlyFs, GitPanelError, pathParts} from './filesystem.js';
import {applyQueuedCommit, readLocalRef, withGitMutationLock} from './local-operations.js';
import type {CommitSelection, GitAuthor} from './local-operations.js';
import {openRepository} from './repository.js';

export type {CommitSelection, GitAuthor};
export {withGitMutationLock};

type Failure = GitPanelError['code'] | 'operationFailed';
type JobState =
    | {status: 'queued'}
    | {status: 'prepared'; preparedOid: string}
    | {status: 'completed'; commitOid: string}
    | {status: 'blocked' | 'failed'; error: Failure; preparedOid?: string};

export type SaveCommitJob = JobState & {
    id: string;
    createdAt: number;
    message: string;
    selection: CommitSelection;
    /** A job owns its future PR head, independently of later commits on the work branch. */
    publicationRef: string;
};

export interface SaveCommitRecord {
    root: FileSystemDirectoryHandle;
    job: SaveCommitJob;
}

export interface SaveCommitJournal {
    get(id: string): Promise<SaveCommitRecord | undefined>;
    list(): Promise<SaveCommitRecord[]>;
    put(record: SaveCommitRecord): Promise<void>;
}

const safePath = (path: string) => path.length > 0 && pathParts(path).join('/') === path &&
    !path.includes('\\') && !pathParts(path).some(part => part.toLowerCase() === '.git');
const isOid = (oid: string | null) => oid === null || /^[0-9a-f]{40}$/u.test(oid);
const withoutState = ({id, createdAt, message, selection, publicationRef}: SaveCommitJob) =>
    ({id, createdAt, message, selection, publicationRef});

const sourceFiles = new Set(['project.source.json', 'sb3-source.json', 'embedded-extensions.json']);
const sourceChild = /^(?:assets\/[a-f0-9]{32}\.[A-Za-z0-9]+|extensions\/[A-Za-z0-9._-]+\.(?:js|manifest\.json))$/u;

function isProjectFile(folder: string, path: string) {
    const prefix = folder ? folder + '/' : '';
    if (!path.startsWith(prefix)) return false;
    const localPath = path.slice(prefix.length);
    return sourceFiles.has(localPath) || sourceChild.test(localPath);
}

/**
 * Capture follows the host's project-folder save. A queued job contains only the hashes of
 * that approved state, so resume never depends on retaining a project VM across restarts.
 */
export function createSaveCommitQueue({root, journal, projectFolder, guard = () => {}, author}: {
    root: FileSystemDirectoryHandle;
    journal: SaveCommitJournal;
    /** Restricts a queue to the v1 source files of one open project folder. */
    projectFolder?: string;
    guard?: () => void;
    author?: () => GitAuthor | undefined | Promise<GitAuthor | undefined>;
}) {
    if (projectFolder && !safePath(projectFolder)) throw new GitPanelError('invalid');
    const includes = (path: string) => projectFolder === undefined || isProjectFile(projectFolder, path);
    const belongsHere = (record: SaveCommitRecord) => record.job.selection.files.every(({path}) => includes(path)) &&
        root.isSameEntry(record.root);
    const options = () => ({fs: createReadOnlyFs(root), dir: '/', gitdir: '/.git'});
    async function list() {
        const jobs: SaveCommitJob[] = [];
        for (const record of await journal.list()) {
            if (await belongsHere(record)) jobs.push(record.job);
        }
        return jobs.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }

    const run = (id: string) => withGitMutationLock(async () => {
        const record = await journal.get(id);
        if (!record || !await belongsHere(record)) throw new GitPanelError('invalid');
        let job = record.job;
        if (job.status === 'completed') return job;
        const saveState = async (state: JobState) => {
            const next = {...withoutState(job), ...state};
            await journal.put({root, job: next});
            job = next;
            return next;
        };
        const preparedOid = () => 'preparedOid' in job ? job.preparedOid : undefined;
        const wasApplied = async () => {
            const oid = preparedOid();
            return oid && await readLocalRef(options(), 'refs/heads/' + job.selection.branch) === oid ? oid : undefined;
        };
        let commitOid: string | undefined;
        try {
            guard();
            commitOid = await wasApplied();
            if (!commitOid) {
                commitOid = await applyQueuedCommit(root, job.message, await author?.(), guard, {
                    selection: job.selection,
                    timestamp: Math.floor(job.createdAt / 1000),
                    async prepared(oid) {
                        if (preparedOid() && preparedOid() !== oid) throw new GitPanelError('changed');
                        await saveState({status: 'prepared', preparedOid: oid});
                    }
                });
            }
        } catch (error) {
            commitOid = await wasApplied().catch(() => undefined);
            if (!commitOid) {
                const code = error instanceof GitPanelError ? error.code : 'operationFailed';
                return saveState({
                    status: code === 'changed' || code === 'locked' || code === 'rollbackFailed' ? 'blocked' : 'failed',
                    error: code, preparedOid: preparedOid()
                });
            }
        }
        if (!commitOid) throw new GitPanelError('invalid');
        // If this write is interrupted, the prepared row is enough to recover the exact commit.
        return saveState({status: 'completed', commitOid});
    });

    return {
        async capture({scope = projectFolder ?? '', paths}: {scope?: string; paths?: readonly string[]} = {}): Promise<CommitSelection> {
            guard();
            if ((scope && !safePath(scope)) || (projectFolder !== undefined && scope !== projectFolder))
                throw new GitPanelError('invalid');
            const repository = await openRepository(root);
            const sourcePaths = projectFolder === undefined ? undefined :
                [...sourceFiles, 'assets', 'extensions'].map(path => scope ? scope + '/' + path : path);
            const snapshot = await repository.read(scope, sourcePaths);
            guard();
            if (!snapshot.branch) throw new GitPanelError('unsupported');
            const files = new Map<string, string | null>();
            for (const change of snapshot.changes) {
                // Repository.read reports the staged version before the later worktree version.
                if (!includes(change.path)) continue;
                if (sourcePaths && change.group === 'untracked' && await git.isIgnored({...options(), filepath: change.path}))
                    throw new GitPanelError('ignoredProjectFile');
                files.set(change.path, change.after);
            }
            const selected = [...new Set(paths ?? files.keys())].sort();
            if (!selected.length) throw new GitPanelError('nothingStaged');
            if (selected.some(path => !safePath(path) || !files.has(path))) throw new GitPanelError('invalid');
            return {branch: snapshot.branch, head: snapshot.head, files: selected.map(path => ({path, oid: files.get(path) ?? null}))};
        },
        async enqueue({selection, message}: {selection: CommitSelection; message: string}): Promise<SaveCommitJob> {
            guard();
            const subject = message.trim();
            if (!subject) throw new GitPanelError('commitMessage');
            if (!selection.branch || !safePath(selection.branch) || !isOid(selection.head) || !selection.files.length ||
                selection.files.some(({path, oid}) => !safePath(path) || !isOid(oid) || !includes(path)) ||
                new Set(selection.files.map(({path}) => path)).size !== selection.files.length)
                throw new GitPanelError('invalid');
            const id = globalThis.crypto.randomUUID();
            const job: SaveCommitJob = {
                id, createdAt: Date.now(), message: subject,
                selection: {...selection, files: selection.files.map(file => ({...file}))},
                status: 'queued', publicationRef: 'refs/heads/tw-plus/pr-' + id
            };
            await journal.put({root, job});
            return job;
        },
        list, run,
        /** Resume interrupted work when the same directory is granted again. Blocked jobs need an explicit retry. */
        async resume() {
            const results: SaveCommitJob[] = [];
            for (const job of await list()) {
                if (job.status === 'queued' || job.status === 'prepared') results.push(await run(job.id));
            }
            return results;
        }
    };
}

/** Store the granted handle with the job so two checkouts of the same branch cannot pick up each other's work. */
export function createIndexedDbSaveCommitJournal(indexedDb: IDBFactory): SaveCommitJournal {
    const storeName = 'jobs';
    let connection: Promise<IDBDatabase> | undefined;
    function connect() {
        return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDb.open('turbowarp-plus-editor-save-commit', 1);
            request.onupgradeneeded = () => request.result.createObjectStore(storeName, {keyPath: 'job.id'});
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const database = request.result;
                database.onversionchange = () => {
                    database.close();
                    connection = undefined;
                };
                resolve(database);
            };
        }).catch(error => {
            connection = undefined;
            throw error;
        });
    }
    async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
        const database = await connect();
        return new Promise<T>((resolve, reject) => {
            const transaction = database.transaction(storeName, mode);
            const request = operation(transaction.objectStore(storeName));
            transaction.oncomplete = () => resolve(request.result);
            transaction.onabort = () => reject(transaction.error ?? request.error);
        });
    }
    return {
        get: id => transact('readonly', store => store.get(id)),
        list: () => transact('readonly', store => store.getAll()),
        async put(record) {await transact('readwrite', store => store.put(record));}
    };
}
