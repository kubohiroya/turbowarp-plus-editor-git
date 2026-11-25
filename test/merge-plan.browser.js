import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium, expect} from '@playwright/test';
import {mergePlanFixture} from './merge-plan-fixture.js';

const build = process.env.E2E_PROJECT_FOLDER_BUILD;
const origin = 'http://localhost:41017';
const prefix = '/turbowarp-plus-editor/';
const catalogURL = 'https://kubohiroya.github.io/turbowarp-plus-packages/extensions-v1.json';
const testExtensionURL = 'https://kubohiroya.github.io/turbowarp-test/dist/turbowarp-test.js';
const mime = {'.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.wav': 'audio/wav', '.wasm': 'application/wasm'};

const options = {skip: !build && 'Set E2E_PROJECT_FOLDER_BUILD to a built Editor with this Git package', timeout: 120_000};

async function start(t, fixture, testDigest) {
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
    if (testDigest) await context.route(catalogURL, route => route.fulfill({json: {schemaVersion: 1, extensions: [{
        id: 'kubohiroyatest', url: testExtensionURL, sha256: testDigest, name: 'Test', version: '0.1.0',
        unsandboxed: 'required', dependencies: [], description: 'Scratch tests', license: 'MPL-2.0'
    }]}, headers: {'access-control-allow-origin': '*'}}));
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

const storedGeneration = (page, generationId, withTest = false) => page.evaluate(async ({generationId, withTest}) => {
    const resultOf = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    // The previous Editor opens this exact version, including on rollback after a test has run.
    const db = await resultOf(indexedDB.open('turbowarp-plus-editor-merge-plans', 1));
    let contentId;
    let project;
    try {
        const row = await resultOf(db.transaction('generations').objectStore('generations').get(generationId));
        contentId = row.plan.contentId;
        const files = await resultOf(db.transaction('files').objectStore('files').get(contentId));
        project = JSON.parse(new TextDecoder().decode(files.get('project.source.json')));
    } finally {
        db.close();
    }
    if (!withTest) return {contentId, project};
    const results = await resultOf(indexedDB.open('turbowarp-plus-editor-merge-plan-tests', 1));
    try {
        const test = await resultOf(results.transaction('testResults').objectStore('testResults').get([generationId, contentId]));
        return {contentId, project, test};
    } finally {
        results.close();
    }
}, {generationId, withTest});

test('the Editor creates and duplicates a merge candidate, and both play in fresh, isolated players', options, async t => {
    const fixture = await mergePlanFixture(t, '');
    const before = await fixture.snapshot();
    const {page, candidate, createCandidate, play, errors} = await start(t, fixture);
    await createCandidate();
    await candidate(1).getByRole('button', {name: 'Run tests for this generation'}).click();
    await expect(candidate(1)).toContainText('This generation has no tests.');
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

const testExtensionPath = process.env.E2E_TEST_EXTENSION_JS;
test('tests the selected saved generation and reviews its persisted result before merging', {
    ...options, skip: options.skip || !testExtensionPath && 'Set E2E_TEST_EXTENSION_JS to the official Test extension build'
}, async t => {
    const testCode = await readFile(testExtensionPath);
    const fixture = await mergePlanFixture(t, '', false, testCode);
    fixture.git('reset', '--hard');
    await rm(path.join(fixture.project, 'notes.txt'));
    const before = await fixture.snapshot();
    const {page, candidate, createCandidate, open, errors} = await start(t, fixture, createHash('sha256').update(testCode).digest('hex'));
    await createCandidate();
    const first = candidate(1);
    const generation = first.getByRole('combobox', {name: /^Generation/});
    const baseGenerationId = await generation.inputValue();
    const run = first.getByRole('button', {name: 'Run tests for this generation'});
    await expect(first).toContainText('No tests have been run for this generation.');
    await run.click();
    await expect(first).toContainText('Passed 1 · Failed 0', {timeout: 30_000});
    const base = await storedGeneration(page, baseGenerationId, true);
    assert.equal(base.test.generationId, baseGenerationId);
    assert.equal(base.test.contentId, base.contentId);
    assert.equal(base.test.tests[0].status, 'passed');

    await first.getByRole('button', {name: 'Duplicate'}).click();
    await expect(candidate(2)).toContainText('No tests have been run for this generation.');
    await first.getByText('Import a revised candidate', {exact: true}).click();
    base.project.targets[0].variables.steps[1] = 42;
    await first.getByLabel('Candidate changes file').setInputFiles({
        name: 'candidate.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({formatVersion: 1, baseGenerationId, baseContentId: base.contentId,
            files: [{path: 'project.source.json', encoding: 'utf8', data: JSON.stringify(base.project)}]}))
    });
    await first.getByRole('button', {name: 'Save as new generation', exact: true}).click();
    await expect(generation.locator('option:checked')).toHaveText('Generation 2');
    const revisedGenerationId = await generation.inputValue();
    await expect(first).toContainText('No tests have been run for this generation.');
    await run.click();
    await expect(first).toContainText('Passed 0 · Failed 1', {timeout: 30_000});
    const revised = await storedGeneration(page, revisedGenerationId, true);
    assert.notEqual(revised.contentId, base.contentId);
    assert.equal(revised.test.generationId, revisedGenerationId);
    assert.equal(revised.test.contentId, revised.contentId);
    assert.equal(revised.test.tests[0].failureCount, 1);
    let releaseFrame;
    const pendingFrame = new Promise(resolve => {releaseFrame = resolve;});
    const delayNextTest = async route => {await pendingFrame; await route.fallback();};
    await page.route('**/test-frame.html', delayNextTest);
    await run.click();
    await generation.selectOption({label: 'Generation 1'});
    releaseFrame();
    await page.unroute('**/test-frame.html', delayNextTest);
    await expect(first).toContainText('Passed 1 · Failed 0');
    await expect(run).toBeEnabled({timeout: 30_000});
    await generation.selectOption({label: 'Generation 2'});
    await expect(first.getByText('Earlier test runs', {exact: true})).toBeVisible();

    const copy = candidate(2);
    const copyGeneration = copy.getByRole('combobox', {name: /^Generation/});
    const copyId = await copyGeneration.inputValue();
    await copy.getByText('Import a revised candidate', {exact: true}).click();
    await copy.getByLabel('Candidate changes file').setInputFiles({
        name: 'unverified-test.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({formatVersion: 1, baseGenerationId: copyId, baseContentId: base.contentId,
            files: [{path: 'extensions/kubohiroyatest.js', encoding: 'utf8', data: '/* Unverified build */'}]}))
    });
    await copy.getByRole('button', {name: 'Save as new generation', exact: true}).click();
    await expect(copyGeneration.locator('option:checked')).toHaveText('Generation 2');
    await copy.getByRole('button', {name: 'Run tests for this generation'}).click();
    await expect(copy).toContainText('The saved test extension does not match the trusted catalog.');

    await open();
    await generation.selectOption({label: 'Generation 1'});
    await expect(first).toContainText('Passed 1 · Failed 0');
    await generation.selectOption({label: 'Generation 2'});
    await expect(first.getByText('Earlier test runs', {exact: true})).toBeVisible();
    await first.getByRole('button', {name: 'Finalize this generation…'}).click();
    const confirm = page.getByRole('dialog', {name: 'Review merge commit'});
    await expect(confirm).toContainText('Candidate 1 · Generation 2');
    await expect(confirm).toContainText('Passed 0 · Failed 1');
    await confirm.getByText('Test details', {exact: true}).click();
    await expect(confirm.getByText(/Saved steps is 25/)).toBeVisible();
    await confirm.getByRole('button', {name: 'Cancel'}).click();
    assert.deepEqual(await fixture.snapshot(), before);
    assert.deepEqual(errors, []);
});

test('imports only an approved fix for the selected generation and plays the new generation after reload', options, async t => {
    const fixture = await mergePlanFixture(t, '');
    const before = await fixture.snapshot();
    const {page, candidate, createCandidate, play, open, errors} = await start(t, fixture);
    await createCandidate();
    const first = candidate(1);
    const generation = first.getByRole('combobox', {name: /^Generation/});
    await first.getByText('Import a revised candidate', {exact: true}).click();
    const baseGenerationId = await generation.inputValue();
    const base = await storedGeneration(page, baseGenerationId);
    const input = first.getByLabel('Candidate changes file');
    const revised = structuredClone(base.project);
    revised.targets[1].blocks.move.inputs.STEPS[1][1] = '42';
    const change = {path: 'project.source.json', encoding: 'utf8', data: JSON.stringify(revised)};
    const manifest = {formatVersion: 1, baseGenerationId, baseContentId: base.contentId, files: [change]};
    const load = patch => input.setInputFiles({
        name: 'candidate.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({...manifest, ...patch}))
    });
    const status = page.getByRole('dialog', {name: 'Merge plans'}).getByRole('alert');
    await load({baseContentId: 'wrong'});
    await expect(status).toContainText('Select the generation named by the file');
    await load({files: [{...change, path: 'assets/../project.source.json'}]});
    await expect(status).toContainText('Choose a version 1 candidate changes JSON file');
    revised.targets[1].blocks.move.next = 'missing-block';
    await load({files: [{...change, data: JSON.stringify(revised)}]});
    await expect(status).toContainText('The imported project has invalid references');

    await load({});
    await expect(first.getByText('Replace project.source.json')).toBeVisible();
    await expect(generation.locator('option')).toHaveCount(1);
    await first.getByRole('button', {name: 'Cancel import', exact: true}).click();
    await expect(generation.locator('option')).toHaveCount(1);
    await load({});
    await first.getByRole('button', {name: 'Save as new generation', exact: true}).click();
    await expect(generation.locator('option:checked')).toHaveText('Generation 2');
    await expect(first.getByText('Includes imported changes')).toBeVisible();
    await open();
    await generation.selectOption({label: 'Generation 2'});
    await play(1, 2, 42, 120);
    await generation.selectOption({label: 'Generation 1'});
    await play(1, 1, 25, 120);
    assert.deepEqual(await fixture.snapshot(), before);
    assert.deepEqual(errors, []);
});

test('conflict choices save new generations, which can be reopened and played after a reload', options, async t => {
    const fixture = await mergePlanFixture(t, '');
    await fixture.put(35, 30);
    fixture.commit('Change the same input on main');
    const before = await fixture.snapshot();
    const {page, candidate, createCandidate, play, startPlaytest, open, errors} = await start(t, fixture);
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
    await generation(1).selectOption({label: 'Generation 1'});
    await first.getByText(/Choose versions for conflicting changes/).click();
    await first.getByRole('button', {name: 'Open comparison sources'}).click();
    const comparison = page.getByRole('dialog', {name: 'Open comparison sources'});
    await comparison.getByRole('button', {name: 'Incoming', exact: true}).click();
    await expect(comparison.locator('.blocklySvg').getByText('25', {exact: true})).toBeVisible();
    await comparison.getByRole('button', {name: 'Close', exact: true}).click();
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

test('reviews the selected tested generation and rejects changes made while confirmation is open', options, async t => {
    const fixture = await mergePlanFixture(t, '');
    fixture.git('reset', '--hard');
    await rm(path.join(fixture.project, 'notes.txt'));
    await fixture.put(35, 30);
    fixture.commit('Change the same block locally');
    const {page, candidate, createCandidate, play, errors} = await start(t, fixture);
    await createCandidate();
    const first = candidate(1);
    const finalize = first.getByRole('button', {name: 'Finalize this generation…'});
    const plans = page.getByRole('dialog', {name: 'Merge plans'});
    const confirm = page.getByRole('dialog', {name: 'Review merge commit'});
    const generation = first.getByRole('combobox', {name: /^Generation/});
    await finalize.click();
    await expect(plans.getByRole('alert')).toContainText('Resolve the remaining conflicts');
    await first.getByText(/Choose versions for conflicting changes/).click();
    const select = first.getByLabel(/project.source.json.*Walker/);
    await select.selectOption('incoming');
    await first.getByRole('button', {name: 'Save as new generation'}).click();
    await expect(generation.locator('option:checked')).toHaveText('Generation 2');
    await select.selectOption('current');
    await first.getByRole('button', {name: 'Save as new generation'}).click();
    await expect(generation.locator('option:checked')).toHaveText('Generation 3');
    await generation.selectOption({label: 'Generation 2'});
    await play(1, 2, 25, 105);
    const before = await fixture.snapshot();
    await finalize.click();
    await expect(confirm).toContainText('Candidate 1 · Generation 2');
    await expect(confirm).toContainText('project.source.json');
    await confirm.getByRole('button', {name: 'Cancel'}).click();
    assert.deepEqual(await fixture.snapshot(), before);

    await finalize.click();
    await expect(confirm).toBeVisible();
    fixture.git('update-ref', 'refs/remotes/origin/main', fixture.base);
    await confirm.getByRole('button', {name: 'Create merge commit'}).click();
    await expect(plans.getByRole('alert')).toContainText('one of the recorded tips has changed');
    fixture.git('update-ref', 'refs/remotes/origin/main', fixture.incoming);
    assert.deepEqual(await fixture.snapshot(), before);

    await finalize.click();
    await expect(confirm).toBeVisible();
    const concurrent = path.join(fixture.project, 'added-while-reviewing.txt');
    await writeFile(concurrent, 'An external editor wrote this file.\n');
    await confirm.getByRole('button', {name: 'Create merge commit'}).click();
    await expect(plans.getByRole('alert')).toContainText('clear unsaved and uncommitted changes before merging');
    assert.equal(await readFile(concurrent, 'utf8'), 'An external editor wrote this file.\n');
    await rm(concurrent);
    assert.deepEqual(await fixture.snapshot(), before);
    assert.deepEqual(errors, []);
});

test('pauses before an unresolved command, edits it in place and resumes the same playtest', options, async t => {
    const fixture = await mergePlanFixture(t, '', true);
    await fixture.put(35, 30);
    fixture.commit('Change the same inputs on main');
    const before = await fixture.snapshot();
    const {page, candidate, createCandidate, startPlaytest, errors} = await start(t, fixture);
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
    const workspace = draft.locator('.blocklySvg > .blocklyWorkspace > .blocklyBlockCanvas');
    for (const [blockId, label] of [['advance', '✓ Last executed'], ['move', '▶ Next to execute']]) {
        const marker = draft.getByText(label, {exact: true});
        await expect(marker).toBeVisible();
        const outline = workspace.locator(`[data-id="${blockId}"] > .blocklyBlockBackground`);
        await expect.poll(async () => {
            const [mark, block] = await Promise.all([marker.boundingBox(), outline.boundingBox()]);
            return Boolean(mark && block && mark.x + mark.width < block.x &&
                Math.abs(mark.y + mark.height / 2 - block.y - block.height / 2) <= 1);
        }, {message: `${label} is centered to the left of ${blockId}`}).toBe(true);
    }
    await workspace.locator('[data-id="move"] .blocklyEditableText').filter({hasText: /^10$/}).click();
    const input = draft.locator('.blocklyHtmlInput');
    await input.fill('42');
    await input.press('Enter');
    await editor.getByRole('button', {name: 'Open comparison sources'}).click();
    const comparison = page.getByRole('dialog', {name: 'Open comparison sources'});
    await expect(comparison.locator('.blocklySvg').getByText('35', {exact: true})).toBeVisible();
    await comparison.getByRole('button', {name: 'Common base', exact: true}).click();
    await expect(comparison.locator('.blocklySvg').getByText('10', {exact: true})).toBeVisible();
    await comparison.getByRole('button', {name: 'Close', exact: true}).click();
    await expect(editor.getByText('The whole playtest is paused', {exact: true})).toBeVisible();
    await expect(workspace.getByText('42', {exact: true})).toBeVisible();
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

test('saves adopted blocks as a new generation and reopens it without changing the original candidate or Git', options, async t => {
    const fixture = await mergePlanFixture(t, '', true);
    await fixture.put(35, 30);
    fixture.commit('Change the same inputs on main');
    const before = await fixture.snapshot();
    const {candidate, createCandidate, startPlaytest, open, errors} = await start(t, fixture);
    await createCandidate();
    await candidate(1).getByRole('button', {name: 'Duplicate'}).click();
    await expect(candidate(2)).toBeVisible();
    const {player, frame} = await startPlaytest(1, 1);
    const save = player.getByRole('button', {name: 'Save as new generation', exact: true});
    const paused = frame.getByText('The whole playtest is paused', {exact: true});
    const position = () => window.vm.runtime.getSpriteTargetByName('Walker').x;
    const adopt = async (frame, id, value) => {
        await frame.getByRole('button', {name: 'Edit script', exact: true}).click();
        const editor = frame.getByRole('dialog', {name: 'Edit script', exact: true});
        const draft = await (await editor.locator('iframe').elementHandle()).contentFrame();
        const field = draft.locator(`[data-id="${id}"] .blocklyEditableText`).filter({hasText: /^10$/});
        await field.click();
        const input = draft.locator('.blocklyHtmlInput');
        await input.fill(value);
        await input.press('Enter');
        await editor.getByRole('button', {name: 'Try edit and resume', exact: true}).click();
        await expect(editor).toHaveCount(0);
    };
    const saveGeneration = async player => {
        const save = player.getByRole('button', {name: 'Save as new generation', exact: true});
        await expect(save).toBeEnabled();
        await save.click();
        await expect(player.getByRole('status')).toHaveText('The adopted edits were saved as a new generation.');
        await expect(save).toBeDisabled();
        await player.getByRole('button', {name: 'Close', exact: true}).click();
    };
    await expect(paused).toBeVisible();
    await expect(save).toBeDisabled();
    await adopt(frame, 'move', '42');
    await frame.waitForFunction(() => window.vm.runtime.getSpriteTargetByName('Walker').x === 47);
    await saveGeneration(player);
    await open();
    const generations = candidate(1).getByRole('combobox', {name: /^Generation/});
    await generations.selectOption({label: 'Generation 2'});
    const saved = await startPlaytest(1, 2);
    await saved.frame.waitForFunction(() => window.vm.runtime.getSpriteTargetByName('Walker').x === 47);
    const stillPaused = saved.frame.getByText('The whole playtest is paused', {exact: true});
    await expect(stillPaused).toBeHidden();
    await saved.frame.locator('body').press('Space');
    await expect(stillPaused).toBeVisible();
    assert.equal(await saved.frame.evaluate(position), 47);
    await adopt(saved.frame, 'unvisited', '12');
    await saveGeneration(saved.player);

    await generations.selectOption({label: 'Generation 3'});
    const both = await startPlaytest(1, 3);
    await both.frame.waitForFunction(() => window.vm.runtime.getSpriteTargetByName('Walker').x === 47);
    await both.frame.locator('body').press('Space');
    await both.frame.waitForFunction(() => window.vm.runtime.getSpriteTargetByName('Walker').x > 47);
    await expect(both.frame.getByText('The whole playtest is paused', {exact: true})).toHaveCount(0);
    await both.player.getByRole('button', {name: 'Close', exact: true}).click();
    await generations.selectOption({label: 'Generation 1'});
    for (const number of [1, 2]) {
        const original = await startPlaytest(number, 1);
        await expect(original.frame.getByText('The whole playtest is paused', {exact: true})).toBeVisible();
        assert.equal(await original.frame.evaluate(position), 5);
        await original.player.getByRole('button', {name: 'Close', exact: true}).click();
    }
    assert.deepEqual(await fixture.snapshot(), before);
    assert.deepEqual(errors, []);
});
