import {isRecord} from './project-source-patch.js';
import type {BlockChangeKind, BlockPart, BlockSide, BlockTable} from './project-source-patch.js';
import {markBlockLocation} from './block-diff-location.js';
import type {DiffSvgBlock} from './block-diff-location.js';

interface BlockWorkspace {
    dispose(): void;
    markFocused(): void;
    getBlocksBoundingBox(): {width: number; height: number};
    getBlockById(id: string): DiffSvgBlock | null;
    options?: {pathToMedia?: string};
}
export interface ScratchBlocksPort {
    inject(container: HTMLElement, options: {readOnly: true; sounds: false; media?: string}): BlockWorkspace;
    svgResize(workspace: BlockWorkspace): void;
    getMainWorkspace(): BlockWorkspace | null;
    mainWorkspace: BlockWorkspace | null;
    Events: {disable(): void; enable(): void};
    Blocks: Record<string, unknown>;
    defineBlocksWithJsonArray?(definitions: Record<string, unknown>[]): void;
    OUTPUT_SHAPE_ROUND?: number;
    Xml: {textToDom(xml: string): Element; domToWorkspace(xml: Element, workspace: BlockWorkspace): unknown};
}
export interface ScratchBlockDiffRendererOptions {
    getBlockly(): ScratchBlocksPort | Promise<ScratchBlocksPort>;
    showUnregisteredBlocks?: boolean;
    locale?: string;
    deserializeBlocks(blocks: BlockTable): Record<string, {id: string; topLevel?: boolean}>;
    createBlockContainer(): {
        createBlock(block: {id: string}, deferProjectChanged: true): void;
        blockToXML(id: string): string | undefined;
    };
}
export interface ScriptBlockMark {
    id: string;
    kind: BlockChangeKind;
    parts: readonly BlockPart[];
}

export type ProjectBlockRenderer = (args: BlockSide & {
    container: HTMLElement; withContext: boolean; parts?: readonly BlockPart[]; marks?: readonly ScriptBlockMark[]; signal: AbortSignal;
}) => Promise<(() => void) | undefined>;

function scriptRoot({target, id}: BlockSide): string {
    const visited = new Set<string>();
    for (;;) {
        const block = target.blocks[id];
        if (!isRecord(block) || typeof block.parent !== 'string' || !Object.hasOwn(target.blocks, block.parent)) return id;
        if (visited.has(id)) throw new Error('Cyclic block parents.');
        visited.add(id);
        id = block.parent;
    }
}

function safeMutation(value: unknown, root: boolean, depth = 0): boolean {
    if (!isRecord(value) || depth > 32 || value.tagName !== (root ? 'mutation' : 'arg') || !Array.isArray(value.children)) return false;
    return Object.entries(value).every(([key, item]) => key === 'children' ||
        (/^[a-zA-Z][\w-]*$/.test(key) && ['string', 'number', 'boolean'].includes(typeof item))) &&
        value.children.every(child => safeMutation(child, false, depth + 1));
}

function selectBlocks({target, id}: BlockSide, root: string, withContext: boolean): BlockTable {
    const selected: BlockTable = Object.create(null);
    const visiting = new Set<string>();
    let blockCount = 0;
    function visit(blockId: string, followNext: boolean, depth: number) {
        if (visiting.has(blockId) || depth > 128) throw new Error('Block preview exceeds its graph limit.');
        if (Object.hasOwn(selected, blockId) || !Object.hasOwn(target.blocks, blockId)) return;
        if (++blockCount > 800) throw new Error('Block preview exceeds its graph limit.');
        if (blockId === '__proto__') throw new Error('Invalid block ID.');
        const data = target.blocks[blockId];
        if (Array.isArray(data)) {
            selected[blockId] = data.length > 3 ? [...data.slice(0, 3), 20, 20] : [...data];
            return;
        }
        if (!isRecord(data) || typeof data.opcode !== 'string') throw new Error('Invalid Scratch block.');
        const block = structuredClone(data);
        if (block.mutation && !safeMutation(block.mutation, true)) throw new Error('Unsupported block mutation.');
        block.x = 20;
        block.y = 20;
        block.topLevel = blockId === root;
        if (blockId === root) block.shadow = false;
        delete block.comment;
        if (!followNext) block.next = null;
        selected[blockId] = block;
        visiting.add(blockId);
        if (isRecord(block.inputs)) {
            for (const [name, input] of Object.entries(block.inputs)) {
                if (!withContext && /^SUBSTACK\d*$/.test(name)) {
                    delete block.inputs[name];
                    continue;
                }
                if (!Array.isArray(input)) continue;
                for (const child of input.slice(1, 3)) {
                    if (typeof child === 'string') visit(child, withContext, depth + 1);
                }
            }
        }
        if (typeof block.next === 'string') visit(block.next, true, depth + 1);
        visiting.delete(blockId);
    }
    visit(root, withContext, 0);
    if (!Object.hasOwn(selected, id)) throw new Error('The changed block is not reachable.');
    return selected;
}

const placeholderPrefix = 'twgit_review_placeholder_';
let placeholderSerial = 0;

function statementInput(element: Element) {
    return element.localName === 'statement' || /^SUBSTACK\d*$/.test(element.getAttribute('name') ?? '');
}

function placeholderDefinition(element: Element, opcode: string, type: string, blockly: ScratchBlocksPort, locale: string) {
    const text = (locale.startsWith('ja') ? '未登録: ' : 'Unregistered: ') + opcode.slice(0, 120);
    const args: Record<string, unknown>[] = [{type: 'field_label', text}];
    const branches: string[] = [];
    for (const child of Array.from(element.children)) {
        const name = child.getAttribute('name');
        if (!name) continue;
        if (child.localName === 'field') args.push({type: 'field_input', name, text: ''});
        else if (statementInput(child)) branches.push(name);
        else if (child.localName === 'value') args.push({type: 'input_value', name});
    }
    const parent = element.parentElement;
    const reporter = parent?.localName === 'value' && !statementInput(parent);
    const definition: Record<string, unknown> = {
        type, message0: args.map((_, index) => '%' + (index + 1)).join(' '), args0: args, inputsInline: true,
        colour: '#687488', colourSecondary: '#566274', colourTertiary: '#4b5564',
        ...(reporter ? {output: null, outputShape: blockly.OUTPUT_SHAPE_ROUND} : {previousStatement: null, nextStatement: null})
    };
    for (const [index, name] of branches.entries()) {
        definition['message' + (index + 1)] = '%1';
        definition['args' + (index + 1)] = [{type: 'input_statement', name}];
    }
    return definition;
}

/** Use the host's Scratch VM serializer and Scratch Blocks definitions in an isolated workspace. */
export function createScratchBlocksDiffRenderer(options: ScratchBlockDiffRendererOptions): ProjectBlockRenderer {
    return async ({container, target, id, withContext, parts = [], marks, signal}) => {
        const blockly = await options.getBlockly();
        if (signal.aborted) return;
        const root = withContext ? scriptRoot({target, id}) : id;
        const selected = selectBlocks({target, id}, root, withContext);
        const compactRoot = Array.isArray(selected[root]);
        const blocks = options.deserializeBlocks(selected);
        const serializedRoot = compactRoot ? Object.values(blocks).find(block => block.topLevel)?.id : root;
        if (!serializedRoot) throw new Error('Missing Scratch block.');
        const vmBlocks = options.createBlockContainer();
        for (const block of Object.values(blocks)) vmBlocks.createBlock(block, true);
        const xml = vmBlocks.blockToXML(serializedRoot);
        if (!xml) throw new Error('Missing Scratch block XML.');
        const dom = blockly.Xml.textToDom('<xml>' + xml + '</xml>');
        const main = blockly.getMainWorkspace();
        const surface = container.ownerDocument.createElement('div');
        surface.className = 'twgit-block-diff-surface';
        container.append(surface);
        let workspace: BlockWorkspace | undefined;
        const placeholders: string[] = [];
        const dispose = () => {
            const active = blockly.getMainWorkspace();
            blockly.Events.disable();
            try {
                workspace?.dispose();
            } finally {
                if (active === workspace) blockly.mainWorkspace = main;
                for (const type of placeholders) delete blockly.Blocks[type];
                blockly.Events.enable();
                surface.remove();
            }
        };
        blockly.Events.disable();
        try {
            for (const element of Array.from(dom.querySelectorAll('block,shadow'))) {
                const opcode = element.getAttribute('type') ?? '';
                if (!opcode.startsWith(placeholderPrefix) && Object.hasOwn(blockly.Blocks, opcode)) continue;
                if (!options.showUnregisteredBlocks || !blockly.defineBlocksWithJsonArray) throw new Error('Unregistered Scratch block.');
                let alias: string;
                do {alias = placeholderPrefix + ++placeholderSerial;} while (Object.hasOwn(blockly.Blocks, alias));
                placeholders.push(alias);
                blockly.defineBlocksWithJsonArray([placeholderDefinition(element, opcode, alias, blockly,
                    options.locale ?? container.ownerDocument.documentElement.lang)]);
                element.setAttribute('type', alias);
            }
            workspace = blockly.inject(surface, {readOnly: true, sounds: false, media: main?.options?.pathToMedia});
            workspace.markFocused = () => {};
            blockly.Xml.domToWorkspace(dom, workspace);
            if (marks) {
                for (const mark of marks) {
                    const changed = workspace.getBlockById(mark.id === root ? serializedRoot : mark.id);
                    if (!changed) continue;
                    changed.getSvgRoot()?.classList.add('twgit-block-diff-' + mark.kind);
                    markBlockLocation(changed, mark.parts);
                }
            } else {
                const changed = workspace.getBlockById(id === root ? serializedRoot : id);
                if (changed) markBlockLocation(changed, parts);
            }
            const bounds = workspace.getBlocksBoundingBox();
            surface.style.width = Math.max(100, Math.ceil(bounds.width) + 48) + 'px';
            surface.style.height = Math.max(64, Math.ceil(bounds.height) + 48) + 'px';
            blockly.svgResize(workspace);
        } catch (error) {
            dispose();
            throw error;
        } finally {
            blockly.mainWorkspace = main;
            blockly.Events.enable();
        }
        return dispose;
    };
}
