import {isRecord} from './project-source-patch.js';
import type {BlockPart, BlockSide} from './project-source-patch.js';

export interface DiffSvgBlock {
    type?: string;
    getSvgRoot(): Element | null;
    getInputTargetBlock?(name: string): DiffSvgBlock | null;
    getField?(name: string): {getSvgRoot(): Element | null} | null;
}

export type ProjectBlockLocation = BlockSide & {
    version: 'before' | 'after';
    parts: readonly BlockPart[];
    signal: AbortSignal;
};
export type ProjectBlockLocator = (location: ProjectBlockLocation) => boolean | Promise<boolean>;

export interface ScratchBlockLocationWorkspace {
    getBlockById(id: string): DiffSvgBlock | null;
    centerOnBlock(id: string): void;
}

export function markBlockLocation(block: DiffSvgBlock, parts: readonly BlockPart[]) {
    const root = block.getSvgRoot();
    if (!root) return;
    root.classList.add('twgit-changed-block');
    const marked = new Set<Element>();
    for (const {kind, name} of parts) {
        const part = kind === 'input' ? block.getInputTargetBlock?.(name) : block.getField?.(name);
        const element = part?.getSvgRoot();
        if (!element || element === root || marked.has(element)) continue;
        element.classList.add('twgit-changed-block-part');
        marked.add(element);
    }
    return {
        targets: marked.size ? [...marked] : [root],
        clear() {
            root.classList.remove('twgit-changed-block');
            for (const element of marked) element.classList.remove('twgit-changed-block-part');
        }
    };
}

/** Resolve the matching project revision and target in the host before navigating its workspace. */
export function createScratchBlocksDiffLocator(
    resolveWorkspace: (location: ProjectBlockLocation) => ScratchBlockLocationWorkspace | null | Promise<ScratchBlockLocationWorkspace | null>
): ProjectBlockLocator {
    return async location => {
        const workspace = await resolveWorkspace(location);
        if (!workspace || location.signal.aborted) return false;
        const block = workspace.getBlockById(location.id);
        const expected = location.target.blocks[location.id];
        if (!block || (isRecord(expected) && typeof expected.opcode === 'string' && block.type !== expected.opcode)) return false;
        const mark = markBlockLocation(block, location.parts);
        if (!mark) return false;
        try {
            workspace.centerOnBlock(location.id);
        } catch (error) {
            mark.clear();
            throw error;
        }
        if (location.signal.aborted) {mark.clear(); return false;}
        location.signal.addEventListener('abort', mark.clear, {once: true});
        return true;
    };
}
