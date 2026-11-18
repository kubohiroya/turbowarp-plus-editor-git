import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {webkit} from '@playwright/test';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';

// WebKit has no folder picker, as in Safari. Its origin private file system needs a persistent profile.
test('without the folder picker, the panel commits in a repository the host chooses from the browser\'s storage', async t => {
    const server = await serveEditorRuntime({script: fileURLToPath(new URL('./browser-storage-page.js', import.meta.url))});
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'twgit-webkit-'));
    const context = await webkit.launchPersistentContext(profile, {viewport: {width: 900, height: 700}});
    t.after(async () => {
        await context.close();
        await server.close();
        await fs.rm(profile, {recursive: true, force: true});
    });
    const page = context.pages()[0] ?? await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    await page.goto(server.url);
    assert.equal(await page.evaluate(() => typeof window.showDirectoryPicker), 'undefined');
    assert.equal(await page.evaluate(() => mountBrowserStorage()), true);
    const panelDialog = page.getByRole('dialog', {name: 'Local Git'});
    // Choose Repository… in the side panel's setup asks the host, which has no folder picker to call.
    await page.locator('#side').getByRole('button', {name: 'Choose Repository…'}).click();
    await panelDialog.getByText('Repository: twgit-test').waitFor();
    assert.equal(await page.evaluate(() => chosen), 1);
    await page.evaluate(() => writeNotes('second\n'));
    await panelDialog.getByRole('button', {name: 'Refresh local status', exact: true}).click();
    const changes = panelDialog.getByRole('list', {name: 'Local Git views'}).getByRole('button', {name: 'Commit saved changes', exact: true});
    await changes.click();
    await panelDialog.getByRole('checkbox', {name: 'Include in commit: notes.txt'}).check();
    await panelDialog.getByLabel('Commit message').fill('Record the notes in the browser');
    await panelDialog.getByRole('button', {name: 'Commit', exact: true}).click();
    await panelDialog.getByText('Recorded the changes (commit).').waitFor();
    assert.deepEqual(errors, []);
});
