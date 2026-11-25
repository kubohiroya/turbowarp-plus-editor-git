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

test('the Editor creates and duplicates a merge candidate, and both play in fresh, isolated players', {
    skip: !build && 'Set E2E_PROJECT_FOLDER_BUILD to a built Editor with this Git package', timeout: 120_000
}, async t => {
    assert.ok(path.isAbsolute(build));
    const fixture = await mergePlanFixture(t, '');
    const before = await fixture.snapshot();
    const args = ['--enable-experimental-web-platform-features', '--enable-unsafe-swiftshader'];
    const browser = await chromium.launch({headless: true, args});
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
    const plans = page.getByRole('dialog', {name: 'Merge plans'});
    await expect(plans.getByRole('option', {name: 'origin/main', exact: true})).toBeAttached();
    await plans.getByLabel('Bring in from').selectOption({label: 'origin/main'});
    await plans.getByRole('button', {name: 'Create candidate'}).click();
    const candidate = number => plans.getByRole('region', {name: 'Candidate ' + number, exact: true});
    await candidate(1).getByRole('button', {name: 'Duplicate'}).click();
    await expect(candidate(2)).toContainText('Copied from Candidate 1');
    const sprite = () => window.vm?.runtime.getSpriteTargetByName('Walker');
    const worktreeSteps = () => window.vm.runtime.getSpriteTargetByName('Walker').blocks.getBlock('move').inputs.STEPS;
    const savedInput = await page.evaluate(worktreeSteps);
    let firstFrame;
    for (const number of [1, 2]) {
        await candidate(number).getByRole('button', {name: 'Playtest'}).click();
        const player = page.getByRole('dialog', {name: 'Playtest · Candidate ' + number});
        await expect(player).toBeVisible();
        const frame = await (await player.locator('iframe').elementHandle()).contentFrame();
        assert.ok(frame);
        await frame.waitForFunction(sprite, null, {timeout: 45_000});
        if (number === 1) firstFrame = frame;
        else assert.notEqual(frame, firstFrame);
        assert.equal(await frame.evaluate(() => window.vm.runtime.getSpriteTargetByName('Walker').x), 0);
        await frame.getByTitle('Go', {exact: true}).click();
        await frame.waitForFunction(() => {
            const target = window.vm.runtime.getSpriteTargetByName('Walker');
            return target.x === 25 && target.direction === 120;
        });
        await player.getByRole('button', {name: 'Close', exact: true}).click();
        await expect(player).toHaveCount(0);
    }
    assert.equal(await page.evaluate(() => window.vm.runtime.getSpriteTargetByName('Walker').x), 0);
    assert.deepEqual(await page.evaluate(worktreeSteps), savedInput);
    assert.deepEqual(await fixture.snapshot(), before);
    assert.deepEqual(errors, []);
});
