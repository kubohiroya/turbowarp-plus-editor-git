import {createReadOnlyFs, errorCode, fileError, fileStat, GitPanelError, pathParts, sameBytes} from './filesystem.js';

type Entry = {kind: 'directory'} | {kind: 'file'; bytes: Uint8Array<ArrayBuffer>; time: number} | null;
type Change = {path: string; before: Entry; after: Entry};
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '');

// Stage Git's writes before touching the granted directory. Pack data precedes refs.
export function createMutationFs(root: FileSystemDirectoryHandle, worktree: boolean) {
    const base = createReadOnlyFs(root);
    const changes = new Map<string, Change>();
    const normalize = (path: string) => '/' + pathParts(path).join('/');
    const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
    const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);
    const fail = (code: string, path: string): never => {throw fileError(code, path);};
    function allow(path: string, directory = false) {
        const parts = pathParts(path);
        const [first, second, ...rest] = parts;
        if (!first || parts.slice(1).some(part => part.toLowerCase() === '.git'))
            return fail('EACCES', path);
        if (first === '.git') {
            const writableFolder = second === 'refs' || second === 'logs' ||
                (second === 'objects' && rest[0]?.toLowerCase() !== 'info');
            const writableFile = !directory && !rest.length &&
                ['HEAD', 'ORIG_HEAD', 'FETCH_HEAD', 'index', 'packed-refs', 'shallow'].includes(second);
            if (writableFolder || writableFile) return;
        } else if (first.toLowerCase() !== '.git' && worktree) {
            return;
        }
        fail('EACCES', path);
    }

    async function readEntry(fs: typeof base.promises, path: string): Promise<Entry> {
        try {
            const stat = await fs.stat(path);
            if (stat.isDirectory()) return {kind: 'directory'};
            const bytes = await fs.readFile(path);
            if (!(bytes instanceof Uint8Array)) throw new GitPanelError('unsupported');
            return {kind: 'file', bytes: Uint8Array.from(bytes), time: stat.mtimeMs};
        } catch (error) {
            if (missing(error)) return null;
            throw error;
        }
    }

    async function kind(path: string) {
        const change = changes.get(path);
        if (change) return change.after?.kind;
        try {return (await base.promises.stat(path)).isDirectory() ? 'directory' : 'file';}
        catch (error) {if (!missing(error)) throw error;}
    }

    async function stage(path: string, after: Entry) {
        const previous = changes.get(path);
        const before = previous ? previous.before : await readEntry(base.promises, path);
        if (before && after && before.kind !== after.kind) throw new GitPanelError('unsupported');
        changes.set(path, {path, before, after});
    }

    async function readdir(raw: string) {
        const path = normalize(raw);
        const current = await kind(path);
        if (current !== 'directory') return fail(current ? 'ENOTDIR' : 'ENOENT', path);
        const names = new Set<string>();
        try {for (const entry of await base.promises.readdir(path)) names.add(entry);}
        catch (error) {if (!missing(error)) throw error;}
        for (const change of changes.values()) {
            if (parent(change.path) !== path) continue;
            if (change.after) names.add(name(change.path));
            else names.delete(name(change.path));
        }
        return [...names];
    }

    async function remove(raw: string, directory: boolean) {
        const path = normalize(raw);
        allow(path, directory);
        const current = await kind(path);
        if (!current) return fail('ENOENT', path);
        if (directory !== (current === 'directory')) return fail(directory ? 'ENOTDIR' : 'EISDIR', path);
        if (directory && (await readdir(path)).length) return fail('ENOTEMPTY', path);
        await stage(path, null);
    }

    async function stat(raw: string) {
        const path = normalize(raw);
        const change = changes.get(path);
        if (!change) return base.promises.stat(path);
        if (!change.after) return fail('ENOENT', path);
        return fileStat(change.after.kind === 'directory' ? null :
            {size: change.after.bytes.length, lastModified: change.after.time});
    }

    const fs = {promises: {
        async readFile(raw: string, options?: string | {encoding?: string}) {
            const path = normalize(raw);
            const change = changes.get(path);
            if (!change) return base.promises.readFile(path, options);
            if (!change.after) return fail('ENOENT', path);
            if (change.after.kind === 'directory') return fail('EISDIR', path);
            const encoding = typeof options === 'string' ? options : options?.encoding;
            return encoding ? new TextDecoder(encoding).decode(change.after.bytes) : change.after.bytes.slice();
        },
        async writeFile(raw: string, bytes: string | Uint8Array, options?: {mode?: number}) {
            const path = normalize(raw);
            allow(path);
            if (!path.startsWith('/.git/') && options?.mode && (options.mode & 0o111))
                throw new GitPanelError('unsupported');
            if (await kind(parent(path)) !== 'directory') return fail('ENOENT', path);
            if (await kind(path) === 'directory') return fail('EISDIR', path);
            await stage(path, {kind: 'file', bytes: typeof bytes === 'string' ?
                new TextEncoder().encode(bytes) : Uint8Array.from(bytes), time: Date.now()});
        },
        async mkdir(raw: string) {
            const path = normalize(raw);
            if (await kind(path)) return fail('EEXIST', path);
            allow(path, true);
            if (await kind(parent(path)) !== 'directory') return fail('ENOENT', path);
            await stage(path, {kind: 'directory'});
        },
        unlink: (path: string) => remove(path, false),
        rmdir: (path: string) => remove(path, true),
        readdir, stat, lstat: stat,
        readlink: base.promises.readlink,
        symlink: base.promises.symlink,
        chmod: base.promises.chmod
    }};

    function equal(a: Entry, b: Entry) {
        return a?.kind === b?.kind && (a?.kind !== 'file' || (b?.kind === 'file' && sameBytes(a.bytes, b.bytes)));
    }

    async function apply(path: string, from: Entry, to: Entry) {
        const current = createReadOnlyFs(root).promises;
        if (path.startsWith('/.git/') && (await readEntry(current, path + '.lock') ||
            await readEntry(current, '/.git/index.lock') || await readEntry(current, '/.git/packed-refs.lock')))
            throw new GitPanelError('changed');
        if (!equal(await readEntry(current, path), from))
            throw new GitPanelError('changed');
        let directory = root;
        for (const part of pathParts(parent(path))) directory = await directory.getDirectoryHandle(part);
        const filename = name(path);
        if (!to) await directory.removeEntry(filename);
        else if (to.kind === 'directory') await directory.getDirectoryHandle(filename, {create: true});
        else {
            const handle = await directory.getFileHandle(filename, {create: !from});
            let stream: FileSystemWritableFileStream | undefined;
            try {
                stream = await handle.createWritable();
                await stream.write(to.bytes);
                await stream.close();
            } catch (error) {
                await stream?.abort().catch(() => {});
                if (!from) {
                    const current = await handle.getFile();
                    if (current.size === 0) await directory.removeEntry(filename);
                }
                throw error;
            }
        }
    }

    function order(change: Change) {
        const {path, before, after} = change;
        const depth = pathParts(path).length;
        if (!after) return before?.kind === 'directory' ? 1000 - depth : 0;
        if (after.kind === 'directory') return 1000 + depth;
        if (path.startsWith('/.git/objects/')) return 2000;
        if (!path.startsWith('/.git/')) return 3000;
        return path.startsWith('/.git/refs/heads/') || path === '/.git/HEAD' ? 5000 : 4000;
    }

    return {fs, async commit(guard: () => void) {
        const pending = [...changes.values()].filter(change => !equal(change.before, change.after))
            .sort((left, right) => order(left) - order(right));
        await base.checkReads();
        for (const change of pending) {
            if (!equal(await readEntry(createReadOnlyFs(root).promises, change.path), change.before))
                throw new GitPanelError('changed');
        }
        const applied: Change[] = [];
        try {
            for (const change of pending) {
                guard();
                try {
                    await apply(change.path, change.before, change.after);
                    applied.push(change);
                } catch (error) {
                    const current = await readEntry(createReadOnlyFs(root).promises, change.path);
                    if (equal(current, change.after) && !(error instanceof GitPanelError)) applied.push(change);
                    throw error;
                }
            }
            guard();
        } catch (error) {
            let rollbackFailed = false;
            for (const change of applied.reverse()) {
                try {await apply(change.path, change.after, change.before);}
                catch {rollbackFailed = true;}
            }
            if (rollbackFailed) throw new GitPanelError('rollbackFailed');
            throw error;
        }
    }};
}
