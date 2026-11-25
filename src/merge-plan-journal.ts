import {GitPanelError} from './filesystem.js';
import type {MergePlan, MergePlanFiles, MergePlanSeed} from './merge-plan.js';

export interface MergePlanScope {
    root: FileSystemDirectoryHandle;
    folder: string;
}

export interface MergePlanJournal {
    list(scope: MergePlanScope): Promise<MergePlan[]>;
    append(scope: MergePlanScope, plan: MergePlan, files?: MergePlanFiles, seed?: MergePlanSeed): Promise<void>;
    files(plan: MergePlan): Promise<MergePlanFiles>;
    seed(plan: MergePlan): Promise<MergePlanSeed>;
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
    return {
        list: scope => matching(scope, rows),
        async append(scope, plan, files, seed) {
            if (files) contents.set(plan.contentId, files);
            if (seed) seeds.set(plan.seedId, seed);
            rows.push({...scope, plan});
        },
        async files(plan) {return required(contents.get(plan.contentId));},
        async seed(plan) {return required(seeds.get(plan.seedId));}
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

export function createIndexedDbMergePlanJournal(indexedDb: IDBFactory): MergePlanJournal {
    let connection: Promise<IDBDatabase> | undefined;
    function connect() {
        return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDb.open('turbowarp-plus-editor-merge-plans', 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore('generations', {keyPath: 'plan.id'})
                    .createIndex(rootIndex, ['rootName', 'folder']);
                request.result.createObjectStore('files');
                request.result.createObjectStore('seeds');
            };
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
    async function transact<T>(used: Store | Store[], mode: IDBTransactionMode,
        operation: (transaction: IDBTransaction) => IDBRequest<T>) {
        const database = await connect();
        return new Promise<T>((resolve, reject) => {
            const transaction = database.transaction(used, mode);
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
    return {
        async list(scope) {
            const rows = await transact('generations', 'readonly', tx =>
                tx.objectStore('generations').index(rootIndex).getAll([scope.root.name, scope.folder]));
            return matching(scope, rows);
        },
        async append(scope, plan, files, seed) {
            // Publishing the generation and its dependencies together makes a failed write leave the old plan usable.
            await transact(stores, 'readwrite', tx => {
                if (files) tx.objectStore('files').put(files, plan.contentId);
                if (seed) tx.objectStore('seeds').add(seed, plan.seedId);
                return tx.objectStore('generations').add({...scope, rootName: scope.root.name, plan});
            });
        },
        async files(plan) {
            return required(await transact('files', 'readonly', tx => tx.objectStore('files').get(plan.contentId)));
        },
        async seed(plan) {
            return required(await transact('seeds', 'readonly', tx => tx.objectStore('seeds').get(plan.seedId)));
        }
    };
}
