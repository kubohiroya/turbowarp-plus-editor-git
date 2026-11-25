import {observePlaytest, resumeScriptEdit, type MergePlaytestRequest, type PlaytestStop} from './merge-playtest.js';
import {openProjectVersionEditor} from './project-version-editor.js';
import type {ProjectVersionZip} from './project-version-preview.js';

type Blocks = {_blocks: Record<string, unknown>; resetCache(): void};
type Thread = {stack: Array<string | null>; blockContainer: Blocks};
type Target = {id: string; isOriginal: boolean; getName(): string; blocks: Blocks};
type Observer = ReturnType<typeof observePlaytest>;

export interface PlaytestVM {
    runtime: {
        targets: Target[];
        threads: Thread[];
        setBlockExecutionObserver?(observer: Observer): void;
        ioDevices?: {clock: {pause(): void; resume(): void}};
        updateCurrentMSecs?(): void;
    };
    toJSON(target?: string, options?: {allowOptimization: boolean}): string;
    serializeAssets(): Array<{fileName: string; fileContent: Uint8Array}>;
    setEditingTarget(id: string): void;
}

const findTarget = (vm: PlaytestVM, name: string) =>
    vm.runtime.targets.find(target => target.isOriginal && target.getName() === name);

export function connectMergePlaytest(view: Window, vm: PlaytestVM, request: MergePlaytestRequest,
    {player, deserialize, zip: Zip}: {
        player: HTMLElement;
        deserialize(blocks: Record<string, unknown>): Record<string, unknown>;
        zip: ProjectVersionZip;
    }) {
    if (!request.conflicts.length) return;
    if (!vm.runtime.setBlockExecutionObserver) throw new Error('Playtest execution observer is unavailable');
    const {document} = view;
    const params = new URLSearchParams(view.location.search);
    const locale = params.get('lang') ?? 'en';
    const ja = locale.startsWith('ja');
    const toolbar = document.createElement('div');
    toolbar.className = 'twgit-playtest-toolbar';
    toolbar.hidden = true;
    const state = document.createElement('span');
    state.role = 'status';
    state.textContent = ja ? '試遊全体を一時停止中' : 'The whole playtest is paused';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = ja ? 'スクリプトを編集' : 'Edit script';
    toolbar.append(state, edit);
    document.body.append(toolbar);
    const observer = observePlaytest(request.conflicts, () => {
        vm.runtime.ioDevices?.clock.pause();
        player.inert = true;
        toolbar.hidden = false;
        queueMicrotask(() => edit.focus());
    });
    vm.runtime.setBlockExecutionObserver(observer);
    edit.onclick = async () => {
        const stop = observer.stopped;
        if (!stop) return;
        edit.disabled = true;
        try {
            // Keep block IDs stable across the two VM instances for selection and continuation.
            const zip = new Zip();
            zip.file('project.json', vm.toJSON(undefined, {allowOptimization: false}));
            for (const {fileName, fileContent} of vm.serializeAssets()) zip.file(fileName, fileContent);
            const archive = await zip.generateAsync({type: 'arraybuffer'});
            const adopted = await openProjectVersionEditor(document, archive, locale, {
                page: view.location.pathname, params: Object.fromEntries(params), title: edit.textContent!, stop
            }, async ({before, after}) => {
                const target = findTarget(vm, stop.target);
                const replacement = resumeScriptEdit(before, after, stop);
                if (!target || !replacement || observer.stopped !== stop) throw new Error('Invalid continuation');
                const {blocks, changedIds, affected} = replacement;
                const serializedIds = new Set(Object.keys(blocks));
                const decoded = deserialize(blocks);
                const active = vm.runtime.threads.filter(thread => thread.blockContainer === target.blocks);
                if (active.some(thread => thread.stack.some(id => id !== null && changedIds.has(id) && !Object.hasOwn(decoded, id)) ||
                    (thread.stack.at(-1) !== stop.next && affected.has(thread.stack.at(-1) ?? '')))) {
                    throw new Error('An active block would change');
                }
                const blockTable = {...target.blocks._blocks};
                const changedInlineInput = (id: string, block: unknown) => {
                    const parent = (block as {parent?: string} | null)?.parent;
                    return parent !== undefined && changedIds.has(parent) && !serializedIds.has(id);
                };
                for (const [id, block] of Object.entries(blockTable)) {
                    if (changedIds.has(id) || changedInlineInput(id, block)) delete blockTable[id];
                }
                for (const [id, block] of Object.entries(decoded)) {
                    if (changedIds.has(id) || changedInlineInput(id, block)) blockTable[id] = block;
                }
                target.blocks._blocks = blockTable;
                target.blocks.resetCache();
                return stop.id;
            });
            if (adopted) {
                vm.runtime.updateCurrentMSecs?.();
                vm.runtime.ioDevices?.clock.resume();
                observer.resume();
                player.inert = false;
                toolbar.hidden = true;
            }
        } catch {
            state.textContent = ja ? '試遊全体を一時停止中。編集タブを開けませんでした。' :
                'The whole playtest is paused. The editor could not be opened.';
        } finally {
            edit.disabled = false;
        }
    };
}

interface WorkspaceBlock {
    getSvgRoot(): SVGElement | null;
    getField?(id: string): {getSvgRoot?(): SVGElement | null} | null;
    getInput?(id: string): {connection?: {targetBlock(): WorkspaceBlock | null}} | null;
}

interface Workspace {
    getBlockById(id: string): WorkspaceBlock | null;
    getParentSvg(): SVGElement;
    centerOnBlock(id: string): void;
}

/** Anchor the competing edits and the execution markers to the live Blockly canvas. */
export function focusPlaytestStop(view: Window, vm: PlaytestVM, stop: PlaytestStop, workspace: () => Workspace | undefined) {
    const target = findTarget(vm, stop.target);
    if (!target) return;
    vm.setEditingTarget(target.id);
    const {document} = view;
    const ja = new URLSearchParams(view.location.search).get('lang')?.startsWith('ja');
    const overlay = document.createElement('div');
    overlay.className = 'twgit-playtest-overlay';
    const horizontal = document.createElement('span'), vertical = document.createElement('span');
    horizontal.className = vertical.className = 'twgit-playtest-band';
    const previous = document.createElement('span'), next = document.createElement('span');
    previous.className = next.className = 'twgit-playtest-marker';
    previous.textContent = ja ? '✓ 直前に実行' : '✓ Last executed';
    next.textContent = ja ? '▶ 次に実行' : '▶ Next to execute';
    overlay.append(horizontal, vertical, previous, next);
    document.body.append(overlay);
    let centered = false;
    const update = () => {
        const editor = workspace();
        const block = editor?.getBlockById(stop.focus);
        if (!editor || !block) {
            overlay.hidden = true;
            view.requestAnimationFrame(update);
            return;
        }
        if (!centered) {
            editor.centerOnBlock(stop.focus);
            centered = true;
        }
        const canvas = editor.getParentSvg().getBoundingClientRect();
        const input = stop.input;
        const anchor = (input && (block.getField?.(input)?.getSvgRoot?.() ??
            block.getInput?.(input)?.connection?.targetBlock()?.getSvgRoot())) || block.getSvgRoot();
        const box = anchor?.getBoundingClientRect();
        if (box) {
            overlay.hidden = false;
            Object.assign(overlay.style, {top: canvas.top + 'px', left: canvas.left + 'px',
                width: canvas.width + 'px', height: canvas.height + 'px'});
            Object.assign(horizontal.style, {left: '0', right: '0', top: (box.top - canvas.top) + 'px', height: box.height + 'px'});
            Object.assign(vertical.style, {top: '0', bottom: '0', left: (box.left - canvas.left) + 'px', width: box.width + 'px'});
            const marker = (element: HTMLElement, id?: string, gap = 5) => {
                // The SVG group also contains the blocks below it. Use only this block's outline.
                const outline = id && editor.getBlockById(id)?.getSvgRoot()?.querySelector(':scope > .blocklyBlockBackground');
                const bounds = outline ? outline.getBoundingClientRect() : undefined;
                element.hidden = !bounds;
                if (bounds) {
                    Object.assign(element.style, {right: (canvas.right - bounds.left + gap) + 'px',
                        top: (bounds.top - canvas.top + bounds.height / 2) + 'px'});
                }
            };
            marker(next, stop.next);
            marker(previous, stop.previous, stop.previous === stop.next ? next.offsetWidth + 10 : 5);
        }
        view.requestAnimationFrame(update);
    };
    view.requestAnimationFrame(update);
}
