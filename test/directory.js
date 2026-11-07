import fs from 'node:fs/promises';
import path from 'node:path';

export function directoryHandle(root) {
    const child = name => {
        if (!name || name.includes('/') || name === '..' || name === '.') throw new TypeError('Expected a child name');
        return path.join(root, name);
    };
    const check = async (name, kind) => {
        const filename = child(name);
        let stat;
        try {stat = await fs.lstat(filename);} catch (error) {
            if (error.code === 'ENOENT') throw new DOMException('Missing entry', 'NotFoundError');
            throw error;
        }
        if (stat.isSymbolicLink()) throw new DOMException('Symbolic link', 'NotAllowedError');
        if (stat.isDirectory() !== (kind === 'directory')) throw new DOMException('Different entry type', 'TypeMismatchError');
        return filename;
    };
    return {
        kind: 'directory', name: path.basename(root),
        async getFileHandle(name) {
            const filename = await check(name, 'file');
            return {kind: 'file', name, async getFile() {
                const bytes = await fs.readFile(filename);
                const stat = await fs.stat(filename);
                return new File([bytes], name, {lastModified: stat.mtimeMs});
            }};
        },
        async getDirectoryHandle(name) {return directoryHandle(await check(name, 'directory'));},
        async *keys() {for (const name of await fs.readdir(root)) yield name;},
        async *values() {
            for (const item of await fs.readdir(root, {withFileTypes: true})) {
                if (item.isSymbolicLink()) continue;
                yield item.isDirectory() ? directoryHandle(path.join(root, item.name)) : await this.getFileHandle(item.name);
            }
        },
        async resolve(handle) {
            const relative = path.relative(root, handle.location);
            return relative === '' ? [] : relative.startsWith('..') ? null : relative.split(path.sep);
        },
        location: root
    };
}
