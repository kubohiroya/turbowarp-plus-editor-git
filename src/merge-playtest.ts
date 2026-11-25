import {mergeJson} from './merge-json.js';
import type {MergePlan, MergePlanFiles, MergePlanSeed} from './merge-plan.js';
import {checkProject, parseSourceProject, type SourceProject, type SourceTarget} from './project-source-merge.js';
import {equal, isRecord} from './project-source-patch.js';

export interface PlaytestConflict {
    id: string;
    target: string;
    script: string;
    next: string;
    focus: string;
    input?: string;
}

export interface MergePlaytestRequest {
    conflicts: PlaytestConflict[];
    blocking: string[];
}

export interface PlaytestStop extends PlaytestConflict {
    previous?: string;
}

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
    for (const item of seed.conflicts) {
        if (plan.choices[item.id]) continue;
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
            const points = overlapping.map(({path}, index): PlaytestConflict | undefined => {
                const [focus, property, input] = path;
                if (typeof focus !== 'string' || !isRecord(blocks[focus]) || (property !== 'fields' && property !== 'inputs') ||
                    typeof input !== 'string' || input.startsWith('SUBSTACK')) return;
                const parents = parentIds(blocks, focus);
                const script = parents.at(-1);
                const next = executionBlock(blocks, focus, parents);
                const entry = script && records(blocks[script]).opcode;
                if (!script || !next || typeof entry !== 'string' ||
                    !/^(event_when|control_start_as_clone)/.test(entry)) return;
                return {id: item.id + ':' + index, target: target.name, script, next, focus, input};
            });
            if (points.length && points.every(point => point !== undefined)) {
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
    return {
        get paused() {return stopped !== undefined;},
        get stopped() {return stopped;},
        before(thread: ExecutionThread, block: string) {
            const conflict = conflicts.find(item => item.next === block && item.script === thread.topBlock &&
                item.target === thread.target.getName() && !adopted.has(item.id));
            if (!conflict) return true;
            stopped = {...conflict, previous: previous.get(thread)};
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
    const base = blocksOf(target);
    const next = blocksOf(changed);
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
