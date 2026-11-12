import {GitPanelError, pathParts, sameBytes} from './filesystem.js';
import type {InitialCommitEntry} from './initial-commit-fs.js';

const journalName = 'turbowarp-plus-initial-commit.json';
const maxJournalBytes = 4096;
const operationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const oidPattern = /^[0-9a-f]{40}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});

type Identity = {operationId: string; repositoryId: number; remote: string; oid: string};
type Journal = Identity & {version: 1; phase: 'preparing' | 'ready' | 'published'};
type EnumerableDirectory = FileSystemDirectoryHandle & {keys(): AsyncIterable<string>};
const keys = (directory: FileSystemDirectoryHandle) => (directory as EnumerableDirectory).keys();
const missing = (error: unknown) => (error as DOMException).name === 'NotFoundError';

export function validateInitialOperation(operationId: string, oid?: string) {
    if (!operationPattern.test(operationId) || (oid !== undefined && !oidPattern.test(oid)))
        throw new GitPanelError('invalid');
}

function changed(): never {
    throw new GitPanelError('changed');
}

async function requireHandle<T>(read: Promise<T>): Promise<T> {
    try {return await read;}
    catch (error) {
        if (missing(error) || (error as DOMException).name === 'TypeMismatchError') changed();
        throw error;
    }
}

async function readJournal(gitDirectory: FileSystemDirectoryHandle, identity: Identity): Promise<Journal> {
    const handle = await requireHandle(gitDirectory.getFileHandle(journalName));
    const file = await handle.getFile();
    if (file.size > maxJournalBytes) changed();
    let value: unknown;
    try {value = JSON.parse(decoder.decode(await file.arrayBuffer()));}
    catch {changed();}
    const record = value as Partial<Journal> | null;
    if (!record || record.version !== 1 || record.operationId !== identity.operationId ||
        record.repositoryId !== identity.repositoryId || record.remote !== identity.remote || record.oid !== identity.oid ||
        (record.phase !== 'preparing' && record.phase !== 'ready' && record.phase !== 'published')) changed();
    return {version: 1, ...identity, phase: record.phase};
}

async function writeNewFile(directory: FileSystemDirectoryHandle, name: string, bytes: Uint8Array<ArrayBuffer>,
    signal?: AbortSignal) {
    signal?.throwIfAborted();
    try {
        await directory.getFileHandle(name);
        changed();
    } catch (error) {
        if (!missing(error)) throw error;
    }
    const handle = await directory.getFileHandle(name, {create: true});
    if ((await handle.getFile()).size !== 0) changed();
    try {await writeFile(handle, bytes, signal);}
    catch (error) {
        try {
            const current = await directory.getFileHandle(name);
            if (await current.isSameEntry(handle) && (await current.getFile()).size === 0)
                await directory.removeEntry(name);
        } catch {
            // The partial initialization remains journaled if an interrupted write cannot be cleaned up.
        }
        throw error;
    }
}

async function writeFile(handle: FileSystemFileHandle, bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal) {
    const writer = await handle.createWritable();
    try {
        signal?.throwIfAborted();
        await writer.write(bytes);
        signal?.throwIfAborted();
        await writer.close();
    } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
    }
}

function encodeJournal(journal: Journal) {
    return encoder.encode(JSON.stringify(journal) + '\n');
}

function validatePaths(entries: InitialCommitEntry[]) {
    const portable = new Set<string>();
    for (const {path} of entries) {
        const key = path.normalize('NFC').toLowerCase();
        // File System Access can run over a case-insensitive filesystem.
        if (portable.has(key) || pathParts(path).some(part => /[. ]$/u.test(part)))
            throw new GitPanelError('invalid');
        portable.add(key);
    }
}

async function applySnapshot(root: FileSystemDirectoryHandle, entries: InitialCommitEntry[], signal?: AbortSignal) {
    const missingEntries = new Map(entries.map(entry => [entry.path, entry]));
    const handles = new Map<string, FileSystemDirectoryHandle>([['', root]]);
    async function inspect(directory: FileSystemDirectoryHandle, prefix: string) {
        for await (const name of keys(directory)) {
            signal?.throwIfAborted();
            if (prefix === '/.git' && name === journalName) continue;
            const path = prefix + '/' + name;
            const entry = missingEntries.get(path);
            if (!entry) changed();
            missingEntries.delete(path);
            if (entry.bytes === null) {
                const child = await requireHandle(directory.getDirectoryHandle(name));
                handles.set(path, child);
                await inspect(child, path);
            } else {
                const handle = await requireHandle(directory.getFileHandle(name));
                const current = await handle.getFile();
                if (current.size !== entry.bytes.byteLength ||
                    !sameBytes(new Uint8Array(await current.arrayBuffer()), entry.bytes)) changed();
            }
        }
    }
    await inspect(root, '');

    // Snapshot directory entries are in parent-first order; publish Git refs after their objects and index.
    const remaining = [...missingEntries.values()];
    const weight = ({path, bytes}: InitialCommitEntry) => bytes === null ? 0 :
        path === '/.git/HEAD' || path.startsWith('/.git/refs/') ? 2 : 1;
    for (const {path, bytes} of remaining.sort((left, right) => weight(left) - weight(right))) {
        signal?.throwIfAborted();
        const split = path.lastIndexOf('/');
        const parent = handles.get(path.slice(0, split));
        const name = path.slice(split + 1);
        if (!parent) changed();
        if (bytes === null) handles.set(path, await parent.getDirectoryHandle(name, {create: true}));
        else await writeNewFile(parent, name, bytes, signal);
    }
}

export async function prepareInitialDirectory(root: FileSystemDirectoryHandle, entries: InitialCommitEntry[],
    identity: Identity, signal?: AbortSignal) {
    validatePaths(entries);
    signal?.throwIfAborted();
    let occupied = false;
    for await (const _name of keys(root)) {occupied = true; break;}
    let gitDirectory: FileSystemDirectoryHandle;
    if (occupied) {
        gitDirectory = await requireHandle(root.getDirectoryHandle('.git'));
        if ((await readJournal(gitDirectory, identity)).phase !== 'preparing') return;
    } else {
        gitDirectory = await root.getDirectoryHandle('.git', {create: true});
        for await (const _name of keys(gitDirectory)) changed();
        try {
            await writeNewFile(gitDirectory, journalName, encodeJournal({version: 1, ...identity, phase: 'preparing'}), signal);
        } catch (error) {
            // removeEntry without recursive cannot remove an existing repository with contents.
            await root.removeEntry('.git').catch(() => {});
            throw error;
        }
    }
    await applySnapshot(root, entries, signal);
    await updateJournal(gitDirectory, identity, 'preparing', 'ready', signal);
}

async function updateJournal(gitDirectory: FileSystemDirectoryHandle, identity: Identity,
    before: Journal['phase'], after: Journal['phase'], signal?: AbortSignal) {
    const journal = await readJournal(gitDirectory, identity);
    if (journal.phase !== before) changed();
    const handle = await requireHandle(gitDirectory.getFileHandle(journalName));
    await writeFile(handle, encodeJournal({...journal, phase: after}), signal);
}

export async function getInitialDirectoryPublication(root: FileSystemDirectoryHandle, identity: Identity) {
    const gitDirectory = await requireHandle(root.getDirectoryHandle('.git'));
    const {phase} = await readJournal(gitDirectory, identity);
    if (phase === 'preparing') changed();
    return {
        published: phase === 'published',
        markPublished: () => phase === 'published' ?
            Promise.resolve() : updateJournal(gitDirectory, identity, 'ready', 'published')
    };
}

let pendingMutation: Promise<unknown> = Promise.resolve();

export function lockInitialRepository<T>(execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (globalThis.navigator?.locks)
        return navigator.locks.request('tw-plus-git-mutation', {signal}, execute);
    const result = pendingMutation.then(execute);
    pendingMutation = result.catch(() => {});
    return result;
}
