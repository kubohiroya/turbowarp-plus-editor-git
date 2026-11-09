import * as git from 'isomorphic-git';
import {createTwoFilesPatch} from 'diff';
import {createReadOnlyFs, errorCode, GitPanelError, pathParts, readOptional, sameBytes} from './filesystem.js';
import {runRemoteOperation} from './remote-operations.js';
import type {GetRemoteSession, RemoteOperation} from './remote-operations.js';

export {createReadOnlyFs, GitPanelError} from './filesystem.js';
export type ChangeGroup = 'staged' | 'unstaged' | 'untracked' | 'commit';
export interface FileChange {
    path: string;
    group: ChangeGroup;
    before: string | null;
    after: string | null;
    worktree: boolean;
    oldMode: number | null;
    newMode: number | null;
}
export interface Commit {
    oid: string;
    message: string;
    author: string;
    timestamp: number;
}
interface Entry {oid: string; mode: number}
type Metadata = Map<string, Uint8Array | null>;
export interface Snapshot {
    branch: string | undefined;
    head: string | null;
    branches: string[];
    commits: Commit[];
    changes: FileChange[];
    scope: string;
    metadata: Metadata;
    /** Size and time fingerprint taken before the read. Compare it with `probe(scope)` to see later changes. */
    probe: string;
}
export interface FileDiff {
    binary: boolean;
    patch: string;
    beforeSize: number;
    afterSize: number;
    tooLarge: boolean;
}
const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const textLimit = 1024 * 1024;
const inScope = (path: string, scope: string) => !scope || path === scope || path.startsWith(scope + '/');
// Above this many work-tree files, probes only watch Git metadata. Edits then need a manual refresh.
const probeLimit = 5000;
const sameMetadata = (a: Metadata, b: Metadata) => a.size === b.size && [...a].every(([path, bytes]) => sameBytes(bytes, b.get(path) ?? null));

export async function openRepository(root: FileSystemDirectoryHandle) {
    // Linked worktrees and submodules may point outside the granted directory.
    try {await root.getDirectoryHandle('.git');} catch (error) {
        if (['NotFoundError', 'TypeMismatchError'].includes((error as DOMException).name)) throw new GitPanelError('invalid');
        throw error;
    }
    const fs = createReadOnlyFs(root);
    let tail = Promise.resolve();
    const serial = <T>(operation: () => Promise<T>) => {
        const result = tail.then(operation);
        tail = result.then(() => {}, () => {});
        return result;
    };
    const options = {fs, dir: '/', gitdir: '/.git'};
    let cache = {};
    let pushNeedsFetch = false;
    const metadata = async (): Promise<Metadata> => {
        const head = await readOptional(fs, '/.git/HEAD');
        if (!head) throw new GitPanelError('invalid');
        const text = new TextDecoder().decode(head).trim();
        const paths = ['/.git/HEAD', '/.git/index', '/.git/packed-refs', '/.git/shallow', '/.git/config'];
        if (text.startsWith('ref: refs/heads/')) {
            const ref = text.slice(5);
            pathParts(ref);
            paths.push('/.git/' + ref);
        } else if (!/^[0-9a-f]{40}$/.test(text)) throw new GitPanelError('invalid');
        const result: Metadata = new Map();
        for (const path of paths) {
            if (await readOptional(fs, path + '.lock')) throw new GitPanelError('changed');
            result.set(path, await readOptional(fs, path));
        }
        return result;
    };
    await metadata();

    const fileAt = async (parts: string[]) => {
        let directory = root;
        for (const name of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(name);
        return (await directory.getFileHandle(parts[parts.length - 1])).getFile();
    };
    const optionalFile = async (path: string) => {
        try {return await fileAt(pathParts(path));} catch (error) {
            if (['NotFoundError', 'TypeMismatchError'].includes((error as DOMException).name)) return null;
            throw error;
        }
    };
    const stamp = (file: File | null) => file ? `${file.size}:${file.lastModified}` : '-';
    /**
     * Fingerprints Git metadata and the work tree in `scope` from sizes and modification times, without
     * reading file contents other than HEAD. Returns 'locked' while Git holds a lock on that metadata.
     */
    const probe = async (scope = ''): Promise<string> => {
        const parts = pathParts(scope);
        const headFile = await optionalFile('.git/HEAD');
        if (!headFile) return 'locked';
        const head = (await headFile.text()).trim();
        const paths = ['.git/HEAD', '.git/index', '.git/packed-refs', '.git/shallow', '.git/config'];
        if (head.startsWith('ref: refs/heads/')) {
            try {pathParts(head.slice(5));} catch {return 'locked';}
            paths.push('.git/' + head.slice(5));
        }
        const lines: string[] = [];
        for (const path of paths) {
            if (await optionalFile(path + '.lock')) return 'locked';
            lines.push(`${path} ${stamp(await optionalFile(path))}`);
        }
        let start: FileSystemDirectoryHandle | null = root;
        try {for (const name of parts) start = await start.getDirectoryHandle(name);} catch {start = null;}
        const files: string[] = [];
        const visit = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<boolean> => {
            const entries = (directory as FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>}).values();
            for await (const entry of entries) {
                const path = prefix + entry.name;
                if (path === '.git') continue;
                if (entry.kind === 'directory') {
                    if (!await visit(entry as FileSystemDirectoryHandle, path + '/')) return false;
                } else {
                    files.push(`${path} ${stamp(await (entry as FileSystemFileHandle).getFile())}`);
                    if (files.length > probeLimit) return false;
                }
            }
            return true;
        };
        const prefix = parts.length ? parts.join('/') + '/' : '';
        const complete = start ? await visit(start, prefix) : true;
        if (complete) lines.push(...files.sort());
        else lines.push('work tree not watched');
        return lines.join('\n');
    };

    const entries = async (ref: string | null, scope: string): Promise<Map<string, Entry>> => {
        const tree = ref === null ? git.STAGE() : git.TREE({ref});
        const result = await git.walk({
            ...options, cache, trees: [tree],
            map: async (path, [entry]) => {
                if (path !== '.' && !inScope(path, scope) && !scope.startsWith(path + '/')) return null;
                if (!entry || await entry.type() === 'tree') return;
                const mode = await entry.mode();
                if (mode === 0o160000 || mode === 0o120000) throw new GitPanelError('unsupported');
                return {path, oid: await entry.oid(), mode};
            }
        }) as {path: string; oid: string; mode: number}[];
        return new Map(result.map(({path, oid, mode}) => [path, {oid, mode}]));
    };
    const assertSnapshot = async (snapshot: Snapshot) => {
        if (!sameMetadata(snapshot.metadata, await metadata())) throw new GitPanelError('changed');
    };
    const read = async (scope = ''): Promise<Snapshot> => {
        scope = pathParts(scope).join('/');
        fs.clearReads();
        cache = {};
        // Taken first, so a change during the read differs from the stored value and triggers another read.
        const fingerprint = await probe(scope);
        const before = await metadata();
        let head: string | null;
        try {head = await git.resolveRef({...options, ref: 'HEAD'});} catch (error) {
            if (errorCode(error) !== 'NotFoundError') throw error;
            head = null;
        }
        const branch = await git.currentBranch(options);
        const branches = await git.listBranches(options);
        const commits = head ? (await git.log({...options, cache, ref: head, depth: 50})).map(({oid, commit}) => ({
            oid, message: commit.message, author: commit.author.name, timestamp: commit.author.timestamp
        })) : [];
        const matrix = await git.statusMatrix({...options, cache, refresh: false, filepaths: [scope || '.']});
        const staged = await entries(null, scope);
        const committed = await entries(head || emptyTree, scope);
        const changes: FileChange[] = [];
        for (const [path, headState, workState, stageState] of matrix) {
            const previous = committed.get(path);
            const next = staged.get(path);
            if (headState !== stageState || previous?.mode !== next?.mode) {
                changes.push({path, group: 'staged', before: previous?.oid ?? null, after: next?.oid ?? null,
                    worktree: false, oldMode: previous?.mode ?? null, newMode: next?.mode ?? null});
            }
            if (workState !== stageState) {
                const bytes = workState ? await fs.promises.readFile('/' + path) as Uint8Array : null;
                const oid = bytes ? (await git.hashBlob({object: bytes})).oid : null;
                changes.push({path, group: !next && bytes ? 'untracked' : 'unstaged',
                    before: next?.oid ?? null, after: oid, worktree: true,
                    oldMode: next?.mode ?? null, newMode: bytes ? (next?.mode ?? 0o100644) : null});
            }
        }
        if (!sameMetadata(before, await metadata())) throw new GitPanelError('changed');
        await fs.checkReads();
        return {branch: branch || undefined, head, branches, commits, changes, scope, metadata: before, probe: fingerprint};
    };
    const historyChanges = async (snapshot: Snapshot, oid: string): Promise<FileChange[]> => {
        fs.clearReads();
        await assertSnapshot(snapshot);
        const {commit} = await git.readCommit({...options, cache, oid});
        const before = await entries(commit.parent[0] || emptyTree, snapshot.scope);
        const after = await entries(oid, snapshot.scope);
        const result: FileChange[] = [];
        for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
            const a = before.get(path), b = after.get(path);
            if (a?.oid !== b?.oid || a?.mode !== b?.mode) result.push({
                path, group: 'commit', before: a?.oid ?? null, after: b?.oid ?? null,
                oldMode: a?.mode ?? null, newMode: b?.mode ?? null, worktree: false
            });
        }
        await assertSnapshot(snapshot);
        await fs.checkReads();
        return result;
    };
    const readDiff = async (snapshot: Snapshot, change: FileChange): Promise<FileDiff> => {
        fs.clearReads();
        await assertSnapshot(snapshot);
        pathParts(change.path);
        const before = change.before ? (await git.readBlob({...options, cache, oid: change.before})).blob : new Uint8Array();
        let after: Uint8Array = new Uint8Array();
        if (change.after) {
            if (change.worktree) {
                const bytes = await readOptional(fs, '/' + change.path);
                if (!bytes || (await git.hashBlob({object: bytes})).oid !== change.after) throw new GitPanelError('changed');
                after = bytes;
            } else after = (await git.readBlob({...options, cache, oid: change.after})).blob;
        } else if (change.worktree && await readOptional(fs, '/' + change.path)) throw new GitPanelError('changed');
        await assertSnapshot(snapshot);
        await fs.checkReads();
        const tooLarge = Math.max(before.byteLength, after.byteLength) > textLimit;
        const binary = before.includes(0) || after.includes(0);
        const base = {beforeSize: before.byteLength, afterSize: after.byteLength, binary, tooLarge};
        if (binary || tooLarge) return {...base, patch: ''};
        const decoder = new TextDecoder('utf-8', {fatal: true});
        let oldText: string, newText: string;
        try {oldText = decoder.decode(before); newText = decoder.decode(after);} catch {
            return {...base, binary: true, patch: ''};
        }
        if (change.worktree && await git.getConfig({...options, path: 'core.autocrlf'}) === 'true') {
            newText = newText.replace(/\r\n/g, '\n');
        }
        // The path is rendered separately, so newline characters cannot alter patch headers.
        const patch = createTwoFilesPatch(change.before ? 'a/file' : '/dev/null', change.after ? 'b/file' : '/dev/null',
            oldText, newText, undefined, undefined, {context: 3, timeout: 1000});
        return patch === undefined ? {...base, tooLarge: true, patch: ''} :
            {...base, patch: 'diff --git a/file b/file\n' + patch.replace(/^=+\n/, '')};
    };
    const directoryAt = async (path: string) => {
        let directory = root;
        for (const part of pathParts(path)) directory = await directory.getDirectoryHandle(part);
        return directory;
    };
    const browse = async (path = '') => {
        path = pathParts(path).join('/');
        const directory = await directoryAt(path);
        const children: string[] = [];
        let isProject = false;
        for await (const entry of (directory as FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>}).values()) {
            if (entry.kind === 'directory' && entry.name !== '.git') children.push(entry.name);
            if (entry.kind === 'file' && entry.name === 'project.source.json') isProject = true;
        }
        return {path, children: children.sort(), isProject};
    };
    const openProject = async (path: string) => {
        const parts = pathParts(path);
        let directory = root;
        for (const part of parts) {
            directory = await directory.getDirectoryHandle(part);
            for await (const entry of (directory as FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>}).values()) {
                if (entry.name === '.git') throw new GitPanelError('invalid');
            }
        }
        const parentParts = await root.resolve(directory);
        if (parentParts === null || parentParts.join('/') !== parts.join('/')) throw new GitPanelError('invalid');
        await directory.getFileHandle('project.source.json');
        return directory;
    };
    return {root, openProject, browse, probe,
        readOrigin: () => serial(() => git.getConfig({...options, path: 'remote.origin.url'})),
        remoteOperation: (operation: RemoteOperation, getSession: GetRemoteSession, guard: () => void, signal?: AbortSignal) =>
            serial(async () => {
                if (operation === 'push' && pushNeedsFetch) throw new GitPanelError('pushUnknown');
                try {
                    await runRemoteOperation(root, operation, getSession, guard, signal);
                    if (operation === 'fetch') pushNeedsFetch = false;
                } catch (error) {
                    if (operation === 'push' && error instanceof GitPanelError &&
                        (error.code === 'pushUnknown' || error.code === 'pushRefresh')) pushNeedsFetch = true;
                    throw error;
                }
            }),
        read: (scope?: string) => serial(() => read(scope)),
        readDiff: (snapshot: Snapshot, change: FileChange) => serial(() => readDiff(snapshot, change)),
        historyChanges: (snapshot: Snapshot, oid: string) => serial(() => historyChanges(snapshot, oid))
    };
}
export type Repository = Awaited<ReturnType<typeof openRepository>>;
