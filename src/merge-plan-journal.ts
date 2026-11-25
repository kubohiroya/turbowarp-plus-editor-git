import {GitPanelError} from './filesystem.js';
import type {MergePlan, MergePlanFiles, MergePlanSeed} from './merge-plan.js';
import type {MergePlanTestResult} from './merge-plan-tests.js';

export interface MergePlanScope {
    root: FileSystemDirectoryHandle;
    folder: string;
}

export interface MergePlanJournal {
    list(scope: MergePlanScope): Promise<MergePlan[]>;
    append(scope: MergePlanScope, plan: MergePlan, files?: MergePlanFiles, seed?: MergePlanSeed): Promise<void>;
    files(plan: MergePlan): Promise<MergePlanFiles>;
    seed(plan: MergePlan): Promise<MergePlanSeed>;
    testResult(plan: MergePlan): Promise<MergePlanTestResult | null>;
    saveTestResult(result: MergePlanTestResult): Promise<void>;
}

type Row = MergePlanScope & {plan: MergePlan};
type Store = 'generations' | 'files' | 'seeds';
const stores: Store[] = ['generations', 'files', 'seeds'];
const rootIndex = 'rootNameAndFolder';

async function matching(scope: MergePlanScope, rows: readonly Row[]) {
    const plans: MergePlan[] = [];
    for (const {root, folder, plan} of rows) {
        if (folder === scope.folder && await scope.root.isSameEntry(root).catch(() => false)) plans.push(plan);
    }
    return plans.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function required<T>(entry: T | undefined): T {
    if (entry === undefined) throw new GitPanelError('versionMissing');
    return entry;
}

export function createMemoryMergePlanJournal(): MergePlanJournal {
    const rows: Row[] = [];
    const contents = new Map<string, MergePlanFiles>();
    const seeds = new Map<string, MergePlanSeed>();
    const results = new Map<string, MergePlanTestResult>();
    const key = (generationId: string, contentId: string) => JSON.stringify([generationId, contentId]);
    return {
        list: scope => matching(scope, rows),
        async append(scope, plan, files, seed) {
            if (files) contents.set(plan.contentId, files);
            if (seed) seeds.set(plan.seedId, seed);
            rows.push({...scope, plan});
        },
        async files(plan) {return required(contents.get(plan.contentId));},
        async seed(plan) {return required(seeds.get(plan.seedId));},
        async testResult(plan) {return results.get(key(plan.id, plan.contentId)) ?? null;},
        async saveTestResult(result) {results.set(key(result.generationId, result.contentId), result);}
    };
}

/** Only native directory handles survive serialization with enough identity to rebind after a restart. */
export function canPersistMergePlans(root: FileSystemDirectoryHandle): boolean {
    try {
        return typeof structuredClone(root).isSameEntry === 'function';
    } catch {
        return false;
    }
}

function connectTo(indexedDb: IDBFactory, name: string, initialize: (db: IDBDatabase) => void) {
    let connection: Promise<IDBDatabase> | undefined;
    return () => {
        return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDb.open(name);
            request.onupgradeneeded = () => initialize(request.result);
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
    };
}

async function transact<T>(database: IDBDatabase, stores: string | string[], mode: IDBTransactionMode,
    operation: (transaction: IDBTransaction) => IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(stores, mode);
        try {
            const request = operation(transaction);
            transaction.oncomplete = () => resolve(request.result);
            transaction.onabort = () => reject(transaction.error ?? request.error);
        } catch (error) {
            transaction.abort();
            reject(error);
        }
    });
}

export function createIndexedDbMergePlanJournal(indexedDb: IDBFactory): MergePlanJournal {
    const plans = connectTo(indexedDb, 'turbowarp-plus-editor-merge-plans', db => {
        db.createObjectStore('generations', {keyPath: 'plan.id'}).createIndex(rootIndex, ['rootName', 'folder']);
        db.createObjectStore('files');
        db.createObjectStore('seeds');
    });
    // Keep the candidate schema at v1 so a previous Editor build can still open its saved generations.
    const testStore = 'testResults';
    const tests = connectTo(indexedDb, 'turbowarp-plus-editor-merge-plan-tests', db => {
        db.createObjectStore(testStore, {keyPath: ['generationId', 'contentId']});
    });
    const readResult = (db: IDBDatabase, key: string[]) => transact<MergePlanTestResult | undefined>(
        db, testStore, 'readonly', tx => tx.objectStore(testStore).get(key));
    return {
        async list(scope) {
            const rows = await transact(await plans(), 'generations', 'readonly', tx =>
                tx.objectStore('generations').index(rootIndex).getAll([scope.root.name, scope.folder]));
            return matching(scope, rows);
        },
        async append(scope, plan, files, seed) {
            // Publishing the generation and its dependencies together makes a failed write leave the old plan usable.
            await transact(await plans(), stores, 'readwrite', tx => {
                if (files) tx.objectStore('files').put(files, plan.contentId);
                if (seed) tx.objectStore('seeds').add(seed, plan.seedId);
                return tx.objectStore('generations').add({...scope, rootName: scope.root.name, plan});
            });
        },
        async files(plan) {
            return required(await transact(await plans(), 'files', 'readonly', tx => tx.objectStore('files').get(plan.contentId)));
        },
        async seed(plan) {
            return required(await transact(await plans(), 'seeds', 'readonly', tx => tx.objectStore('seeds').get(plan.seedId)));
        },
        async testResult(plan) {
            const key = [plan.id, plan.contentId];
            const result = await readResult(await tests(), key);
            if (result) return result;
            // Unreleased integration builds used a v2 store in the candidate database.
            const candidateDatabase = await plans();
            return candidateDatabase.objectStoreNames.contains(testStore) ? await readResult(candidateDatabase, key) ?? null : null;
        },
        async saveTestResult(result) {
            await transact(await tests(), testStore, 'readwrite', tx => tx.objectStore(testStore).put(result));
        }
    };
}
