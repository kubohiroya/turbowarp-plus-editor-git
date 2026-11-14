import {isRecord} from './project-source-patch.js';
import type {BlockChangeKind, BlockPart, BlockSide, BlockTable} from './project-source-patch.js';
import {markBlockLocation} from './block-diff-location.js';
import type {DiffSvgBlock} from './block-diff-location.js';
import {attachBlockDiffGuides} from './block-diff-guides.js';

interface BlockWorkspace {
    dispose(): void;
    markFocused(): void;
    getBlocksBoundingBox(): {x?: number; y?: number; width: number; height: number};
    getBlockById(id: string): DiffSvgBlock | null;
    options?: {pathToMedia?: string; zoomOptions?: {startScale?: number}};
    scale?: number;
    scrollX?: number;
    scrollY?: number;
    translate?(x: number, y: number): void;
    getMetrics?(): {absoluteLeft?: number; absoluteTop?: number; contentLeft?: number; contentTop?: number;
        contentWidth?: number; contentHeight?: number} | null;
    scrollbar?: {resize(): void} | null;
}
interface InjectOptions {
    readOnly: true;
    sounds: false;
    media?: string;
    scrollbars?: boolean;
    zoom?: {controls: boolean; wheel: boolean; startScale: number; maxScale: number; minScale: number; scaleSpeed: number};
}
export interface ScratchBlocksPort {
    inject(container: HTMLElement, options: InjectOptions): BlockWorkspace;
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
    /**
     * Adds the host's workspace navigation to each preview, as in its own code area: for example the costume
     * thumbnail, a minimap and a row of zoom buttons in the lower right. `watermark` holds the costume thumbnail when
     * the version has one; the host positions it. Without this option, previews keep Scratch Blocks' zoom buttons.
     */
    attachNavigation?(workspace: unknown, blockly: ScratchBlocksPort, watermark?: HTMLElement): {dispose(): void} | null | undefined;
}
export interface ScriptBlockMark {
    id: string;
    kind: BlockChangeKind;
    parts: readonly BlockPart[];
}

/** Position and zoom of one preview, in Scratch Blocks workspace terms. */
export interface BlockPreviewViewport {scale: number; x: number; y: number}
/** Lets several previews of one comparison share their zoom, scroll position and height. */
export interface BlockPreviewView {
    /** The zoom and frame height at which this preview shows all of its blocks. */
    readonly fit: {scale: number; height: number};
    /** Applies a zoom and frame height, scrolling to the start of the blocks. */
    layout(fit: {scale: number; height: number}): void;
    viewport(): BlockPreviewViewport;
    setViewport(viewport: BlockPreviewViewport): void;
    /** Calls `listener` after the user scrolls or zooms this preview. */
    onChange(listener: () => void): () => void;
}
export type ProjectBlockRendering = (() => void) | {dispose(): void; view?: BlockPreviewView} | undefined;
export type ProjectBlockRenderer = (args: BlockSide & {
    container: HTMLElement; withContext: boolean; parts?: readonly BlockPart[]; marks?: readonly ScriptBlockMark[]; signal: AbortSignal;
    /** The costume thumbnail element of this version, placed in the preview's lower right by the host navigation. */
    watermark?: HTMLElement;
}) => Promise<ProjectBlockRendering>;

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

// Scratch Blocks' scale for the code area, which keeps the blocks the size people edit them at.
const defaultScale = 0.675;
const padding = 16;
const minHeight = 160;
const maxHeight = 420;

/**
 * Sizes a preview frame to its blocks and reports scrolling and zooming, so both versions can move together.
 * The frame keeps a gutter on the right for the zoom buttons, and for the minimap and thumbnail when present.
 */
function createView(workspace: BlockWorkspace, blockly: ScratchBlocksPort, surface: HTMLElement, frame: HTMLElement,
    startScale: number, navigation: boolean, targets: readonly Element[]) {
    const bounds = workspace.getBlocksBoundingBox();
    const left = bounds.x ?? 0, top = bounds.y ?? 0;
    const gutter = navigation ? 150 : 56;
    const width = frame.clientWidth || 400;
    const scale = Math.max(0.25, Math.min(startScale, (width - padding - gutter) / Math.max(1, bounds.width),
        (maxHeight - 2 * padding) / Math.max(1, bounds.height)));
    const fit = {scale, height: Math.min(maxHeight, Math.max(minHeight, Math.ceil(bounds.height * scale + 2 * padding)))};
    const guides = attachBlockDiffGuides(surface, targets, () => workspace.getMetrics?.(), () => workspace.scale ?? fit.scale);
    const listeners = new Set<() => void>();
    const translate = workspace.translate?.bind(workspace);
    let quiet = false;
    // Scrolling, dragging and every zoom end in translate, which moves the canvas.
    if (translate) workspace.translate = (x, y) => {
        translate(x, y);
        guides?.schedule();
        if (!quiet) for (const listener of listeners) listener();
    };
    const setViewport = ({scale, x, y}: BlockPreviewViewport) => {
        if (!translate) return;
        quiet = true;
        try {
            // setScale would also close menus in the Editor's own workspace.
            workspace.scale = scale;
            workspace.scrollX = x;
            workspace.scrollY = y;
            const metrics = workspace.getMetrics?.();
            translate(x + (metrics?.absoluteLeft ?? 0), y + (metrics?.absoluteTop ?? 0));
            workspace.scrollbar?.resize();
            guides?.schedule();
        } finally {
            quiet = false;
        }
    };
    const layout = ({scale, height}: {scale: number; height: number}) => {
        // The frame takes the height, so people can still drag its resize handle afterwards.
        frame.style.height = height + 'px';
        blockly.svgResize(workspace);
        setViewport({scale, x: padding - left * scale, y: padding - top * scale});
    };
    layout(fit);
    // Keep the drawing area matched to the frame when the panel or the frame is resized.
    const resize = new (surface.ownerDocument.defaultView ?? globalThis).ResizeObserver(() => {
        blockly.svgResize(workspace);
        guides?.resize();
    });
    resize.observe(surface);
    // A plain wheel scrolls the review; Ctrl and trackpad pinches still zoom the preview.
    const wheel = (event: WheelEvent) => {if (!event.ctrlKey) event.stopPropagation();};
    surface.addEventListener('wheel', wheel, {capture: true});
    const api: BlockPreviewView = {
        fit, layout, setViewport,
        viewport: () => ({scale: workspace.scale ?? fit.scale, x: workspace.scrollX ?? 0, y: workspace.scrollY ?? 0}),
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
    return {api, dispose() {
        frame.style.removeProperty('height');
        listeners.clear();
        resize.disconnect();
        guides?.dispose();
        surface.removeEventListener('wheel', wheel, {capture: true});
        if (translate) workspace.translate = translate;
    }};
}

/** Use the host's Scratch VM serializer and Scratch Blocks definitions in an isolated workspace. */
export function createScratchBlocksDiffRenderer(options: ScratchBlockDiffRendererOptions): ProjectBlockRenderer {
    return async ({container, target, id, withContext, parts = [], marks, signal, watermark}) => {
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
        let view!: ReturnType<typeof createView>;
        let navigation: {dispose(): void} | null | undefined;
        const cleanups: (() => void)[] = [];
        const placeholders: string[] = [];
        const dispose = () => {
            const active = blockly.getMainWorkspace();
            for (const cleanup of cleanups.splice(0)) cleanup();
            blockly.Events.disable();
            try {
                navigation?.dispose();
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
            const startScale = main?.options?.zoomOptions?.startScale ?? defaultScale;
            // Scratch Blocks checks that its injection host belongs to the Editor document.
            // Initialize there, then move the read-only workspace into the comparison window.
            const editorDocument = globalThis.document;
            const external = editorDocument && surface.ownerDocument !== editorDocument;
            if (external) editorDocument.body.append(surface);
            try {
                workspace = blockly.inject(surface, {readOnly: true, sounds: false, media: main?.options?.pathToMedia, scrollbars: true,
                    zoom: {controls: true, wheel: true, startScale, maxScale: 4, minScale: 0.25, scaleSpeed: 1.2}});
            } finally {
                if (external) container.append(surface);
            }
            workspace.markFocused = () => {};
            blockly.Xml.domToWorkspace(dom, workspace);
            if (external) {
                // Load Blockly's media from the Editor and embed it in the about:blank window.
                const xlink = 'http://www.w3.org/1999/xlink';
                for (const image of surface.querySelectorAll('image')) {
                    const href = image.getAttributeNS(xlink, 'href');
                    if (!href || href.startsWith('#')) continue;
                    const url = new URL(href, editorDocument.baseURI);
                    if (url.origin !== editorDocument.location.origin) continue;
                    void fetch(url, {signal}).then(response => {
                        if (!response.ok) return;
                        return response.blob().then(blob => {
                            if (signal.aborted) return;
                            const reader = new FileReader();
                            reader.onload = () => {
                                if (!signal.aborted && typeof reader.result === 'string') {
                                    image.setAttributeNS(xlink, 'xlink:href', reader.result);
                                }
                            };
                            reader.readAsDataURL(blob);
                        });
                    }).catch(() => {});
                }
            }
            const guideTargets: Element[] = [];
            if (marks) {
                for (const mark of marks) {
                    const changed = workspace.getBlockById(mark.id === root ? serializedRoot : mark.id);
                    if (!changed) continue;
                    changed.getSvgRoot()?.classList.add('twgit-block-diff-' + mark.kind);
                    guideTargets.push(...(markBlockLocation(changed, mark.parts)?.targets ?? []));
                }
            } else {
                const changed = workspace.getBlockById(id === root ? serializedRoot : id);
                if (changed) guideTargets.push(...(markBlockLocation(changed, parts)?.targets ?? []));
            }
            view = createView(workspace, blockly, surface, container, startScale, !!options.attachNavigation, guideTargets);
            cleanups.push(view.dispose);
            navigation = options.attachNavigation?.(workspace, blockly, watermark);
            if (navigation && watermark) {
                // The host now positions the thumbnail beside its minimap.
                watermark.dataset.navigation = '';
                cleanups.push(() => delete watermark.dataset.navigation);
            }
        } catch (error) {
            dispose();
            throw error;
        } finally {
            blockly.mainWorkspace = main;
            blockly.Events.enable();
        }
        return {dispose, view: view.api};
    };
}
