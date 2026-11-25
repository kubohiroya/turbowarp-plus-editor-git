import {GitPanelError} from './filesystem.js';
import {mergeJson} from './merge-json.js';
import {mergePlanConflictResolved, saveMergePlanProject, type MergePlan, type MergePlanFiles, type MergePlanSeed} from './merge-plan.js';
import {checkProject, parseSourceProject, type SourceProject, type SourceTarget} from './project-source-merge.js';
import {equal, isRecord} from './project-source-patch.js';

export interface PlaytestConflict {
    id: string;
    conflictId?: string;
    target: string;
    script: string;
    next: string;
    focus: string;
    input?: string;
}

export interface MergePlaytestRequest {
    conflicts: PlaytestConflict[];
    blocking: string[];
    canCompare?: boolean;
    canSaveGeneration?: boolean;
}

export interface PlaytestStop extends PlaytestConflict {
    previous?: string;
}

export const PLAYTEST_COMPARE = 'tw-plus/merge-playtest-compare';
export const PLAYTEST_EDIT_ADOPTED = 'tw-plus/merge-playtest-edit-adopted';
export interface PlaytestEdit {
    id: string;
    blocks: Record<string, unknown>;
}

export type SavePlaytestGeneration = (edits: readonly PlaytestEdit[]) => Promise<void>;

const records = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const blocksOf = (target?: SourceTarget) => records(target?.blocks);

function parentIds(blocks: Record<string, unknown>, id: string) {
    const parents: string[] = [];
    const seen = new Set([id]);
    for (let parent = records(blocks[id]).parent; typeof parent === 'string'; parent = records(blocks[parent]).parent) {
        if (seen.has(parent) || !isRecord(blocks[parent])) return [];
        parents.push(parent);
        seen.add(parent);
    }
    return parents;
}

function executionBlock(blocks: Record<string, unknown>, id: string, parents: string[]) {
    let child = id;
    for (const parent of parents) {
        const block = records(blocks[parent]);
        if (block.next === child || Object.entries(records(block.inputs)).some(([name, input]) =>
            name.startsWith('SUBSTACK') && Array.isArray(input) && input[1] === child)) return child;
        child = parent;
    }
}

const decode = new TextDecoder();

/** Resolve the overlap to a command boundary before any reporters of that command run. */
export function mergePlaytestRequest(plan: MergePlan, files: MergePlanFiles, seed: MergePlanSeed): MergePlaytestRequest {
    const request: MergePlaytestRequest = {conflicts: [], blocking: []};
    const bytes = files.get('project.source.json');
    const project = bytes && parseSourceProject(decode.decode(bytes));
    const resolvedPoints = new Set(plan.playtestPoints);
    for (const item of seed.conflicts) {
        if (mergePlanConflictResolved(plan, item.id)) continue;
        if (item.type !== 'project') {
            if (/^(?:project\.source\.json|sb3-source\.json|embedded-extensions\.json|block-palette\.json|assets\/)/.test(item.path)) {
                request.blocking.push(item.path);
            }
            continue;
        }
        const {location, base, current, incoming} = item.conflict;
        const name = location.target;
        const target = project?.targets.find(candidate => candidate.name === name);
        const blocks = blocksOf(target);
        if (location.type === 'scripts' && target) {
            const overlapping = mergeJson(base, current, incoming).conflicts;
            const points = overlapping.flatMap(({path}, index) => {
                const id = item.id + ':' + index;
                if (resolvedPoints.has(id)) return [];
                const [focus, property, input] = path;
                if (typeof focus !== 'string' || !isRecord(blocks[focus]) || (property !== 'fields' && property !== 'inputs') ||
                    typeof input !== 'string' || input.startsWith('SUBSTACK')) return [undefined];
                const parents = parentIds(blocks, focus);
                const script = parents.at(-1);
                const next = executionBlock(blocks, focus, parents);
                const entry = script && records(blocks[script]).opcode;
                if (!script || !next || typeof entry !== 'string' ||
                    !/^(event_when|control_start_as_clone)/.test(entry)) return [undefined];
                return [{id, conflictId: item.id, target: target.name, script, next, focus, input}];
            });
            if (overlapping.length && points.every(point => point !== undefined)) {
                request.conflicts.push(...points);
                continue;
            }
        }
        request.blocking.push([name, location.type === 'property' && location.path.join('.')]
            .filter(Boolean).join(' · ') || item.path);
    }
    return request;
}

interface ExecutionThread {
    topBlock: string;
    target: {getName(): string};
}

export function observePlaytest(conflicts: readonly PlaytestConflict[], onStop: (stop: PlaytestStop) => void) {
    const previous = new WeakMap<ExecutionThread, string>();
    const adopted = new Set<string>();
    let stopped: PlaytestStop | undefined;
    let stoppedThread: ExecutionThread | undefined;
    return {
        get paused() {return stopped !== undefined;},
        get stopped() {return stopped;},
        get stoppedThread() {return stoppedThread;},
        before(thread: ExecutionThread, block: string) {
            const conflict = conflicts.find(item => item.next === block && item.script === thread.topBlock &&
                item.target === thread.target.getName() && !adopted.has(item.id));
            if (!conflict) return true;
            stopped = {...conflict, previous: previous.get(thread)};
            stoppedThread = thread;
            onStop(stopped);
            return false;
        },
        after(thread: ExecutionThread, block: string) {
            // Entry hats identify the script; they do not represent a completed command.
            if (thread.topBlock !== block) previous.set(thread, block);
        },
        resume() {
            if (!stopped) return;
            adopted.add(stopped.id);
            stopped = undefined;
            stoppedThread = undefined;
        }
    };
}

function scriptIds(blocks: Record<string, unknown>, start: string) {
    const ids = new Set<string>();
    const visit = (value: unknown) => {
        if (typeof value !== 'string' || ids.has(value) || !Object.hasOwn(blocks, value)) return;
        ids.add(value);
        const block = records(blocks[value]);
        visit(block.next);
        for (const input of Object.values(records(block.inputs))) {
            if (Array.isArray(input)) {
                visit(input[1]);
                visit(input[2]);
            }
        }
    };
    visit(start);
    return ids;
}

const targetByName = (project: SourceProject, name: string) => project.targets.find(target => target.name === name);

export function saveMergePlaytest(plan: MergePlan, files: MergePlanFiles, seed: MergePlanSeed, request: MergePlaytestRequest,
    edits: readonly PlaytestEdit[]) {
    const source = files.get('project.source.json');
    const project = source && parseSourceProject(decode.decode(source));
    if (!project) throw new GitPanelError('versionMissing');
    if (!edits.length) throw new GitPanelError('mergePlanEditUnchanged');
    const conflicts = new Map(request.conflicts.map(conflict => [conflict.id, conflict]));
    const points = new Set(plan.playtestPoints);
    const resolutions = new Set(plan.playtestResolutions);
    for (const edit of edits) {
        const stop = conflicts.get(edit.id);
        const target = stop && targetByName(project, stop.target);
        if (!stop || !target || points.has(edit.id)) throw new GitPanelError('mergePlanEditUnsupported');
        const builder = new Map(Object.entries(blocksOf(target)));
        for (const [id, block] of Object.entries(edit.blocks)) {
            if (block === null) builder.delete(id);
            else builder.set(id, block);
        }
        const next = Object.fromEntries(builder);
        const replacement = validateScriptEdit(project, target, next, stop);
        if (!replacement?.changedIds.size || Object.keys(edit.blocks).some(id => !replacement.changedIds.has(id))) {
            throw new GitPanelError('mergePlanEditUnsupported');
        }
        target.blocks = next;
        points.add(edit.id);
    }
    for (const item of seed.conflicts) {
        if (item.type !== 'project' || item.conflict.location.type !== 'scripts') continue;
        const {base, current, incoming} = item.conflict;
        const overlaps = mergeJson(base, current, incoming).conflicts;
        if (overlaps.length && overlaps.every((_, index) => points.has(item.id + ':' + index))) resolutions.add(item.id);
    }
    return saveMergePlanProject({...plan, playtestPoints: [...points], playtestResolutions: [...resolutions]}, files, project);
}

/** Keep the live VM's state and all other scripts. Return only replacement block definitions. */
export function resumeScriptEdit(before: string, after: string, stop: PlaytestStop) {
    const original = parseSourceProject(before);
    const edited = parseSourceProject(after);
    if (!original || !edited) return;
    const target = targetByName(original, stop.target);
    const changed = targetByName(edited, stop.target);
    if (!target || !changed) return;
    const codeProperties = ['variables', 'lists', 'broadcasts'];
    if (edited.targets.length !== original.targets.length || !equal(original.extensions, edited.extensions) ||
        !equal(original.extensionURLs, edited.extensionURLs) || original.targets.some(candidate => {
            const result = targetByName(edited, candidate.name);
            return !result || codeProperties.some(key => !equal(candidate[key], result[key])) ||
                (candidate !== target && !equal(candidate.blocks, result.blocks));
        })) return;
    return validateScriptEdit(original, target, blocksOf(changed), stop);
}

function validateScriptEdit(original: SourceProject, target: SourceTarget, next: Record<string, unknown>, stop: PlaytestConflict) {
    const base = blocksOf(target);
    const oldIds = scriptIds(base, stop.script);
    const newIds = scriptIds(next, stop.script);
    const parents = parentIds(base, stop.next);
    if (!newIds.has(stop.next) || !equal(parents, parentIds(next, stop.next)) ||
        parents.some(id => !equal(base[id], next[id]))) return;
    const otherIds = new Set([...Object.keys(base), ...Object.keys(next)].filter(id => !oldIds.has(id) && !newIds.has(id)));
    if ([...otherIds].some(id => !equal(base[id], next[id])) || [...newIds].some(id => !oldIds.has(id) && Object.hasOwn(base, id))) return;
    if (checkProject({...original, targets: original.targets.map(item => item === target ? {...item, blocks: next} : item)}).length) return;
    const changedIds = new Set([...oldIds, ...newIds].filter(id => !equal(base[id], next[id])));
    const affected = new Set(changedIds);
    for (const id of changedIds) {
        for (const blocks of [base, next]) {
            for (const parent of parentIds(blocks, id)) affected.add(parent);
        }
    }
    return {blocks: next, changedIds, affected};
}
