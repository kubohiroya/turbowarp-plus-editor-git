import {equal, isRecord} from './project-source-patch.js';
import {mergeJson, orderKeys, readJsonPath, writeJsonPath, type JsonMergeOptions, type JsonPath} from './merge-json.js';

/** A Scratch target as it appears in `project.source.json`. */
export type SourceTarget = Record<string, unknown> & {name: string; isStage: boolean};
export type SourceProject = Record<string, unknown> & {targets: SourceTarget[]};
type Blocks = Record<string, unknown>;

export type MergeSide = 'base' | 'current' | 'incoming';

/** Where a conflict sits in the merged project. Targets are named as they are in the merged project. */
export type ProjectConflictLocation =
    /** A project property (`target` is `null`) or a target property; keyed lists step by `id` or `name`. */
    | {type: 'property'; target: string | null; path: JsonPath}
    /** The scripts made of these blocks. The values are the blocks of those scripts on each side, by ID. */
    | {type: 'scripts'; target: string; blockIds: string[]}
    /** A whole sprite (one side removed it and the other changed it, or both added it differently). */
    | {type: 'target'; target: string};

export type ProjectConflictKind =
    /** Both sides changed the same value differently. */
    | 'value'
    /** One side removed what the other side changed. */
    | 'removed-changed'
    /** Both sides changed the same scripts in ways that cannot be combined block by block. */
    | 'scripts'
    /** One side removed a variable or list that the merged scripts still use; the merge keeps it. */
    | 'reference';

export interface ProjectConflict {
    /** Stable within one merge; use it to record choices. */
    id: string;
    kind: ProjectConflictKind;
    location: ProjectConflictLocation;
    /** The value on each side. `undefined` means the side does not have it. */
    base: unknown;
    current: unknown;
    incoming: unknown;
}

/** A broken reference or structure in a project. A project with problems should not be committed. */
export interface ProjectProblem {
    target: string;
    kind: 'missing-variable' | 'missing-list' | 'missing-block' | 'broken-link' | 'missing-comment-block' | 'costume-index';
    blockId?: string;
    id?: string;
}

export interface ProjectMergeResult {
    /**
     * The merged project to start editing from: changes made by only one side, or by both sides in the same way,
     * are in; each conflict keeps the base version.
     */
    project: SourceProject;
    conflicts: ProjectConflict[];
    /** Problems left in `project` (conflicts that keep the base are resolved enough to avoid them). */
    problems: ProjectProblem[];
}

const targetJsonOptions: JsonMergeOptions = {
    arrayKey: path => path[0] === 'costumes' || path[0] === 'sounds' ? nameKey : undefined,
    // Variables are [name, value, isCloud?] and lists [name, items]: a rename and a new value merge separately.
    tuple: path => (path[0] === 'variables' || path[0] === 'lists') && path.length === 2
};

const projectJsonOptions: JsonMergeOptions = {
    arrayKey: path => path.length === 1 && path[0] === 'monitors' ? idKey : undefined
};

function nameKey(item: unknown) {
    return isRecord(item) && typeof item.name === 'string' ? item.name : undefined;
}

function idKey(item: unknown) {
    return isRecord(item) && typeof item.id === 'string' ? item.id : undefined;
}

const clone = <T>(value: T): T => value === undefined ? value : structuredClone(value);

/**
 * Three-way merge of `project.source.json`. Targets pair up by name (the stage by `isStage`); a sprite renamed on one
 * side pairs with its base by shared block IDs. Inside a target, scripts merge as units: a script that only one side
 * changed takes that side, and one that both sides changed merges block by block (inputs and fields separately) when
 * the result is a consistent script, and is a conflict otherwise. Variables, lists, broadcasts and comments merge by
 * ID, costumes and sounds by name, and other properties key by key.
 */
export function mergeProjectSource(base: SourceProject | null, current: SourceProject | null,
    incoming: SourceProject | null): ProjectMergeResult {
    const b = base ?? {targets: []}, c = current ?? {targets: []}, i = incoming ?? {targets: []};
    const conflicts: ProjectConflict[] = [];

    const {targets: _b, ...baseRest} = b;
    const {targets: _c, ...currentRest} = c;
    const {targets: _i, ...incomingRest} = i;
    const rest = mergeJson(baseRest, currentRest, incomingRest, projectJsonOptions);
    for (const conflict of rest.conflicts) {
        conflicts.push(conflictOf({type: 'property', target: null, path: conflict.path}, conflict));
    }

    const targets: SourceTarget[] = [];
    for (const triple of pairTargets(b.targets, c.targets, i.targets)) {
        const merged = mergeTarget(triple, conflicts);
        if (merged) targets.push(merged);
    }
    normalizeLayerOrder(targets);
    const properties = {...(rest.value as Record<string, unknown>), targets};
    const project = {} as SourceProject;
    for (const key of orderKeys(Object.keys(b), Object.keys(c), Object.keys(i))) {
        if (Object.hasOwn(properties, key)) (project as Record<string, unknown>)[key] = properties[key as keyof typeof properties];
    }
    restoreUsedVariables(project, b, c, i, conflicts);
    return {project, conflicts, problems: checkProject(project)};
}

interface TargetTriple { base?: SourceTarget; current?: SourceTarget; incoming?: SourceTarget }

function blockIds(target: SourceTarget | undefined) {
    return new Set(isRecord(target?.blocks) ? Object.keys(target.blocks) : []);
}

/** Pairs the targets of the three sides, in the current side's order with incoming additions after their predecessor. */
function pairTargets(base: SourceTarget[], current: SourceTarget[], incoming: SourceTarget[]): TargetTriple[] {
    const keyOf = (target: SourceTarget) => target.isStage ? '\u0000stage' : target.name;
    const baseKeys = new Map(base.map(target => [keyOf(target), target]));
    // A side's key for each target: its base key when it is a renamed base sprite.
    const sideKeys = (side: SourceTarget[]) => {
        const keys = new Map<SourceTarget, string>();
        const unmatched = new Set(base.filter(target => !side.some(other => keyOf(other) === keyOf(target))));
        for (const target of side) {
            if (baseKeys.has(keyOf(target))) {
                keys.set(target, keyOf(target));
                continue;
            }
            let best: SourceTarget | undefined, bestShare = 0;
            const ids = blockIds(target);
            for (const candidate of unmatched) {
                const candidateIds = blockIds(candidate);
                if (!ids.size || !candidateIds.size) continue;
                const shared = [...ids].filter(id => candidateIds.has(id)).length;
                const share = shared / Math.max(ids.size, candidateIds.size);
                if (share > bestShare) [best, bestShare] = [candidate, share];
            }
            if (best && bestShare >= 0.5) {
                unmatched.delete(best);
                keys.set(target, keyOf(best));
            } else {
                keys.set(target, keyOf(target));
            }
        }
        return keys;
    };
    const currentKeys = sideKeys(current), incomingKeys = sideKeys(incoming);
    const byKey = new Map<string, TargetTriple>();
    const entry = (key: string) => byKey.get(key) ?? byKey.set(key, {}).get(key)!;
    for (const target of base) entry(keyOf(target)).base = target;
    for (const target of current) entry(currentKeys.get(target)!).current = target;
    for (const target of incoming) {
        const key = incomingKeys.get(target)!;
        const triple = entry(key);
        // Two different sprites that happen to share a new name.
        if (triple.incoming) entry(key + '\u0000incoming').incoming = target;
        else triple.incoming = target;
    }
    const order = orderKeys(base.map(keyOf), current.map(target => currentKeys.get(target)!),
        incoming.map(target => incomingKeys.get(target)!));
    for (const key of byKey.keys()) if (!order.includes(key)) order.push(key);
    return order.map(key => byKey.get(key)!);
}

function mergeTarget({base, current, incoming}: TargetTriple, conflicts: ProjectConflict[]): SourceTarget | undefined {
    if (equal(current, incoming)) return clone(current);
    if (equal(base, current)) return clone(incoming);
    if (equal(base, incoming)) return clone(current);
    if (!current || !incoming) {
        const kept = (current ?? incoming)!;
        conflicts.push({id: `target:${(base ?? kept).name}`, kind: base ? 'removed-changed' : 'value',
            location: {type: 'target', target: (base ?? kept).name}, base: clone(base), current: clone(current),
            incoming: clone(incoming)});
        return clone(base);
    }
    const b = base ?? ({} as SourceTarget);
    const local: ProjectConflict[] = [];
    // The name is a property: the merged target is named as the merge of the names.
    const {blocks: bBlocks, currentCostume: _b, ...bRest} = pickTarget(b);
    const {blocks: cBlocks, currentCostume: _c, ...cRest} = pickTarget(current);
    const {blocks: iBlocks, currentCostume: _i, ...iRest} = pickTarget(incoming);
    const properties = mergeJson(bRest, cRest, iRest, targetJsonOptions);
    const merged = properties.value as SourceTarget;
    const name = merged.name ?? b.name;
    for (const conflict of properties.conflicts) {
        local.push(conflictOf({type: 'property', target: name, path: conflict.path}, conflict));
    }
    merged.blocks = mergeBlocks(bBlocks, cBlocks, iBlocks, name, local);
    mergeCurrentCostume(merged, b, current, incoming, name, local);
    // Keep the merged target's keys in the current side's order.
    const ordered = {} as SourceTarget;
    for (const key of orderKeys(Object.keys(b), Object.keys(current), Object.keys(incoming))) {
        if (Object.hasOwn(merged, key)) (ordered as Record<string, unknown>)[key] = (merged as Record<string, unknown>)[key];
    }
    for (const conflict of local) conflicts.push(conflict);
    return ordered;
}

function pickTarget(target: SourceTarget) {
    return {...clone(target), blocks: isRecord(target.blocks) ? target.blocks : {}} as SourceTarget & {blocks: Blocks};
}

function conflictOf(location: ProjectConflictLocation, values: {base: unknown; current: unknown; incoming: unknown}):
    ProjectConflict {
    const kind: ProjectConflictKind = values.current === undefined || values.incoming === undefined ?
        (values.base === undefined ? 'value' : 'removed-changed') : 'value';
    return {id: conflictId(location), kind, location, base: clone(values.base), current: clone(values.current),
        incoming: clone(values.incoming)};
}

function conflictId(location: ProjectConflictLocation): string {
    switch (location.type) {
    case 'property': return `property:${location.target ?? ''}:${JSON.stringify(location.path)}`;
    case 'scripts': return `scripts:${location.target}:${location.blockIds[0]}`;
    case 'target': return `target:${location.target}`;
    }
}

/** The costume shown merges by name, so that costume changes on the other side do not shift it. */
function mergeCurrentCostume(merged: SourceTarget, base: SourceTarget, current: SourceTarget, incoming: SourceTarget,
    target: string, conflicts: ProjectConflict[]) {
    const nameAt = (side: SourceTarget) => {
        const costumes = Array.isArray(side.costumes) ? side.costumes : [];
        return typeof side.currentCostume === 'number' ? nameKey(costumes[side.currentCostume]) : undefined;
    };
    const result = mergeJson(nameAt(base), nameAt(current), nameAt(incoming));
    const costumes = Array.isArray(merged.costumes) ? merged.costumes : [];
    let index = costumes.findIndex(costume => nameKey(costume) === result.value);
    if (result.conflicts.length) {
        // The values are costume names: an index on one side names a different costume on another.
        conflicts.push({id: `property:${target}:["currentCostume"]`, kind: 'value',
            location: {type: 'property', target, path: ['currentCostume']},
            base: nameAt(base), current: nameAt(current), incoming: nameAt(incoming)});
    }
    if (index < 0) index = typeof current.currentCostume === 'number' ? Math.min(current.currentCostume, costumes.length - 1) : 0;
    if (base.currentCostume !== undefined || current.currentCostume !== undefined || incoming.currentCostume !== undefined) {
        merged.currentCostume = Math.max(index, 0);
    }
}

/** The ID of the script each block belongs to: its top-level ancestor. */
function rootOf(blocks: Blocks, id: string): string {
    const seen = new Set<string>();
    let at = id;
    for (;;) {
        const block = blocks[at];
        const parent = isRecord(block) && typeof block.parent === 'string' ? block.parent : null;
        if (!parent || !(parent in blocks) || seen.has(parent)) return at;
        seen.add(at);
        at = parent;
    }
}

/** Groups block IDs into units that must merge together: blocks in the same script on any side. */
function scriptGroups(sides: Blocks[]): string[][] {
    const parent = new Map<string, string>();
    const find = (id: string): string => {
        let root = id;
        while (parent.get(root) !== root) root = parent.get(root)!;
        parent.set(id, root);
        return root;
    };
    const union = (a: string, b: string) => {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    };
    for (const blocks of sides) for (const id of Object.keys(blocks)) if (!parent.has(id)) parent.set(id, id);
    for (const blocks of sides) for (const id of Object.keys(blocks)) union(id, rootOf(blocks, id));
    const groups = new Map<string, string[]>();
    for (const blocks of sides) {
        for (const id of Object.keys(blocks)) {
            const group = groups.get(find(id)) ?? groups.set(find(id), []).get(find(id))!;
            if (!group.includes(id)) group.push(id);
        }
    }
    return [...groups.values()];
}

function pick(blocks: Blocks, ids: readonly string[]): Blocks {
    const result: Blocks = {};
    for (const id of ids) if (Object.hasOwn(blocks, id)) result[id] = blocks[id];
    return result;
}

function mergeBlocks(base: Blocks, current: Blocks, incoming: Blocks, target: string, conflicts: ProjectConflict[]): Blocks {
    const merged: Blocks = {};
    for (const ids of scriptGroups([current, incoming, base])) {
        const [b, c, i] = [pick(base, ids), pick(current, ids), pick(incoming, ids)];
        let result: Blocks | undefined;
        if (equal(c, i) || equal(b, i)) result = c;
        else if (equal(b, c)) result = i;
        else {
            const byBlock = mergeJson(b, c, i);
            if (!byBlock.conflicts.length && !checkBlocks(byBlock.value as Blocks, () => undefined).length) {
                result = byBlock.value as Blocks;
            }
        }
        if (!result) {
            const location = {type: 'scripts' as const, target, blockIds: [...ids].sort()};
            conflicts.push({id: conflictId(location), kind: 'scripts', location, base: clone(b), current: clone(c),
                incoming: clone(i)});
            result = b;
        }
        Object.assign(merged, clone(result));
    }
    // Keep block order stable: the current side's order, then the rest.
    const ordered: Blocks = {};
    for (const id of orderKeys(Object.keys(base), Object.keys(current), Object.keys(incoming))) {
        if (Object.hasOwn(merged, id)) ordered[id] = merged[id];
    }
    return ordered;
}

/** Keeps every renumbered sprite layer distinct, in the merged order. */
function normalizeLayerOrder(targets: SourceTarget[]) {
    const layers = targets.map(target => target.layerOrder);
    if (!layers.every(layer => typeof layer === 'number') || new Set(layers).size === layers.length) return;
    [...targets].map((target, index) => ({target, index}))
        .sort((a, b) => (a.target.layerOrder as number) - (b.target.layerOrder as number) || a.index - b.index)
        .forEach(({target}, layer) => { target.layerOrder = layer; });
}

/** IDs of the variables and lists that the blocks refer to. */
function usedVariables(blocks: Blocks) {
    const variables = new Map<string, string>(), lists = new Map<string, string>();
    const primitive = (value: unknown) => {
        if (!Array.isArray(value) || typeof value[2] !== 'string') return;
        if (value[0] === 12) variables.set(value[2], String(value[1]));
        if (value[0] === 13) lists.set(value[2], String(value[1]));
    };
    for (const block of Object.values(blocks)) {
        if (Array.isArray(block)) primitive(block);
        if (!isRecord(block)) continue;
        if (isRecord(block.inputs)) for (const input of Object.values(block.inputs)) {
            if (Array.isArray(input)) input.slice(1).forEach(primitive);
        }
        if (isRecord(block.fields)) {
            const field = (name: string, into: Map<string, string>) => {
                const value = (block.fields as Record<string, unknown>)[name];
                if (Array.isArray(value) && typeof value[1] === 'string') into.set(value[1], String(value[0]));
            };
            field('VARIABLE', variables);
            field('LIST', lists);
        }
    }
    return {variables, lists};
}

/**
 * A variable or list that one side removed but the merged scripts still use is put back from the base (or the side
 * that kept it), and reported as a `reference` conflict.
 */
function restoreUsedVariables(project: SourceProject, base: SourceProject, current: SourceProject, incoming: SourceProject,
    conflicts: ProjectConflict[]) {
    const stage = project.targets.find(target => target.isStage);
    const sideTarget = (side: SourceProject, name: string, isStage: boolean) =>
        side.targets.find(target => isStage ? target.isStage : !target.isStage && target.name === name);
    for (const target of project.targets) {
        const used = usedVariables(isRecord(target.blocks) ? target.blocks : {});
        for (const section of ['variables', 'lists'] as const) {
            for (const id of (section === 'variables' ? used.variables : used.lists).keys()) {
                const has = (owner: SourceTarget | undefined) => isRecord(owner?.[section]) &&
                    Object.hasOwn(owner[section] as object, id);
                if (has(target) || has(stage)) continue;
                // The owner is the stage when the stage has it on some side, else this target.
                for (const owner of [stage, target]) {
                    if (!owner) continue;
                    const values = [base, current, incoming].map(side =>
                        readJsonPath(sideTarget(side, owner.name, owner.isStage), [section, id]));
                    const restored = values.find(value => value !== undefined);
                    if (restored === undefined) continue;
                    if (!isRecord(owner[section])) owner[section] = {};
                    (owner[section] as Record<string, unknown>)[id] = clone(restored);
                    const location = {type: 'property' as const, target: owner.name, path: [section, id]};
                    conflicts.push({id: conflictId(location), kind: 'reference', location, base: clone(values[0]),
                        current: clone(values[1]), incoming: clone(values[2])});
                    break;
                }
            }
        }
    }
}

/** Finds broken block links within `blocks`. `outside` says whether an ID that is not in `blocks` exists elsewhere. */
function checkBlocks(blocks: Blocks, outside: (id: string) => unknown): Array<{kind: ProjectProblem['kind']; blockId: string}> {
    const problems: Array<{kind: ProjectProblem['kind']; blockId: string}> = [];
    const get = (id: string) => Object.hasOwn(blocks, id) ? blocks[id] : outside(id);
    const refersTo = (parent: Record<string, unknown>, id: string) => parent.next === id ||
        (isRecord(parent.inputs) && Object.values(parent.inputs).some(input =>
            Array.isArray(input) && input.slice(1).includes(id)));
    for (const [id, block] of Object.entries(blocks)) {
        if (!isRecord(block)) continue;
        if (typeof block.next === 'string') {
            const next = get(block.next);
            if (!isRecord(next)) problems.push({kind: 'missing-block', blockId: id});
            else if (next.parent !== id) problems.push({kind: 'broken-link', blockId: id});
        }
        if (typeof block.parent === 'string') {
            const parent = get(block.parent);
            if (!isRecord(parent)) problems.push({kind: 'missing-block', blockId: id});
            else if (!refersTo(parent, id)) problems.push({kind: 'broken-link', blockId: id});
        }
        if (isRecord(block.inputs)) for (const input of Object.values(block.inputs)) {
            if (!Array.isArray(input)) continue;
            for (const value of input.slice(1)) {
                if (typeof value !== 'string') continue;
                const child = get(value);
                if (!isRecord(child)) problems.push({kind: 'missing-block', blockId: id});
                else if (child.parent !== id) problems.push({kind: 'broken-link', blockId: id});
            }
        }
    }
    return problems;
}

/**
 * Checks that every block link, variable and list reference, block comment and costume index in the project
 * resolves. An empty list means the project can be loaded as merged.
 */
export function checkProject(project: SourceProject): ProjectProblem[] {
    const problems: ProjectProblem[] = [];
    const stage = project.targets.find(target => target.isStage);
    for (const target of project.targets) {
        const blocks = isRecord(target.blocks) ? target.blocks : {};
        for (const problem of checkBlocks(blocks, () => undefined)) problems.push({target: target.name, ...problem});
        const used = usedVariables(blocks);
        for (const [section, ids, kind] of [['variables', used.variables, 'missing-variable'], ['lists', used.lists,
            'missing-list']] as const) {
            for (const id of ids.keys()) {
                const has = (owner: SourceTarget | undefined) => isRecord(owner?.[section]) &&
                    Object.hasOwn(owner[section] as object, id);
                if (!has(target) && !has(stage)) problems.push({target: target.name, kind, id});
            }
        }
        if (isRecord(target.comments)) for (const [id, comment] of Object.entries(target.comments)) {
            if (isRecord(comment) && typeof comment.blockId === 'string' && !Object.hasOwn(blocks, comment.blockId)) {
                problems.push({target: target.name, kind: 'missing-comment-block', id});
            }
        }
        const costumes = Array.isArray(target.costumes) ? target.costumes : [];
        if (typeof target.currentCostume === 'number' &&
            (target.currentCostume < 0 || target.currentCostume >= Math.max(costumes.length, 1))) {
            problems.push({target: target.name, kind: 'costume-index'});
        }
    }
    return problems;
}

/** The project after taking the given side for each chosen conflict; unchosen conflicts keep the base. */
export function resolveProjectSource(result: ProjectMergeResult, choices: Readonly<Record<string, MergeSide>>):
    {project: SourceProject; problems: ProjectProblem[]} {
    const project = clone(result.project);
    // Renames last, so other conflicts still find their targets by the merged name.
    const ordered = [...result.conflicts].sort((a, b) => Number(isRename(a)) - Number(isRename(b)));
    for (const conflict of ordered) {
        const side = choices[conflict.id];
        if (side && side !== 'base') applyConflict(project, conflict, side);
    }
    normalizeLayerOrder(project.targets);
    return {project, problems: checkProject(project)};
}

const isRename = (conflict: ProjectConflict) => conflict.location.type === 'property' &&
    conflict.location.path.length === 1 && conflict.location.path[0] === 'name';

function findTarget(project: SourceProject, name: string) {
    return project.targets.findIndex(target => target.name === name);
}

/** Replaces the conflict's place in `project` with the value of `side`. */
export function applyConflict(project: SourceProject, conflict: ProjectConflict, side: MergeSide): void {
    const value = clone(conflict[side]);
    const location = conflict.location;
    if (location.type === 'target') {
        const index = findTarget(project, location.target);
        if (index >= 0) {
            if (value === undefined) project.targets.splice(index, 1);
            else project.targets[index] = value as SourceTarget;
        } else if (value !== undefined) {
            project.targets.push(value as SourceTarget);
        }
        return;
    }
    if (location.type === 'property' && location.target === null) {
        writeJsonPath(project, location.path, value, idKey);
        return;
    }
    const target = project.targets[findTarget(project, location.target as string)];
    if (!target) throw new Error(`The merged project has no target named ${location.target}.`);
    if (location.type === 'scripts') {
        const blocks = (isRecord(target.blocks) ? target.blocks : (target.blocks = {})) as Blocks;
        for (const id of location.blockIds) delete blocks[id];
        Object.assign(blocks, value as Blocks);
        return;
    }
    if (location.path.length === 1 && location.path[0] === 'currentCostume') {
        // The values are costume names (see `mergeCurrentCostume`).
        const costumes = Array.isArray(target.costumes) ? target.costumes : [];
        const index = costumes.findIndex(costume => nameKey(costume) === value);
        if (index >= 0) target.currentCostume = index;
        return;
    }
    writeJsonPath(target, location.path, value, nameKey);
}

/** Formats a project as `project.source.json` is written: two-space indented JSON and a final newline. */
export function formatProjectSource(project: unknown): string {
    return `${JSON.stringify(project, null, 2)}\n`;
}

/** Reads `project.source.json` text (`null` when the file is absent). */
export function parseSourceProject(text: string | null): SourceProject | null {
    if (text === null) return null;
    const project: unknown = JSON.parse(text);
    if (!isRecord(project) || !Array.isArray(project.targets) || !project.targets.every(target =>
        isRecord(target) && typeof target.name === 'string' && typeof target.isStage === 'boolean')) {
        throw new Error('Expected a project.source.json with Scratch targets.');
    }
    return project as SourceProject;
}
