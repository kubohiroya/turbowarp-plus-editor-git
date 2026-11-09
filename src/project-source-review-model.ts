import {compareProjectBlocks, equal, isRecord, targetKey} from './project-source-patch.js';
import type {BlockChange, BlockSide, ProjectSource, ProjectTarget} from './project-source-patch.js';
import type {ScriptBlockMark} from './scratch-block-diff-renderer.js';

export interface ScriptReviewSide extends BlockSide { marks: ScriptBlockMark[] }
export interface ScriptReview {
    id: string;
    before: ScriptReviewSide[];
    after: ScriptReviewSide[];
}
export interface TargetReview {
    name: string;
    isStage: boolean;
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
            const group = groups.get(id) ?? {id, before: [], after: []};
            const side: ScriptReviewSide = {target, id: root, marks: []};
            group[version].push(side);
            groups.set(id, group);
            sides.set(key, side);
        }
    }
    const affected = new Set<string>();
    for (const change of changes) {
        for (const version of ['before', 'after'] as const) {
            const block = change[version];
            if (!block) continue;
            const key = version + ':' + roots[version].get(block.id);
            sides.get(key)?.marks.push({id: block.id, kind: change.kind, parts: change.parts});
            affected.add(groupOf(key));
        }
    }
    return [...affected].map(id => groups.get(id)!);
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
        const properties = changedProperties({...a}, {...b}, 'blocks');
        if (scripts.length || properties.length) {
            const {name, isStage} = (b ?? a)!;
            targets.push({name, isStage, scripts, properties, before: a, after: b});
        }
    }
    return {targets, properties: changedProperties(before, after, 'targets')};
}
