import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
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
    await dialog.getByRole('button', {name: 'Keep'}).click();
    assert.equal(await page.evaluate(() => choice), 'keep');
    assert.deepEqual(errors, []);
});
