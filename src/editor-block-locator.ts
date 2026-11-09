import {createScratchBlocksDiffLocator} from './block-diff-location.js';
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
export function createEditorBlockLocator({vm, openTargetCode, getWorkspace}: EditorBlockLocatorOptions): ProjectBlockLocator {
    return createScratchBlocksDiffLocator(async ({target, id: blockId, signal}) => {
        const found = vm.runtime.targets.find(item => target.isStage ? item.isStage :
            !item.isStage && item.isOriginal !== false && item.getName() === target.name);
        if (!found || signal.aborted) return null;
        await openTargetCode(found.id);
        // The Editor switches targets and fills its workspace over the next frames.
        const deadline = Date.now() + waitLimit;
        while (!signal.aborted) {
            if (vm.editingTarget?.id === found.id) {
                const workspace = await getWorkspace();
                if (signal.aborted) break;
                if (workspace?.getBlockById(blockId)) return workspace;
            }
            if (Date.now() >= deadline) break;
            await nextFrame(signal);
        }
        return null;
    });
}

const waitLimit = 2000;

function nextFrame(signal: AbortSignal) {
    return new Promise<void>(resolve => {
        const done = () => {
            signal.removeEventListener('abort', done);
            resolve();
        };
        signal.addEventListener('abort', done, {once: true});
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(done);
        else setTimeout(done, 16);
    });
}
