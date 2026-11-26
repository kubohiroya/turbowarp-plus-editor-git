export type GitHubVisibility = 'private' | 'public';
export interface GitHubCreationAccount {
    account: {login: string};
    owners: readonly {
        login: string;
        type: 'User' | 'Organization';
        canCreate: Record<GitHubVisibility, boolean>;
    }[];
}

export interface GitHubRepositoryDraft {
    account: string;
    owner: string;
    name: string;
    title: string;
    description: string;
    topics: readonly string[];
    license: string | null;
    visibility: GitHubVisibility;
}

export interface RepositoryDeviceCode {
    userCode: string;
    verificationUri: string;
    expiresAt: number;
}

export type CreationInteraction = {signal: AbortSignal; deviceCode(value: RepositoryDeviceCode): void};
export type CreationMode = 'desktop' | 'cloudflare';
export type CreationPhase = 'create' | 'unknown' | 'prepare' | 'topics' | 'push' | 'open';

export interface RepositoryReceipt {
    id: number;
    owner: string;
    name: string;
    visibility: 'public' | 'private';
    remote: string;
}

export type RepositoryCreationInspection = {status: 'absent'} | {status: 'unknown'; candidate: RepositoryReceipt | null} |
    {status: 'created'; repository: RepositoryReceipt} | {status: 'refused'; code: string};

export interface RepositoryCreationProgress {
    operationId: string;
    mode: CreationMode;
    account: string;
    owner: string;
    name: string;
    visibility: 'public' | 'private';
    phase: CreationPhase;
    repository?: RepositoryReceipt;
}

type SeedFile = {path: string; bytes: Uint8Array};
type Author = {name: string; email: string};
type CreationIntent = Pick<GitHubRepositoryDraft, 'owner' | 'name' | 'description' | 'visibility' | 'topics'> &
    {operationId: string; seedDigest: string};
type CreateTask = RepositoryCreationProgress & {directory: FileSystemDirectoryHandle; files?: readonly SeedFile[];
    browserProjectId?: string | null;
    timestamp: number; author: Author; intent: CreationIntent; oid?: string};

export interface RepositoryCreationProvider<Session extends GitHubCreationAccount> {
    mode: CreationMode;
    connect(interaction: CreationInteraction): Promise<Session | null>;
    create(session: Session, intent: CreationIntent, signal: AbortSignal): Promise<RepositoryReceipt>;
    topics(session: Session, repository: RepositoryReceipt, signal: AbortSignal): Promise<void>;
    inspect?(session: Session, operationId: string, signal: AbortSignal): Promise<RepositoryCreationInspection>;
    adopt?(session: Session, intent: CreationIntent, id: number, signal: AbortSignal): Promise<RepositoryReceipt | null>;
}

export interface RepositoryCreationControls {
    list(): Promise<readonly RepositoryCreationProgress[]>;
    advance(progress: RepositoryCreationProgress, interaction: CreationInteraction, adoptId?: number): Promise<{
        progress: RepositoryCreationProgress; candidate?: RepositoryReceipt | null;
    }>;
    open(progress: RepositoryCreationProgress): Promise<boolean>;
    grantAccess(progress: RepositoryCreationProgress): Promise<boolean>;
}

export interface RepositoryCreationJournal {
    add(task: CreateTask): Promise<void>;
    read(operationId: string): Promise<CreateTask | undefined>;
    list(): Promise<CreateTask[]>;
    write(task: CreateTask): Promise<void>;
    remove(operationId: string): Promise<void>;
}

export function repositoryCreationJournal(indexedDB: IDBFactory): RepositoryCreationJournal {
    const storeName = 'operations';
    let database: Promise<IDBDatabase> | undefined;
    const connect = () => database ??= new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('turbowarp-plus-editor-repository-creation', 1);
        request.onupgradeneeded = () => {
            const store = request.result.createObjectStore(storeName, {keyPath: 'operationId'});
            store.createIndex('repository', 'destination', {unique: true});
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const connection = request.result;
            connection.onversionchange = () => {connection.close(); database = undefined;};
            resolve(connection);
        };
    }).catch(error => {database = undefined; throw error;});
    async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
        const connection = await connect();
        return new Promise<T>((resolve, reject) => {
            const work = connection.transaction(storeName, mode);
            const result = action(work.objectStore(storeName));
            work.oncomplete = () => resolve(result.result);
            work.onabort = () => reject(work.error ?? result.error);
        });
    }
    const record = (task: CreateTask) => ({...task, destination: (task.owner + '/' + task.name).toLowerCase()});
    return {
        async add(task) {await transaction('readwrite', store => store.add(record(task)));},
        read: operationId => transaction('readonly', store => store.get(operationId)),
        list: () => transaction('readonly', store => store.getAll()),
        async write(task) {await transaction('readwrite', store => store.put(record(task)));},
        async remove(operationId) {await transaction('readwrite', store => store.delete(operationId));}
    };
}

export function creationError(code: string) {
    return Object.assign(new Error(code), {code});
}

// Match the managed storage's ID grammar without tying this workflow to its implementation.
const browserProjectIdPattern = /^[a-z0-9-]{1,64}$/u;
const validBrowserProjectId = (id: unknown): id is string =>
    typeof id === 'string' && browserProjectIdPattern.test(id) && id.trim() === id;

const errorCode = (error: unknown) => (error as {code?: string})?.code;
const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const progress = ({operationId, mode, account, owner, name, visibility, phase, repository}: CreateTask):
RepositoryCreationProgress => ({operationId, mode, account, owner, name, visibility, phase, repository});

function verifyRepository(task: CreateTask, repository: RepositoryReceipt): RepositoryReceipt {
    if (!Number.isSafeInteger(repository?.id) || repository.id < 1 ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(repository.owner) ||
        !/^[A-Za-z0-9_.-]{1,100}$/u.test(repository.name) ||
        !sameName(task.owner, repository.owner) || !sameName(task.name, repository.name) ||
        task.visibility !== repository.visibility ||
        repository.remote !== `https://github.com/${repository.owner}/${repository.name}.git` ||
        task.repository && task.repository.id !== repository.id) throw creationError('unknown');
    return repository;
}

async function digestSeed(files: readonly SeedFile[]) {
    const digest = async (bytes: Uint8Array) => {
        const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
        return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    };
    const entries: [string, string][] = [];
    for (const {path, bytes} of [...files].sort((a, b) => a.path < b.path ? -1 : a.path === b.path ? 0 : 1)) {
        entries.push([path, await digest(bytes)]);
    }
    return digest(new TextEncoder().encode(JSON.stringify(entries)));
}

export function createProjectRepositoryWorkflow<Session extends GitHubCreationAccount, WriteGrant>({
    journal, provider, exclusive, prepare, startWrite, releaseWrite, push, openProject, openLegacyProject, pickDirectory
}: {
    journal: RepositoryCreationJournal;
    provider: RepositoryCreationProvider<Session>;
    exclusive<T>(operationId: string, run: () => Promise<T>): Promise<T>;
    prepare(input: {directory: FileSystemDirectoryHandle; files: readonly SeedFile[]; author: Author; timestamp: number;
        operationId: string; repository: RepositoryReceipt; signal: AbortSignal}): Promise<{oid: string}>;
    startWrite(progress: RepositoryCreationProgress, interaction: CreationInteraction): Promise<WriteGrant | null>;
    releaseWrite(grant: WriteGrant): Promise<void>;
    push(input: {directory: FileSystemDirectoryHandle; repository: RepositoryReceipt; operationId: string; oid: string;
        grant: WriteGrant; signal: AbortSignal}): Promise<void>;
    openProject(directory: FileSystemDirectoryHandle, root: FileSystemDirectoryHandle, browserProjectId?: string | null): Promise<boolean>;
    /** Hosts that require destination provenance can offer an explicit chooser without using the legacy handle. */
    openLegacyProject?(): Promise<boolean>;
    pickDirectory(): Promise<FileSystemDirectoryHandle | null>;
}) {
    const requireAccess = async (directory: FileSystemDirectoryHandle) => {
        const handle = directory as FileSystemDirectoryHandle & {
            queryPermission?(options: {mode: 'readwrite'}): Promise<PermissionState>;
        };
        if (handle.queryPermission && await handle.queryPermission({mode: 'readwrite'}) !== 'granted')
            throw creationError('directoryPermission');
    };
    const authorize = async (task: RepositoryCreationProgress, interaction: CreationInteraction) => {
        const session = await provider.connect(interaction);
        interaction.signal.throwIfAborted();
        if (!session || !sameName(session.account.login, task.account)) throw creationError('denied');
        return session;
    };
    return {
        connect: provider.connect,
        async start({directory, draft, files, author, signal, browserProjectId}: {
            directory: FileSystemDirectoryHandle; draft: GitHubRepositoryDraft; files: readonly SeedFile[];
            author: Author; signal: AbortSignal;
            /** Managed ID, null for a known device folder, or absent for an old caller or journal. */
            browserProjectId?: string | null;
        }): Promise<RepositoryCreationProgress> {
            if (browserProjectId != null && !validBrowserProjectId(browserProjectId)) throw creationError('invalidRequest');
            const {account, owner, name, visibility, description, topics} = draft;
            const operationId = crypto.randomUUID();
            const intent = {operationId, seedDigest: await digestSeed(files), owner, name, visibility, description, topics};
            signal.throwIfAborted();
            const task = {operationId, mode: provider.mode, account, owner, name, visibility, phase: 'create' as const,
                directory, ...(browserProjectId === undefined ? {} : {browserProjectId}), files, timestamp: Math.floor(Date.now() / 1000), author, intent};
            try {await journal.add(task);} catch (error) {
                if ((error as DOMException).name === 'ConstraintError') throw creationError('pendingRepository');
                throw error;
            }
            return progress(task);
        },
        async list() {
            return (await journal.list()).filter(task => task.mode === provider.mode).map(progress);
        },
        advance(current: RepositoryCreationProgress, interaction: CreationInteraction, adoptId?: number) {
            const {signal} = interaction;
            const writeAttempt = new AbortController();
            // OAuth windows must be reserved before the journal read loses the initiating click.
            const creating = current.phase === 'create' || current.phase === 'unknown' || current.phase === 'topics' ||
                current.phase === 'prepare';
            const write = current.phase === 'push' ? startWrite(current,
                {...interaction, signal: AbortSignal.any([signal, writeAttempt.signal])}) : null;
            const credentials = creating ? authorize(current, interaction) : null;
            // Attach a handler while awaiting the lock. The operation below still receives the error.
            void credentials?.catch(() => {});
            void write?.catch(() => {});
            return exclusive(current.operationId, async () => {
                let task = await journal.read(current.operationId);
                if (!task || task.mode !== provider.mode) throw creationError('pendingRepository');
                if (task.phase !== current.phase || task.repository?.id !== current.repository?.id) {
                    return {progress: progress(task)};
                }
                const update = async (patch: Partial<CreateTask>) => {
                    task = {...task!, ...patch};
                    await journal.write(task);
                };
                signal.throwIfAborted();
                if (current.phase === 'push') {
                    await requireAccess(task.directory);
                    const grant = await write;
                    if (!grant) throw creationError('denied');
                    signal.throwIfAborted();
                    await push({directory: task.directory, repository: task.repository!, operationId: task.operationId,
                        oid: task.oid!, grant, signal});
                    await update({phase: 'open'});
                    return {progress: progress(task)};
                }
                if (!creating) return {progress: progress(task)};
                const session = (await credentials)!;
                let receipt: RepositoryReceipt | undefined;
                if (task.phase === 'unknown') {
                    if (adoptId === undefined) {
                        const result = await provider.inspect?.(session, task.operationId, signal);
                        if (!result || result.status === 'unknown') {
                            const candidate = result?.status === 'unknown' ? result.candidate : null;
                            return {progress: progress(task), candidate: candidate ? verifyRepository(task, candidate) : null};
                        }
                        if (result.status === 'absent') {
                            await update({phase: 'create'});
                            return {progress: progress(task)};
                        }
                        if (result.status === 'refused') {
                            await journal.remove(task.operationId);
                            throw creationError(result.code);
                        }
                        await update({phase: 'prepare', repository: verifyRepository(task, result.repository)});
                    } else {
                        const adopted = await provider.adopt?.(session, task.intent, adoptId, signal);
                        if (!adopted || adopted.id !== adoptId) throw creationError('unknown');
                        await update({phase: 'prepare', repository: verifyRepository(task, adopted)});
                    }
                }
                if (task.phase === 'create') {
                    await requireAccess(task.directory);
                    try {
                        receipt = verifyRepository(task, await provider.create(session, task.intent, signal));
                    } catch (error) {
                        if (errorCode(error) === 'unknown') await update({phase: 'unknown'});
                        else if (errorCode(error) === 'nameConflict') await journal.remove(task.operationId);
                        else if (!signal.aborted) {
                            const result = await provider.inspect?.(session, task.operationId, signal).catch(() => null);
                            if (result?.status === 'refused') {
                                await journal.remove(task.operationId);
                                throw creationError(result.code);
                            }
                        }
                        throw error;
                    }
                    await update({phase: 'prepare', repository: receipt});
                }
                if (task.phase === 'prepare') {
                    signal.throwIfAborted();
                    await requireAccess(task.directory);
                    const {directory, files, author, timestamp, operationId, repository} = task;
                    if (!files?.length || !repository) throw creationError('pendingRepository');
                    const {oid} = await prepare({directory, files, author, timestamp, operationId, repository, signal});
                    await update({phase: task.intent.topics.length ? 'topics' : 'push', oid, files: undefined});
                }
                if (task.phase === 'topics') {
                    signal.throwIfAborted();
                    // A replay returns the existing repository and restores the client receipt used by the topics route.
                    receipt ??= verifyRepository(task, await provider.create(session, task.intent, signal));
                    await provider.topics(session, receipt, signal);
                    await update({phase: 'push'});
                }
                return {progress: progress(task)};
            }).finally(() => {
                writeAttempt.abort();
                if (write) void write.then(grant => grant && releaseWrite(grant)).catch(() => {});
            });
        },
        open(current: RepositoryCreationProgress) {
            return exclusive(current.operationId, async () => {
                const task = await journal.read(current.operationId);
                if (task?.phase !== 'open' || task.mode !== provider.mode) return false;
                const id = task.browserProjectId;
                if (id != null && !validBrowserProjectId(id)) return false;
                if (id === undefined && openLegacyProject) {
                    if (!await openLegacyProject()) return false;
                } else {
                    if (id == null) await requireAccess(task.directory);
                    // The project is at the root. Managed destinations reopen by ID, not by the journal's cloned handle.
                    if (!await openProject(task.directory, task.directory, id)) return false;
                }
                await journal.remove(task.operationId);
                return true;
            });
        },
        async grantAccess(current: RepositoryCreationProgress) {
            // The picker is called before reading the persisted handle.
            const directory = await pickDirectory();
            if (!directory) return false;
            return exclusive(current.operationId, async () => {
                const task = await journal.read(current.operationId);
                if (!task || task.mode !== provider.mode) throw creationError('pendingRepository');
                if (!await directory.isSameEntry(task.directory)) throw creationError('differentDirectory');
                await requireAccess(directory);
                await journal.write({...task, directory});
                return true;
            });
        }
    };
}
