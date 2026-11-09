import type {ProjectBlockLocator, ScratchBlockLocationWorkspace} from './block-diff-location.js';

/** The parts of a Scratch VM the locator reads to find a stage or sprite. */
export interface LocatorVM {
    runtime: {targets: readonly {id: string; isOriginal?: boolean; isStage: boolean; getName(): string}[]};
    editingTarget?: {id: string} | null;
}

export interface EditorBlockLocatorOptions {
    vm: LocatorVM;
    /** Opens the code of one stage or sprite in the Editor, as project search does. */
    openTargetCode(targetId: string): void | Promise<void>;
    /** The Editor's code workspace as it is now, or `null` while none is shown. */
    getWorkspace(): ScratchBlockLocationWorkspace | null | Promise<ScratchBlockLocationWorkspace | null>;
}

/**
 * Finds the stage or sprite of a compared version in the open project, opens its code and waits for the block,
 * then centers and outlines it. The caller decides which version matches the open project.
 */
export function createEditorBlockLocator(options: EditorBlockLocatorOptions): ProjectBlockLocator {
    void options;
    throw new Error('Not implemented yet.');
}
