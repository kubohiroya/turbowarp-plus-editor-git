import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium, expect} from '@playwright/test';
import {mergePlanFixture} from './merge-plan-fixture.js';

const build = process.env.E2E_PROJECT_FOLDER_BUILD;
const origin = 'http://localhost:41017';
const prefix = '/turbowarp-plus-editor/';
const mime = {'.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.wav': 'audio/wav', '.wasm': 'application/wasm'};

const options = {skip: !build && 'Set E2E_PROJECT_FOLDER_BUILD to a built Editor with this Git package', timeout: 120_000};

async function start(t, fixture) {
    assert.ok(path.isAbsolute(build));
    const args = ['--enable-experimental-web-platform-features', '--enable-unsafe-swiftshader'];
    const browser = await chromium.launch({channel: 'chromium', headless: true, args});
    t.after(() => browser.close());
    const context = await browser.newContext({viewport: {width: 1260, height: 940}});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || !url.pathname.startsWith(prefix)) return route.abort();
        const file = path.resolve(build, decodeURIComponent(url.pathname.slice(prefix.length)));
        if (!file.startsWith(build + path.sep)) return route.fulfill({status: 404});
        const body = await readFile(file).catch(() => null);
        return route.fulfill(body ? {body, contentType: mime[path.extname(file)] ?? 'application/octet-stream'} : {status: 404});
    });
    await context.addInitScript(() => {
        if (parent !== window) return;
        let directory;
        for (const type of ['dragenter', 'dragover', 'drop']) {
            window.addEventListener(type, async event => {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (type === 'drop') directory = await event.dataTransfer.items[0].getAsFileSystemHandle();
            }, {capture: true});
        }
        Object.defineProperty(window, 'showDirectoryPicker', {value: async () => directory});
        Object.defineProperty(window, 'mergePlanFixtureReady', {get: () => directory?.kind === 'directory'});
    });
    async function open() {
        // Use the Editor's receiving tab, where Open Folder hands the selected directory to this Editor.
        await page.goto(origin + prefix + 'editor.html?lang=en&twPlusOpenTab=playtest-fixture');
        await page.waitForFunction(() => window.vm?.runtime.getTargetForStage(), null, {timeout: 45_000});
        const cdp = await context.newCDPSession(page);
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
            await cdp.send('Input.dispatchDragEvent', {type, x: 100, y: 100,
                data: {items: [], files: [fixture.root], dragOperationsMask: 1}});
        }
        await cdp.detach();
        await page.waitForFunction(() => window.mergePlanFixtureReady);
        await page.getByText('File', {exact: true}).click();
        await page.getByRole('button', {name: 'Open Folder…', exact: true}).click();
        await page.getByRole('button', {name: 'Branch: main'}).click();
        await page.getByRole('menuitem', {name: 'Open Local Git', exact: true}).click();
        await page.getByRole('button', {name: 'Merge plans', exact: true}).click();
    }
    const plans = page.getByRole('dialog', {name: 'Merge plans'});
    const candidate = number => plans.getByRole('region', {name: 'Candidate ' + number, exact: true});
    const sprite = () => window.vm?.runtime.getSpriteTargetByName('Walker');
    async function createCandidate() {
        await plans.getByLabel('Bring in from').selectOption({label: 'origin/main'});
        await plans.getByRole('button', {name: 'Create candidate'}).click();
        await expect(candidate(1)).toBeVisible();
    }
    async function startPlaytest(number, generation) {
        await candidate(number).getByRole('button', {name: 'Playtest'}).click();
        const player = page.getByRole('dialog', {name: `Playtest · Candidate ${number} · Generation ${generation}`});
        await expect(player).toBeVisible();
        const frame = await (await player.locator('iframe').elementHandle()).contentFrame();
        assert.ok(frame);
        await frame.waitForFunction(sprite, null, {timeout: 45_000});
        assert.equal(await frame.evaluate(() => window.vm.runtime.getSpriteTargetByName('Walker').x), 0);
        await frame.getByTitle('Go', {exact: true}).click();
        return {player, frame};
    }
    async function play(number, generation, x, direction) {
        const {player, frame} = await startPlaytest(number, generation);
        await frame.waitForFunction(({x, direction}) => {
            const target = window.vm.runtime.getSpriteTargetByName('Walker');
            return target.x === x && target.direction === direction;
        }, {x, direction});
        await player.getByRole('button', {name: 'Close', exact: true}).click();
        await expect(player).toHaveCount(0);
        return frame;
    }
    await open();
    return {page, candidate, createCandidate, play, startPlaytest, open, errors};
}

test('the Editor creates and duplicates a merge candidate, and both play in fresh, isolated players', options, async t => {
    const fixture = await mergePlanFixture(t, '');
    const before = await fixture.snapshot();
    const {page, candidate, createCandidate, play, errors} = await start(t, fixture);
    await createCandidate();
    await candidate(1).getByRole('button', {name: 'Duplicate'}).click();
    await expect(candidate(2)).toContainText('Copied from Candidate 1');
    const worktreeSteps = () => window.vm.runtime.getSpriteTargetByName('Walker').blocks.getBlock('move').inputs.STEPS;
    const savedInput = await page.evaluate(worktreeSteps);
    const first = await play(1, 1, 25, 120);
    assert.notEqual(await play(2, 1, 25, 120), first);
    assert.equal(await page.evaluate(() => window.vm.runtime.getSpriteTargetByName('Walker').x), 0);
    assert.deepEqual(await page.evaluate(worktreeSteps), savedInput);
    assert.deepEqual(await fixture.snapshot(), before);
    assert.deepEqual(errors, []);
});

test('conflict choices save new generations, which can be reopened and played after a reload', options, async t => {
    const fixture = await mergePlanFixture(t, '');
    await fixture.put(35, 30);
    fixture.commit('Change the same input on main');
    const before = await fixture.snapshot();
    const {candidate, createCandidate, play, startPlaytest, open, errors} = await start(t, fixture);
    await createCandidate();
    await candidate(1).getByRole('button', {name: 'Duplicate'}).click();
    await expect(candidate(2)).toBeVisible();
    const first = candidate(1);
    await first.getByText(/Choose versions for conflicting changes/).click();
    await first.getByLabel(/project.source.json.*Walker/).selectOption('incoming');
    await first.getByRole('button', {name: 'Save as new generation'}).click();
    await expect(first.getByRole('option', {name: 'Generation 2', exact: true})).toBeAttached();
    assert.deepEqual(await fixture.snapshot(), before);
    fixture.git('update-ref', 'refs/remotes/origin/main', fixture.base);
    const afterExternalUpdate = await fixture.snapshot();
    await open();
    await expect(first.getByRole('option', {name: 'Generation 2', exact: true})).toBeAttached();
    const generation = number => candidate(number).getByRole('combobox', {name: /^Generation/});
    await expect(generation(2).locator('option')).toHaveCount(1);
    await generation(1).selectOption({label: 'Generation 2'});
    await play(1, 2, 25, 105);
    await generation(1).selectOption({label: 'Generation 1'});
    for (const number of [1, 2]) {
        const {player, frame} = await startPlaytest(number, 1);
        await expect(frame.getByText('The whole playtest is paused', {exact: true})).toBeVisible();
        if (number === 1) {
            await frame.getByRole('button', {name: 'Edit script', exact: true}).click();
            const editor = frame.getByRole('dialog', {name: 'Edit script', exact: true});
            const draft = await (await editor.locator('iframe').elementHandle()).contentFrame();
            await expect(draft.getByText('▶ Next to execute', {exact: true})).toBeVisible();
            await expect(draft.getByText('✓ Last executed', {exact: true})).toBeHidden();
            await editor.getByRole('button', {name: 'Close without saving', exact: true}).click();
        }
        await player.getByRole('button', {name: 'Close', exact: true}).click();
    }
    assert.deepEqual(await fixture.snapshot(), afterExternalUpdate);
    assert.deepEqual(errors, []);
});

test('pauses before an unresolved command, edits it in place and resumes the same playtest', options, async t => {
    const fixture = await mergePlanFixture(t, '', true);
    await fixture.put(35, 30);
    fixture.commit('Change the same inputs on main');
    const before = await fixture.snapshot();
    const {candidate, createCandidate, startPlaytest, errors} = await start(t, fixture);
    await createCandidate();
    await expect(candidate(1)).toContainText('Unconfirmed changes 2');
    const {player, frame} = await startPlaytest(1, 1);
    const paused = frame.getByText('The whole playtest is paused', {exact: true});
    await expect(paused).toBeVisible();
    const position = () => window.vm.runtime.getSpriteTargetByName('Walker').x;
    assert.equal(await frame.evaluate(position), 5);
    await frame.getByRole('button', {name: 'Edit script', exact: true}).click();
    const editor = frame.getByRole('dialog', {name: 'Edit script', exact: true});
    const adopt = editor.getByRole('button', {name: 'Try edit and resume', exact: true});
    await expect(adopt).toBeEnabled({timeout: 30_000});
    await expect(editor.getByRole('tab', {name: 'Edit script'})).toBeVisible();
    await expect(editor.getByText('The whole playtest is paused', {exact: true})).toBeVisible();
    const draft = await (await editor.locator('iframe').elementHandle()).contentFrame();
    assert.ok(draft);
    await expect(draft.locator('.twgit-playtest-band')).toHaveCount(2);
    await expect(draft.getByText('✓ Last executed', {exact: true})).toBeVisible();
    await expect(draft.getByText('▶ Next to execute', {exact: true})).toBeVisible();
    const workspace = draft.locator('.blocklySvg > .blocklyWorkspace > .blocklyBlockCanvas');
    await workspace.locator('[data-id="move"] .blocklyEditableText').filter({hasText: /^10$/}).click();
    const input = draft.locator('.blocklyHtmlInput');
    await input.fill('42');
    await input.press('Enter');
    await adopt.click();
    await expect(editor).toHaveCount(0);
    await frame.waitForFunction(() => window.vm.runtime.getSpriteTargetByName('Walker').x === 47);
    assert.equal(await frame.evaluate(position), 47);
    await expect(paused).toBeHidden();
    await frame.locator('body').press('Space');
    await expect(paused).toBeVisible();
    assert.equal(await frame.evaluate(position), 47);
    await player.getByRole('button', {name: 'Close', exact: true}).click();
    await expect(candidate(1).getByRole('option', {name: 'Generation 2', exact: true})).toHaveCount(0);
    const replay = await startPlaytest(1, 1);
    await expect(replay.frame.getByText('The whole playtest is paused', {exact: true})).toBeVisible();
    assert.equal(await replay.frame.evaluate(position), 5);
    assert.deepEqual(await fixture.snapshot(), before);
    assert.deepEqual(errors, []);
});

test('edits a real block in an isolated Editor and saves a replayable generation', options, async t => {
    const fixture = await mergePlanFixture(t, '');
    const before = await fixture.snapshot();
    const {page, candidate, createCandidate, open, play, errors} = await start(t, fixture);
    await createCandidate();
    const first = candidate(1);
    await first.getByRole('button', {name: 'Edit blocks', exact: true}).click();
    const edit = page.getByRole('dialog', {name: 'Edit blocks · Candidate 1 · Generation 1', exact: true});
    const save = edit.getByRole('button', {name: 'Save as new generation', exact: true});
    await expect(save).toBeEnabled({timeout: 30_000});
    const frame = await (await edit.locator('iframe').elementHandle()).contentFrame();
    assert.ok(frame);
    await expect(frame.getByText('File', {exact: true})).toHaveCount(0);
    await save.click();
    await expect(edit.getByRole('status')).toContainText('There are no block edits to save.');
    const workspace = frame.locator('.blocklySvg > .blocklyWorkspace > .blocklyBlockCanvas');
    await workspace.locator('.blocklyEditableText').filter({hasText: /^25$/}).click();
    const input = frame.locator('.blocklyHtmlInput');
    await input.fill('42');
    await input.press('Enter');
    await workspace.getByText('42', {exact: true}).waitFor();
    // Running inside the editor must not save the sprite's runtime position into the generation.
    await frame.getByTitle('Go', {exact: true}).click();
    await frame.waitForFunction(() => window.vm.runtime.getSpriteTargetByName('Walker').x === 42);
    await save.click();
    await expect(edit).toHaveCount(0);
    await expect(first.getByRole('option', {name: 'Generation 2', exact: true})).toBeAttached();
    await open();
    const generation = first.getByRole('combobox', {name: /^Generation/});
    await generation.selectOption({label: 'Generation 2'});
    await play(1, 2, 42, 120);
    await generation.selectOption({label: 'Generation 1'});
    await play(1, 1, 25, 120);
    assert.deepEqual(await fixture.snapshot(), before);
    assert.deepEqual(errors, []);
});
