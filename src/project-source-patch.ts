import {applyPatch, createTwoFilesPatch, parsePatch} from 'diff';

export type BlockTable = Record<string, unknown>;
export interface ProjectTarget {
    name: string;
    isStage: boolean;
    blocks: BlockTable;
}
export type ProjectSource = Record<string, unknown> & {targets: ProjectTarget[]};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function readProject(source: string): ProjectSource {
    const project: unknown = JSON.parse(source);
    if (!isRecord(project) || !Array.isArray(project.targets) || !project.targets.every(target =>
        isRecord(target) && typeof target.name === 'string' && typeof target.isStage === 'boolean' && (target.blocks === undefined || isRecord(target.blocks)))) {
        throw new Error('Expected a project.source.json with Scratch targets and blocks.');
    }
    const parsed = project as ProjectSource;
    return {...parsed, targets: parsed.targets.map(target => ({...target, blocks: target.blocks ?? {}}))};
}

/** Keep the original lines and include enough context to render both sides from the patch alone. */
export function createProjectSourceDiff(before: string, after: string): string {
    readProject(before);
    readProject(after);
    const patch = createTwoFilesPatch('a/project.source.json', 'b/project.source.json', before, after,
        undefined, undefined, {context: Infinity, timeout: 1000});
    if (patch === undefined) throw new Error('Project source diff exceeded its time limit.');
    return 'diff --git a/project.source.json b/project.source.json\n' + patch.replace(/^=+\n/, '');
}

export function readProjectSourceDiff(patch: string, beforeSource?: string): [ProjectSource, ProjectSource] | null {
    const [file, extra] = parsePatch(patch);
    if (!file || extra || !file.oldFileName || !file.newFileName) throw new Error('Expected a single unified text diff.');
    if (beforeSource !== undefined) {
        const before = readProject(beforeSource);
        const after = applyPatch(beforeSource, file);
        if (after === false) throw new Error('The original project does not match this diff.');
        return [before, readProject(after)];
    }
    if (!file.hunks.length) return null;
    const before: string[] = [], after: string[] = [];
    for (const hunk of file.hunks) {
        if (hunk.oldStart !== before.length + 1 || hunk.newStart !== after.length + 1) {
            throw new Error('The diff omits project context.');
        }
        for (const line of hunk.lines) {
            if (line.startsWith(' ') || line.startsWith('-')) before.push(line.slice(1));
            if (line.startsWith(' ') || line.startsWith('+')) after.push(line.slice(1));
        }
    }
    return [readProject(before.join('\n')), readProject(after.join('\n'))];
}

export function equal(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => equal(value, b[i]));
    if (!isRecord(a) || !isRecord(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

export const targetKey = (target: ProjectTarget) => target.isStage ? 'stage' : 'sprite:' + target.name;

export interface BlockSide { target: ProjectTarget; id: string }
export interface BlockPart { kind: 'input' | 'field'; name: string }

function changedParts(before: unknown, after: unknown): BlockPart[] {
    if (!isRecord(before) || !isRecord(after)) return [];
    const result: BlockPart[] = [];
    // A shadow hidden behind a reporter is not the field shown in the workspace.
    const visibleInput = (input: unknown) => Array.isArray(input) ? input[1] ?? input[2] : input;
    for (const group of ['inputs', 'fields'] as const) {
        const oldGroup = isRecord(before[group]) ? before[group] : {};
        const newGroup = isRecord(after[group]) ? after[group] : {};
        for (const name of new Set([...Object.keys(oldGroup), ...Object.keys(newGroup)])) {
            const a = oldGroup[name], b = newGroup[name];
            if (group === 'inputs' ? !equal(visibleInput(a), visibleInput(b)) : !equal(a, b)) {
                result.push({kind: group === 'inputs' ? 'input' : 'field', name});
            }
        }
    }
    return result;
}
export type BlockChangeKind = 'added' | 'removed' | 'updated';
export interface BlockChange {
    key: string;
    before?: BlockSide;
    after?: BlockSide;
    kind: BlockChangeKind;
    fields: string[];
    parts: BlockPart[];
}

export function compareProjectBlocks(before: ProjectSource, after: ProjectSource) {
    const oldTargets = new Map(before.targets.map(target => [targetKey(target), target]));
    const newTargets = new Map(after.targets.map(target => [targetKey(target), target]));
    const changes: BlockChange[] = [];
    let unchanged = 0;
    for (const key of new Set([...oldTargets.keys(), ...newTargets.keys()])) {
        const oldTarget = oldTargets.get(key), newTarget = newTargets.get(key);
        const oldBlocks: BlockTable = oldTarget?.blocks ?? {}, newBlocks: BlockTable = newTarget?.blocks ?? {};
        for (const id of new Set([...Object.keys(oldBlocks), ...Object.keys(newBlocks)])) {
            const hadBlock = Object.hasOwn(oldBlocks, id), hasBlock = Object.hasOwn(newBlocks, id);
            const a = oldBlocks[id], b = newBlocks[id];
            if (hadBlock && hasBlock && equal(a, b)) {
                unchanged++;
                continue;
            }
            const fields = isRecord(a) && isRecord(b) ?
                [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(field => !equal(a[field], b[field])) : [];
            changes.push({key: JSON.stringify([key, id]), before: hadBlock && oldTarget ? {target: oldTarget, id} : undefined,
                after: hasBlock && newTarget ? {target: newTarget, id} : undefined,
                kind: !hadBlock ? 'added' : !hasBlock ? 'removed' : 'updated', fields, parts: changedParts(a, b)});
        }
    }
    const withoutBlocks = (project: ProjectSource) => ({...project, targets: project.targets.map(({blocks: _, ...target}) => target)});
    return {changes, unchanged, otherChanges: !equal(withoutBlocks(before), withoutBlocks(after))};
}
