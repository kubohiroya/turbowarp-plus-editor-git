import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';

const before = {targets: [
    {isStage: true, name: 'Stage', blocks: {}},
    {isStage: false, name: 'Cat', blocks: {
        flag: {opcode: 'event_whenflagclicked', next: 'move', topLevel: true},
        move: {opcode: 'motion_movesteps', parent: 'flag', inputs: {STEPS: [1, [4, '10']]}}
    }}
]};
const after = structuredClone(before);
after.targets[1].blocks.move.inputs.STEPS[1][1] = '25';

async function open(t, rememberAs, snapshots = {before, after}) {
    const server = await serveEditorRuntime({script: fileURLToPath(new URL('./project-source-tabs-page.js', import.meta.url))});
    const browser = await chromium.launch();
    t.after(async () => {await browser.close(); await server.close();});
    const page = await browser.newPage({viewport: {width: 1200, height: 1400}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const mount = async input => {
        await page.goto(server.url);
        assert.ok(await page.evaluate(value => mountReview(value), {...input, rememberAs}) > 0);
    };
    await mount(snapshots);
    return {page, errors, mount};
}

test('a reviewed mark set in a script tab shows in the pull request review, and back', async t => {
    const {page, errors} = await open(t, 'owner/game#7');
    const tab = page.locator('[data-tab^="緑の旗が押されたとき"]');
    const panel = page.locator('[data-panel]');
    const count = panel.locator('dt:text-is("確認済み") + dd');
    assert.equal(await count.textContent(), '0 / 1');

    await tab.getByRole('checkbox', {name: '確認済み'}).check();
    assert.equal(await count.textContent(), '1 / 1');
    assert.match(await page.evaluate(() => localStorage.getItem('turbowarp-plus-git:reviewed:owner/game#7')), /Cat/);

    await panel.locator('.twgit-review-script > summary').click();
    const panelBox = panel.getByRole('checkbox', {name: '確認済み'});
    assert.equal(await panelBox.isChecked(), true);
    await panelBox.uncheck();
    assert.equal(await tab.getByRole('checkbox', {name: '確認済み'}).isChecked(), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('turbowarp-plus-git:reviewed:owner/game#7')), null);
    assert.deepEqual(errors, []);
});

test('the marks of a comparison that is not remembered stay out of browser storage', async t => {
    const {page, errors} = await open(t);
    const box = page.locator('[data-tab^="緑の旗が押されたとき"]').getByRole('checkbox', {name: '確認済み'});
    await box.check();
    assert.equal(await box.isChecked(), true);
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    assert.deepEqual(errors, []);
});

test('a new pull request revision clears only the marks of scripts it changed', async t => {
    const initial = structuredClone(before);
    const blocks = initial.targets[1].blocks;
    blocks.click = {opcode: 'event_whenthisspriteclicked', next: 'say', topLevel: true};
    blocks.say = {opcode: 'looks_say', parent: 'click', inputs: {MESSAGE: [1, [10, 'before']]}};
    const reviewed = structuredClone(initial);
    reviewed.targets[1].blocks.move.inputs.STEPS[1][1] = '25';
    reviewed.targets[1].blocks.say.inputs.MESSAGE[1][1] = 'after';
    const {page, errors, mount} = await open(t, 'owner/game#8', {before: initial, after: reviewed});
    const count = page.locator('[data-panel] dt:text-is("確認済み") + dd');
    const mark = index => page.locator('[data-tab]').nth(index).getByRole('checkbox', {name: '確認済み'});
    assert.equal(await page.locator('[data-tab]').count(), 2);
    await mark(0).check();
    await mark(1).check();
    assert.equal(await count.textContent(), '2 / 2');
    await mount({before: initial, after: reviewed});
    assert.equal(await count.textContent(), '2 / 2');

    const next = structuredClone(reviewed);
    next.targets[1].blocks.move.inputs.STEPS[1][1] = '30';
    await mount({before: initial, after: next});
    assert.equal(await count.textContent(), '1 / 2');
    assert.equal(await mark(0).isChecked(), false);
    assert.equal(await mark(1).isChecked(), true);
    assert.deepEqual(errors, []);
});
