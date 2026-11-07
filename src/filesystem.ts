export class GitPanelError extends Error {
    constructor(public code: 'invalid' | 'changed' | 'large' | 'unsupported', message: string = code) {
        super(message);
        this.name = 'GitPanelError';
    }
}

const fileError = (code: string, path: string) => Object.assign(new Error(`${code}: ${path}`), {code});
export const errorCode = (error: unknown) => (error as {code?: string})?.code;

export function pathParts(path: string): string[] {
    const parts = path.split('/').filter(part => part && part !== '.');
    if (parts.some(part => part === '..' || part.includes('\0'))) throw fileError('EACCES', path);
    return parts;
}

/** Adapt granted handles without exposing any filesystem mutation. */
export function createReadOnlyFs(root: FileSystemDirectoryHandle) {
    const directory = async (parts: string[]) => {
        let handle = root;
        for (const name of parts) handle = await handle.getDirectoryHandle(name);
        return handle;
    };
    const handle = async (path: string): Promise<FileSystemDirectoryHandle | FileSystemFileHandle> => {
        const parts = pathParts(path);
        if (!parts.length) return root;
        const name = parts.pop()!;
        try {
            const parent = await directory(parts);
            try {
                return await parent.getFileHandle(name);
            } catch (error) {
                if ((error as DOMException).name !== 'TypeMismatchError') throw error;
                return await parent.getDirectoryHandle(name);
            }
        } catch (error) {
            if ((error as DOMException).name === 'NotFoundError') throw fileError('ENOENT', path);
            if ((error as DOMException).name === 'TypeMismatchError') throw fileError('ENOTDIR', path);
            throw error;
        }
    };
    const reads = new Map<string, {size: number; modified: number}>();
    const listings = new Map<string, string[]>();
    const observe = (path: string, file: File) => {
        const previous = reads.get(path);
        if (previous && (previous.size !== file.size || previous.modified !== file.lastModified)) {
            throw new GitPanelError('changed');
        }
        reads.set(path, {size: file.size, modified: file.lastModified});
    };
    const readFile = async (path: string, options?: string | {encoding?: string}) => {
        const item = await handle(path);
        if (item.kind !== 'file') throw fileError('EISDIR', path);
        const file = await item.getFile();
        observe(path, file);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const encoding = typeof options === 'string' ? options : options?.encoding;
        return encoding ? new TextDecoder(encoding).decode(bytes) : bytes;
    };
    const stat = async (path: string) => {
        const item = await handle(path);
        const file = item.kind === 'file' ? await item.getFile() : null;
        if (file) observe(path, file);
        const time = file?.lastModified ?? 0;
        return {
            isFile: () => item.kind === 'file',
            isDirectory: () => item.kind === 'directory',
            isSymbolicLink: () => false,
            size: file?.size ?? 0,
            mode: file ? 0o100644 : 0o40755,
            mtimeMs: time, ctimeMs: time, atimeMs: time, birthtimeMs: time,
            mtime: new Date(time), ctime: new Date(time), atime: new Date(time), birthtime: new Date(time),
            dev: 0, ino: 0, uid: 0, gid: 0
        };
    };
    const rejectWrite = async (path: string): Promise<never> => {throw fileError('EROFS', path);};
    return {
        clearReads() {reads.clear(); listings.clear();},
        async checkReads() {
            for (const [path, expected] of reads) {
                const item = await handle(path);
                if (item.kind !== 'file') throw new GitPanelError('changed');
                const file = await item.getFile();
                if (file.size !== expected.size || file.lastModified !== expected.modified) throw new GitPanelError('changed');
            }
            for (const [path, expected] of listings) {
                const item = await directory(pathParts(path));
                const names: string[] = [];
                for await (const name of (item as FileSystemDirectoryHandle & {keys(): AsyncIterable<string>}).keys()) names.push(name);
                if (JSON.stringify(names.sort()) !== JSON.stringify(expected)) throw new GitPanelError('changed');
            }
        },
        promises: {
        readFile,
        stat,
        lstat: stat,
        async readdir(path: string) {
            const item = await handle(path);
            if (item.kind !== 'directory') throw fileError('ENOTDIR', path);
            const names: string[] = [];
            for await (const name of (item as FileSystemDirectoryHandle & {keys(): AsyncIterable<string>}).keys()) {
                names.push(name);
            }
            listings.set(path, names.sort());
            return names;
        },
        writeFile: rejectWrite, unlink: rejectWrite, mkdir: rejectWrite, rmdir: rejectWrite,
        symlink: rejectWrite, chmod: rejectWrite,
        async readlink(): Promise<never> {throw new GitPanelError('unsupported');}
    }};
}

export async function readOptional(fs: ReturnType<typeof createReadOnlyFs>, path: string): Promise<Uint8Array | null> {
    try {
        return await fs.promises.readFile(path) as Uint8Array;
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
    }
}

export const sameBytes = (left: Uint8Array | null, right: Uint8Array | null) =>
    left === right || Boolean(left && right && left.length === right.length && left.every((byte, i) => byte === right[i]));
