import {fileError, fileStat, GitPanelError, pathParts} from './filesystem.js';

export type InitialCommitEntry = {path: string; bytes: Uint8Array<ArrayBuffer> | null};

/** The private worktree used to build an initial commit without a local folder grant. */
export function createInitialCommitFs() {
    const directories = new Set(['/']);
    const files = new Map<string, Uint8Array<ArrayBuffer>>();
    const normalize = (path: string) => '/' + pathParts(path).join('/');
    const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
    const unsupported = async () => {throw new GitPanelError('unsupported');};
    function directory(path: string) {
        if (!directories.has(path)) throw fileError(files.has(path) ? 'ENOTDIR' : 'ENOENT', path);
    }
    function mkdir(path: string) {
        directory(parent(path));
        if (directories.has(path) || files.has(path)) throw fileError('EEXIST', path);
        directories.add(path);
    }
    function readdir(path: string) {
        directory(path);
        return [...directories, ...files.keys()].filter(entry => entry !== path && parent(entry) === path)
            .map(entry => entry.slice(entry.lastIndexOf('/') + 1));
    }
    function writeFile(path: string, bytes: Uint8Array | string) {
        directory(parent(path));
        if (directories.has(path)) throw fileError('EISDIR', path);
        files.set(path, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : Uint8Array.from(bytes));
    }
    async function stat(raw: string) {
        const path = normalize(raw);
        const bytes = files.get(path);
        if (bytes) return fileStat({size: bytes.byteLength, lastModified: 0});
        directory(path);
        return fileStat(null);
    }
    return {
        entries(): InitialCommitEntry[] {
            return [
                ...[...directories].filter(path => path !== '/').map(path => ({path, bytes: null})),
                ...[...files].map(([path, bytes]) => ({path, bytes}))
            ];
        },
        add(path: string, bytes: Uint8Array) {
            let current = '';
            for (const name of pathParts(path).slice(0, -1)) {
                current += '/' + name;
                if (!directories.has(current)) mkdir(current);
            }
            if (files.has('/' + path)) throw fileError('EEXIST', path);
            writeFile('/' + path, bytes);
        },
        fs: {promises: {
            async readFile(raw: string, options?: string | {encoding?: string}) {
                const path = normalize(raw);
                const bytes = files.get(path);
                if (!bytes) throw fileError(directories.has(path) ? 'EISDIR' : 'ENOENT', path);
                const encoding = typeof options === 'string' ? options : options?.encoding;
                return encoding ? new TextDecoder(encoding).decode(bytes) : bytes.slice();
            },
            async writeFile(raw: string, bytes: Uint8Array | string) {writeFile(normalize(raw), bytes);},
            async mkdir(raw: string) {mkdir(normalize(raw));},
            async readdir(raw: string) {return readdir(normalize(raw));},
            async unlink(raw: string) {
                const path = normalize(raw);
                if (!files.delete(path)) throw fileError(directories.has(path) ? 'EISDIR' : 'ENOENT', path);
            },
            async rmdir(raw: string) {
                const path = normalize(raw);
                if (readdir(path).length) throw fileError('ENOTEMPTY', path);
                directories.delete(path);
            },
            stat, lstat: stat, readlink: unsupported, symlink: unsupported, chmod: unsupported
        }}
    };
}
