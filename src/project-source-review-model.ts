import {compareProjectBlocks, equal, isRecord, targetKey} from './project-source-patch.js';
import type {BlockChange, BlockSide, ProjectSource, ProjectTarget} from './project-source-patch.js';
import type {ScriptBlockMark} from './scratch-block-diff-renderer.js';

export interface ScriptReviewSide extends BlockSide { marks: ScriptBlockMark[] }
/**
 * What happened to one script. `moved` means only positions changed, `reordered` only how blocks connect;
 * neither changes what the script does.
 */
export type ScriptChangeKind = 'added' | 'removed' | 'updated' | 'reorganized' | 'moved' | 'reordered';
/** One phrase of a script's summary, in the order shown. The view words it in the reader's language. */
export type ScriptSummaryItem =
    | {kind: 'hatReplaced'; before: string; after: string}  // hat block opcodes
    | {kind: 'wrapped'; opcode: string}                     // a new C block now holds blocks that existed before
    | {kind: 'branchAdded'; opcode: string}                 // control_if or control_if_else added
    | {kind: 'valueChanged'; opcode: string; name: string}  // an input or field of an existing block, by its name
    | {kind: 'blocksAdded'; count: number}
    | {kind: 'blocksRemoved'; count: number}
    | {kind: 'reordered'}
    | {kind: 'moved'};
export interface ScriptReview {
    id: string;
    before: ScriptReviewSide[];
    after: ScriptReviewSide[];
    kind: ScriptChangeKind;
    summary: ScriptSummaryItem[];
}
export interface TargetReview {
    name: string;
    isStage: boolean;
    /** Added or removed as a whole, or changed. Added and removed targets list no properties. */
    status: 'added' | 'removed' | 'updated';
    /** The stage or sprite in each version, absent where it does not exist. */
    before?: ProjectTarget;
    after?: ProjectTarget;
    scripts: ScriptReview[];
    properties: string[];
}

function scriptRoots(target?: ProjectTarget) {
    const roots = new Map<string, string>();
    if (!target) return roots;
    for (const id of Object.keys(target.blocks)) {
        if (roots.has(id)) continue;
        const chain = new Set<string>();
        let current = id;
        while (!roots.has(current) && !chain.has(current)) {
            chain.add(current);
            const block = target.blocks[current];
            if (!isRecord(block) || typeof block.parent !== 'string' || !Object.hasOwn(target.blocks, block.parent)) break;
            current = block.parent;
        }
        const root = roots.get(current) ?? current;
        for (const block of chain) roots.set(block, root);
    }
    return roots;
}

function groupScripts(before: ProjectTarget | undefined, after: ProjectTarget | undefined, changes: readonly BlockChange[]) {
    const roots = {before: scriptRoots(before), after: scriptRoots(after)};
    const parents = new Map<string, string>();
    function groupOf(key: string) {
        let parent = key;
        while (parents.has(parent)) parent = parents.get(parent)!;
        for (let current = key; current !== parent;) {
            const next = parents.get(current)!;
            parents.set(current, parent);
            current = next;
        }
        return parent;
    }

    // Blocks retained across versions connect their original and new scripts, including splits and merges.
    for (const [id, oldRoot] of roots.before) {
        const newRoot = roots.after.get(id);
        if (newRoot === undefined) continue;
        const a = groupOf('before:' + oldRoot), b = groupOf('after:' + newRoot);
        if (a !== b) parents.set(b, a);
    }
    const groups = new Map<string, ScriptReview>();
    const sides = new Map<string, ScriptReviewSide>();
    for (const version of ['before', 'after'] as const) {
        const target = version === 'before' ? before : after;
        if (!target) continue;
        for (const root of new Set(roots[version].values())) {
            const key = version + ':' + root;
            const id = groupOf(key);
            const group = groups.get(id) ?? {id, before: [], after: [], kind: 'updated' as ScriptChangeKind, summary: [] as ScriptSummaryItem[]};
            const side: ScriptReviewSide = {target, id: root, marks: []};
            group[version].push(side);
            groups.set(id, group);
            sides.set(key, side);
        }
    }
    const affected = new Map<string, BlockChange[]>();
    for (const change of changes) {
        for (const version of ['before', 'after'] as const) {
            const block = change[version];
            if (!block) continue;
            const key = version + ':' + roots[version].get(block.id);
            // Only content changes are marked; a block that was merely reconnected or moved looks the same.
            if (!isLayoutOnly(change)) sides.get(key)?.marks.push({id: block.id, kind: change.kind, parts: change.parts});
            const id = groupOf(key);
            const list = affected.get(id) ?? [];
            if (!list.includes(change)) list.push(change);
            affected.set(id, list);
        }
    }
    return [...affected].map(([id, list]) => {
        const group = groups.get(id)!;
        group.kind = scriptKind(group, list);
        group.summary = summarize(group, list, before, after);
        return group;
    });
}

const connectionFields = new Set(['next', 'parent', 'topLevel']);
const positionFields = new Set(['x', 'y']);
// Compact top-level reporters are arrays: [type, name, id, x, y].
const compactPositionOnly = (a: unknown, b: unknown) =>
    Array.isArray(a) && Array.isArray(b) && equal(a.slice(0, 3), b.slice(0, 3)) && !equal(a, b);

function blockOf(side: BlockSide | undefined) {
    return side ? side.target.blocks[side.id] : undefined;
}

/** True for an updated block whose content is the same: only its connections or its position changed. */
function isLayoutOnly(change: BlockChange) {
    if (change.kind !== 'updated') return false;
    if (compactPositionOnly(blockOf(change.before), blockOf(change.after))) return true;
    return change.fields.length > 0 && change.fields.every(field => connectionFields.has(field) || positionFields.has(field));
}

function isPositionOnly(change: BlockChange) {
    if (change.kind !== 'updated') return false;
    if (compactPositionOnly(blockOf(change.before), blockOf(change.after))) return true;
    return change.fields.length > 0 && change.fields.every(field => positionFields.has(field));
}

function scriptKind(group: ScriptReview, changes: readonly BlockChange[]): ScriptChangeKind {
    if (!group.before.length) return 'added';
    if (!group.after.length) return 'removed';
    if (group.before.length !== 1 || group.after.length !== 1) return 'reorganized';
    if (changes.every(isPositionOnly)) return 'moved';
    if (changes.every(isLayoutOnly)) return 'reordered';
    return 'updated';
}

const opcodeOf = (block: unknown) => isRecord(block) && typeof block.opcode === 'string' ? block.opcode : undefined;
const isShadow = (block: unknown) => !isRecord(block) || block.shadow === true;
const isHat = (opcode: string | undefined) => opcode !== undefined &&
    (opcode === 'control_start_as_clone' || opcode === 'procedures_definition' || /^[a-z0-9]+_when/i.test(opcode));
const substackInputs = ['SUBSTACK', 'SUBSTACK2'];

function inputBlock(block: unknown, name: string) {
    if (!isRecord(block) || !isRecord(block.inputs)) return undefined;
    const input = block.inputs[name];
    return Array.isArray(input) && typeof input[1] === 'string' ? input[1] : undefined;
}

function summarize(group: ScriptReview, changes: readonly BlockChange[], before?: ProjectTarget, after?: ProjectTarget) {
    const items: ScriptSummaryItem[] = [];
    const seen = new Set<string>();
    const add = (item: ScriptSummaryItem) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) return;
        seen.add(key);
        items.push(item);
    };
    if (group.kind === 'moved' || group.kind === 'reordered') {
        add({kind: group.kind});
        return items;
    }
    const explained = new Set<BlockChange>();
    if (group.before.length === 1 && group.after.length === 1) {
        const oldRoot = group.before[0].id, newRoot = group.after[0].id;
        const a = opcodeOf(before?.blocks[oldRoot]), b = opcodeOf(after?.blocks[newRoot]);
        if (a !== b && isHat(a) && isHat(b)) {
            add({kind: 'hatReplaced', before: a!, after: b!});
            // The new hat and the one it replaced are the replacement, not separate additions and removals.
            for (const change of changes) {
                if ((change.kind === 'added' && change.after?.id === newRoot) || (change.kind === 'removed' && change.before?.id === oldRoot)) {
                    explained.add(change);
                }
            }
        }
    }
    const branches: BlockChange[] = [];
    for (const change of changes) {
        if (change.kind !== 'added' || !after) continue;
        const block = after.blocks[change.after!.id];
        const opcode = opcodeOf(block);
        if (!opcode) continue;
        const wraps = substackInputs.some(name => {
            const visited = new Set<string>();
            for (let id = inputBlock(block, name); id !== undefined && !visited.has(id);) {
                visited.add(id);
                if (before && Object.hasOwn(before.blocks, id)) return true;
                const next = after.blocks[id];
                id = isRecord(next) && typeof next.next === 'string' ? next.next : undefined;
            }
            return false;
        });
        if (wraps) {
            add({kind: 'wrapped', opcode});
            explained.add(change);
        } else if (opcode === 'control_if' || opcode === 'control_if_else') {
            branches.push(change);
        }
    }
    for (const change of branches) {
        add({kind: 'branchAdded', opcode: opcodeOf(after!.blocks[change.after!.id])!});
        explained.add(change);
    }
    for (const change of changes) {
        if (change.kind !== 'updated') continue;
        const opcode = opcodeOf(blockOf(change.after)) ?? opcodeOf(blockOf(change.before));
        if (!opcode) continue;
        for (const part of change.parts) {
            // A C block's slot holds blocks; what changed there is reported as additions, removals or wrapping.
            if (part.kind === 'input' && substackInputs.includes(part.name)) continue;
            add({kind: 'valueChanged', opcode, name: part.name});
        }
    }
    const count = (kind: 'added' | 'removed') => changes.filter(change => change.kind === kind && !explained.has(change) &&
        !isShadow(blockOf(kind === 'added' ? change.after : change.before))).length;
    const added = count('added'), removed = count('removed');
    if (added) add({kind: 'blocksAdded', count: added});
    if (removed) add({kind: 'blocksRemoved', count: removed});
    return items;
}

function changedProperties(before: Record<string, unknown>, after: Record<string, unknown>, except: string) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => key !== except && !equal(before[key], after[key]));
}

export function compareProjectForReview(before: ProjectSource, after: ProjectSource) {
    const {changes} = compareProjectBlocks(before, after);
    const byTarget = new Map<string, BlockChange[]>();
    for (const change of changes) {
        const key = targetKey((change.after ?? change.before)!.target);
        const existing = byTarget.get(key);
        if (existing) existing.push(change);
        else byTarget.set(key, [change]);
    }
    const oldTargets = new Map(before.targets.map(target => [targetKey(target), target]));
    const newTargets = new Map(after.targets.map(target => [targetKey(target), target]));
    const targets: TargetReview[] = [];
    for (const key of new Set([...oldTargets.keys(), ...newTargets.keys()])) {
        const a = oldTargets.get(key), b = newTargets.get(key);
        const edits = byTarget.get(key);
        const scripts = edits ? groupScripts(a, b, edits) : [];
        const status = !a ? 'added' : !b ? 'removed' : 'updated';
        // An added or removed target is shown as a whole; listing every key it has would say nothing more.
        const properties = status === 'updated' ? changedProperties({...a}, {...b}, 'blocks') : [];
        if (scripts.length || properties.length || status !== 'updated') {
            const {name, isStage} = (b ?? a)!;
            targets.push({name, isStage, status, scripts, properties, before: a, after: b});
        }
    }
    return {targets, properties: changedProperties(before, after, 'targets')};
}
