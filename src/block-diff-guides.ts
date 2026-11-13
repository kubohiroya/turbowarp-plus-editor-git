interface ScrollMetrics {
    contentLeft?: number;
    contentTop?: number;
    contentWidth?: number;
    contentHeight?: number;
}

const svgNamespace = 'http://www.w3.org/2000/svg';
const bandWidth = 14;
const tickWidth = 5;

function guideLayer(parent: Element, name: string) {
    const layer = parent.ownerDocument.createElementNS(svgNamespace, 'g');
    layer.classList.add(name);
    layer.setAttribute('aria-hidden', 'true');
    return layer;
}

function guideRect(layer: SVGGElement) {
    const rect = layer.ownerDocument.createElementNS(svgNamespace, 'rect');
    layer.append(rect);
    return rect;
}

function scrollbarGuides(surface: HTMLElement, horizontal: boolean, count: number) {
    const axis = horizontal ? 'Horizontal' : 'Vertical';
    const track = surface.querySelector<SVGRectElement>(
        `.blocklyMainWorkspaceScrollbar.blocklyScrollbar${axis} .blocklyScrollbarBackground`);
    if (!track?.parentElement) return;
    const layer = guideLayer(track, 'twgit-diff-scroll-marks');
    track.parentElement.append(layer);
    const position = horizontal ? 'x' : 'y';
    const length = horizontal ? 'width' : 'height';
    const thickness = horizontal ? 'height' : 'width';
    const cross = horizontal ? 'y' : 'x';
    const marks = Array.from({length: count}, () => guideRect(layer));
    for (const mark of marks) {
        mark.setAttribute(length, String(tickWidth));
        mark.setAttribute(cross, '1');
        mark.setAttribute('rx', '1');
    }
    return {
        update(offsets: readonly number[], start = 0, extent = 0) {
            const size = track[length].baseVal.value;
            const inset = Math.max(0, track[thickness].baseVal.value - 2);
            layer.style.display = extent > 0 && size >= tickWidth ? '' : 'none';
            if (layer.style.display) return;
            offsets.forEach((offset, index) => {
                const mark = marks[index];
                const center = (offset - start) * size / extent;
                mark.setAttribute(position, String(Math.max(0, Math.min(size - tickWidth, center - tickWidth / 2))));
                mark.setAttribute(thickness, String(inset));
            });
        },
        dispose: () => layer.remove()
    };
}

/** Draws in the background's coordinate space and maps workspace positions onto the existing scrollbar tracks. */
export function attachBlockDiffGuides(surface: HTMLElement, targets: readonly Element[],
    readMetrics: () => ScrollMetrics | null | undefined, readScale: () => number) {
    const canvas = surface.querySelector<SVGGElement>('.blocklyBlockCanvas');
    const window = surface.ownerDocument.defaultView;
    if (!canvas || !window || !targets.length) return;
    const layer = guideLayer(canvas, 'twgit-diff-bands');
    canvas.before(layer);
    const locations = [...new Set(targets)].map(target => {
        // The block's SVG group can include connected blocks and inputs. Its path measures just this block.
        const shape = Array.from(target.children).find(child => child.classList.contains('blocklyPath')) ?? target;
        const vertical = guideRect(layer);
        const horizontal = guideRect(layer);
        vertical.setAttribute('width', String(bandWidth));
        vertical.setAttribute('height', '100%');
        vertical.dataset.diffBand = 'x';
        horizontal.setAttribute('height', String(bandWidth));
        horizontal.setAttribute('width', '100%');
        horizontal.dataset.diffBand = 'y';
        return {shape, vertical, horizontal, point: new window.DOMPoint(), x: NaN, y: NaN};
    });
    const horizontal = scrollbarGuides(surface, true, locations.length);
    const vertical = scrollbarGuides(surface, false, locations.length);
    let pointer: {x: number; y: number} | undefined;
    let request: number | undefined;
    let measure = true;

    const updateHover = () => {
        const matrix = pointer && layer.getScreenCTM();
        const point = matrix && pointer && new window.DOMPoint(pointer.x, pointer.y).matrixTransform(matrix.inverse());
        for (const item of locations) {
            item.vertical.toggleAttribute('data-hover', !!point && Math.abs(point.x - item.x) <= bandWidth / 2);
            item.horizontal.toggleAttribute('data-hover', !!point && Math.abs(point.y - item.y) <= bandWidth / 2);
        }
    };
    const update = () => {
        request = undefined;
        const canvasMatrix = canvas.getScreenCTM();
        const layerMatrix = layer.getScreenCTM();
        if (!canvasMatrix || !layerMatrix || !surface.clientWidth || !surface.clientHeight) return;
        const toCanvas = canvasMatrix.inverse();
        const fromCanvas = layerMatrix.inverse().multiply(canvasMatrix);
        const scale = readScale();
        const xs: number[] = [], ys: number[] = [];
        for (const item of locations) {
            if (measure) {
                const box = item.shape.getBoundingClientRect();
                item.point = new window.DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(toCanvas);
            }
            const point = item.point.matrixTransform(fromCanvas);
            item.x = point.x;
            item.y = point.y;
            item.vertical.setAttribute('x', String(point.x - bandWidth / 2));
            item.horizontal.setAttribute('y', String(point.y - bandWidth / 2));
            xs.push(item.point.x * scale);
            ys.push(item.point.y * scale);
        }
        measure = false;
        const metrics = readMetrics();
        horizontal?.update(xs, metrics?.contentLeft, metrics?.contentWidth);
        vertical?.update(ys, metrics?.contentTop, metrics?.contentHeight);
        updateHover();
    };
    const schedule = () => {request ??= window.requestAnimationFrame(update);};
    const move = ({clientX, clientY, pointerType}: PointerEvent) => {
        if (pointerType === 'touch') return;
        pointer = {x: clientX, y: clientY};
        updateHover();
    };
    const leave = () => {pointer = undefined; updateHover();};
    surface.addEventListener('pointermove', move, {capture: true, passive: true});
    surface.addEventListener('pointerleave', leave);
    schedule();
    return {
        schedule,
        resize() {measure = true; schedule();},
        dispose() {
            if (request !== undefined) window.cancelAnimationFrame(request);
            surface.removeEventListener('pointermove', move, true);
            surface.removeEventListener('pointerleave', leave);
            horizontal?.dispose();
            vertical?.dispose();
            layer.remove();
        }
    };
}
