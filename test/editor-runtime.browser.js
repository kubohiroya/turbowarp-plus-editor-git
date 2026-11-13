import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium, expect} from '@playwright/test';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';

const block = (opcode, {next = null, parent = null, inputs = {}, x = 0, y = 0} = {}) =>
    ({opcode, next, parent, inputs, fields: {}, shadow: false, topLevel: parent === null, ...(parent === null ? {x, y} : {})});
const source = blocks => `${JSON.stringify({targets: [
    {isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {}, costumes: [], sounds: []},
    {isStage: false, name: 'Cat', variables: {}, lists: {}, broadcasts: {}, blocks, comments: {}, costumes: [], sounds: []}
]}, null, 2)}\n`;
const before = {flag: block('event_whenflagclicked', {next: 'move'}), move: block('motion_movesteps', {parent: 'flag', inputs: {STEPS: [1, [4, '10']]}})};
const after = structuredClone(before);
after.move.next = 'turn';
after.move.inputs.STEPS = [1, [4, '25']];
after.turn = block('motion_turnright', {parent: 'move', inputs: {DEGREES: [1, [4, '15']]}});

test('the comparison dialog draws both versions of a changed script with the real Scratch Blocks', async t => {
    const server = await serveEditorRuntime({script: fileURLToPath(new URL('./editor-runtime-page.js', import.meta.url))});
    const browser = await chromium.launch();
    t.after(async () => {await browser.close(); await server.close();});
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url);
    await page.evaluate(value => compare(value), {before: source(before), after: source(after)});
    const dialog = page.getByRole('dialog', {name: 'Compare'});
    const section = dialog.getByRole('region', {name: 'Changes in the folder'});
    await section.locator('.twgit-review-script').first().waitFor();
    // Drawn blocks are SVG paths from Scratch Blocks, not placeholders.
    await section.locator('.twgit-review-script summary').first().click();
    await section.locator('svg .blocklyBlockCanvas path.blocklyPath').first().waitFor({timeout: 10_000});
    // Two sides: before draws two blocks, after draws three, each block with its number input.
    const sides = section.locator('.twgit-block-diff-side');
    assert.equal(await sides.count(), 2);
    assert.ok(await sides.nth(1).locator('path.blocklyPath').count() > await sides.nth(0).locator('path.blocklyPath').count());
    assert.equal(await section.locator('.twgit-block-diff-added').count() > 0, true, 'the added block is marked');
    assert.match(await sides.nth(1).locator('svg.blocklySvg').textContent(), /turn/);

    const preview = sides.nth(1).locator('.twgit-block-diff-surface');
    const verticalBands = preview.locator('[data-diff-band="x"]');
    const horizontalBands = preview.locator('[data-diff-band="y"]');
    const horizontalTicks = preview.locator('.blocklyScrollbarHorizontal .twgit-diff-scroll-marks rect');
    const verticalTicks = preview.locator('.blocklyScrollbarVertical .twgit-diff-scroll-marks rect');
    await expect(verticalBands).toHaveCount(2);
    await expect(horizontalBands).toHaveCount(2);
    await expect(horizontalTicks).toHaveCount(2);
    await expect(verticalTicks).toHaveCount(2);
    const center = (locator, axis) => locator.evaluate((element, direction) => {
        const box = element.getBoundingClientRect();
        return direction === 'x' ? box.x + box.width / 2 : box.y + box.height / 2;
    }, axis);
    const input = preview.locator('.twgit-changed-block-part').first().locator('> .blocklyPath');
    const checkAlignment = async () => {
        await expect.poll(async () => Math.abs(await center(verticalBands.first(), 'x') - await center(input, 'x'))).toBeLessThan(1);
        await expect.poll(async () => Math.abs(await center(horizontalBands.first(), 'y') - await center(input, 'y'))).toBeLessThan(1);
    };
    await checkAlignment();
    const frame = await preview.boundingBox();
    const x = await center(verticalBands.first(), 'x');
    const y = await center(horizontalBands.first(), 'y');
    await page.mouse.move(x, frame.y + 2);
    await expect(verticalBands.first()).toHaveCSS('fill-opacity', '0.62');
    await expect(horizontalBands.first()).toHaveCSS('fill-opacity', '0.25');
    await page.mouse.move(frame.x + 2, y);
    await expect(horizontalBands.first()).toHaveCSS('fill-opacity', '0.62');
    await expect(verticalBands.first()).toHaveCSS('fill-opacity', '0.25');
    await page.mouse.move(frame.x + 2, frame.y - 2);
    await expect(preview.locator('[data-diff-band][data-hover]')).toHaveCount(0);

    // Dragging the workspace moves the bands with the blocks. Ticks stay at the same positions in the scroll range.
    const tickX = await center(horizontalTicks.first(), 'x');
    const tickY = await center(verticalTicks.first(), 'y');
    await page.mouse.move(frame.x + frame.width - 90, frame.y + 20);
    await page.mouse.down();
    await page.mouse.move(frame.x + frame.width - 125, frame.y + 45, {steps: 5});
    await page.mouse.up();
    await expect.poll(async () => Math.abs(await center(verticalBands.first(), 'x') - x)).toBeGreaterThan(10);
    await checkAlignment();
    assert.equal(await center(horizontalTicks.first(), 'x'), tickX);
    assert.equal(await center(verticalTicks.first(), 'y'), tickY);
    const canvas = preview.locator('.blocklyBlockCanvas');
    const transform = await canvas.getAttribute('transform');
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -80);
    await page.keyboard.up('Control');
    await expect.poll(() => canvas.getAttribute('transform')).not.toBe(transform);
    await checkAlignment();

    await dialog.getByRole('button', {name: 'Keep'}).click();
    assert.equal(await page.evaluate(() => choice), 'keep');
    assert.deepEqual(errors, []);
});
