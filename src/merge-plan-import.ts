import {GitPanelError} from './filesystem.js';
import {mergePlanConflictResolved, mergePlanPreviewFiles, saveImportedMergePlan, type MergePlan, type MergePlanFiles}
    from './merge-plan.js';
import {checkProject, parseSourceProject} from './project-source-merge.js';
import {isRecord} from './project-source-patch.js';
import {projectVersionFile} from './project-version.js';

export const mergePlanImportLimit = 32 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});

type Change = {path: string; kind: 'add' | 'replace' | 'delete'};
type Validate = (files: MergePlanFiles) => void;

function decodeChange(entry: Record<string, unknown>) {
    if (entry.delete === true && Object.keys(entry).length === 2) return null;
    if (Object.keys(entry).length !== 3 || typeof entry.data !== 'string') throw new GitPanelError('mergePlanImportFormat');
    if (entry.encoding === 'utf8') return encoder.encode(entry.data);
    if (entry.encoding === 'base64') {
        try {
            const decoded = atob(entry.data);
            if (btoa(decoded) !== entry.data) throw new Error('Expected canonical base64');
            const bytes = new Uint8Array(decoded.length);
            for (let index = 0; index < bytes.length; index++) bytes[index] = decoded.charCodeAt(index);
            return bytes;
        } catch {
            throw new GitPanelError('mergePlanImportFormat');
        }
    }
    throw new GitPanelError('mergePlanImportFormat');
}

const same = (prior: Uint8Array | undefined, bytes: Uint8Array) =>
    prior?.length === bytes.length && bytes.every((byte, index) => byte === prior[index]);

function importablePath(path: string) {
    try {
        return path.length <= 1024 &&
            (projectVersionFile(path) || path === 'block-palette.json' || path === '.tw-plus/workspace.json');
    } catch {
        return false;
    }
}

/** Prepare an import against the selected immutable snapshot. This never opens a file inside the repository. */
export function prepareMergePlanImport(plan: MergePlan, files: MergePlanFiles, source: string, validate: Validate) {
    let manifest: unknown;
    try {
        if (source.length > mergePlanImportLimit) throw new Error('Import exceeds size limit');
        manifest = JSON.parse(source);
    } catch {
        throw new GitPanelError('mergePlanImportFormat');
    }
    if (!isRecord(manifest) || manifest.formatVersion !== 1 || typeof manifest.baseGenerationId !== 'string' ||
        typeof manifest.baseContentId !== 'string' || !Array.isArray(manifest.files) || manifest.files.length > 256 ||
        Object.keys(manifest).some(key => !['formatVersion', 'baseGenerationId', 'baseContentId', 'files', 'resolves'].includes(key)) ||
        (manifest.resolves !== undefined && (!Array.isArray(manifest.resolves) || manifest.resolves.length > plan.conflicts.length))) {
        throw new GitPanelError('mergePlanImportFormat');
    }
    if (manifest.baseGenerationId !== plan.id || manifest.baseContentId !== plan.contentId) {
        throw new GitPanelError('mergePlanImportBase');
    }
    const seen = new Set<string>();
    const updated = new Map(files);
    const changes: Change[] = [];
    for (const entry of manifest.files) {
        if (!isRecord(entry) || typeof entry.path !== 'string' || !importablePath(entry.path) ||
            seen.has(entry.path)) throw new GitPanelError('mergePlanImportFormat');
        const path = entry.path;
        seen.add(path);
        const bytes = decodeChange(entry);
        const prior = files.get(path);
        if (bytes === null) {
            if (updated.delete(path)) changes.push({path, kind: 'delete'});
        } else if (!same(prior, bytes)) {
            updated.set(path, bytes);
            changes.push({path, kind: prior ? 'replace' : 'add'});
        }
    }
    if (!changes.length) throw new GitPanelError('mergePlanImportUnchanged');
    const changedPaths = new Set(changes.map(({path}) => path));
    const resolved = new Set(manifest.resolves ?? []);
    const resolutions = plan.conflicts.filter(({id, path}) =>
        resolved.has(id) && changedPaths.has(path) && !mergePlanConflictResolved(plan, id));
    if (resolved.size !== resolutions.length || resolved.size !== (manifest.resolves?.length ?? 0)) {
        throw new GitPanelError('mergePlanImportInvalid');
    }
    try {
        const projectFile = updated.get('project.source.json');
        const project = projectFile && parseSourceProject(decoder.decode(projectFile));
        if (!project || checkProject(project).length) throw new Error('Invalid block or project references');
        validate(mergePlanPreviewFiles(updated));
    } catch {
        throw new GitPanelError('mergePlanImportInvalid');
    }
    return {
        changes, resolutions,
        save: () => saveImportedMergePlan(plan, updated, resolutions.map(({id}) => id))
    };
}

export type MergePlanImport = ReturnType<typeof prepareMergePlanImport>;
