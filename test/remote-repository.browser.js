import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';
import {git, remote, startFixture} from './smart-http-fixture.js';

async function open(t, locale = 'en') {
    const fixture = await startFixture(t);
    const server = await serveEditorRuntime({script: fileURLToPath(new URL('./remote-repository-page.js', import.meta.url))});
    // The page reaches the fixture's proxy from its own origin.
    fixture.origins.add(new URL(server.url).origin);
    const browser = await chromium.launch({headless: true});
    t.after(async () => {await browser.close(); await server.close();});
    const page = await browser.newPage({viewport: {width: 800, height: 600}, locale: locale === 'ja' ? 'ja-JP' : 'en-US'});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(server.url);
    const openDialog = (options = {}) => page.evaluate(value => openDialog(value),
        {locale, deviceFolders: true, browserFolders: true, proxyOrigin: fixture.origin, ...options});
    const calls = () => page.evaluate(() => calls);
    const result = () => page.evaluate(() => result);
    const readFolder = name => page.evaluate(value => readFolder(value), name);
    return {fixture, page, openDialog, calls, result, readFolder};
}

async function publishProject({seed, bare}) {
    await mkdir(join(seed, 'assets'));
    await writeFile(join(seed, 'project.source.json'), '{"targets":[]}\n');
    await writeFile(join(seed, 'sb3-source.json'), '{"assets":"assets"}\n');
    await writeFile(join(seed, 'assets', 'costume.svg'), '<svg/>');
    git(seed, 'add', '-A');
    git(seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'add the project');
    git(seed, 'push', '-q', bare, 'main');
}

test('checks the URL first and, without device folders, offers only the browser with the reason', async t => {
    const {page, openDialog, calls, result} = await open(t);
    await openDialog({deviceFolders: false});
    const dialog = page.getByRole('dialog', {name: 'Open Remote Git Repository'});
    assert.equal(await dialog.getByRole('radio', {name: 'A folder on this device'}).isDisabled(), true);
    assert.equal(await dialog.getByRole('radio', {name: 'In this browser'}).isChecked(), true);
    await dialog.getByText('This browser cannot open folders on your device. Use Chrome or Edge, or open a folder saved in this browser.').waitFor();
    await dialog.getByLabel('Repository URL').fill('https://example.com/fixture/work');
    await dialog.getByRole('button', {name: 'Open', exact: true}).click();
    await dialog.getByRole('alert').filter({hasText: 'Enter a GitHub repository URL like https://github.com/owner/repository.'}).waitFor();
    await dialog.getByLabel('Repository URL').fill('https://github.com/fixture/work/tree/main');
    await dialog.getByRole('button', {name: 'Open', exact: true}).click();
    await dialog.getByRole('alert').waitFor();
    assert.deepEqual(await calls(), []);
    await dialog.getByRole('button', {name: 'Close'}).click();
    assert.equal(await result(), false);
    assert.equal(await page.getByRole('dialog').count(), 0);
});

test('prefills a catalog URL without connecting and does not report a cancelled project replacement as opened', async t => {
    const {fixture, page, openDialog, calls, result} = await open(t);
    await publishProject(fixture);
    await openDialog({initialRemote: remote, deviceFolders: false, openProjectResult: 'cancelled'});
    const dialog = page.getByRole('dialog', {name: 'Open Remote Git Repository'});
    assert.equal(await dialog.getByLabel('Repository URL').inputValue(), remote);
    assert.deepEqual(await calls(), []);
    await dialog.getByRole('button', {name: 'Open', exact: true}).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal((await calls()).some(call => call[0] === 'openProject'), true);
    assert.equal((await calls()).some(call => call[0] === 'closed'), false);
    await dialog.getByRole('button', {name: 'Close'}).click();
    assert.equal(await result(), false);
});

test('a repository without a project at its root shows the error and writes nothing', async t => {
    const {page, openDialog, calls, result, readFolder} = await open(t, 'ja');
    await openDialog();
    const dialog = page.getByRole('dialog', {name: 'Git のリモートリポジトリを開く'});
    assert.equal(await dialog.getByRole('radio', {name: '手元のフォルダ'}).isChecked(), true);
    await dialog.getByLabel('リポジトリの URL').fill('https://github.com/fixture/work');
    await dialog.getByRole('button', {name: '開く', exact: true}).click();
    const alert = page.getByRole('alertdialog', {name: 'このフォルダはプロジェクトフォルダではありません。'});
    await alert.waitFor();
    await alert.getByRole('button', {name: 'OK'}).click();
    assert.equal(await result(), false);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(await calls(), [['connect', remote, false], ['closed', false]]);
    assert.equal(await readFolder('device'), null);
});

test('opens a project repository saved in a folder on the device, then one saved in the browser', async t => {
    const {fixture, page, openDialog, calls, result, readFolder} = await open(t);
    await publishProject(fixture);
    await openDialog();
    const dialog = page.getByRole('dialog', {name: 'Open Remote Git Repository'});
    await dialog.getByLabel('Repository URL').fill('https://github.com/fixture/work');
    await dialog.getByRole('button', {name: 'Open', exact: true}).click();
    await dialog.getByText('Downloaded the repository. Choose an empty folder to save it in.').waitFor();
    // The folder is picked in its own click, after the download.
    assert.deepEqual(await calls(), [['connect', remote, false]]);
    await dialog.getByRole('button', {name: 'Choose a Folder…'}).click();
    assert.equal(await result(), true);
    assert.deepEqual(await calls(), [['connect', remote, false], ['pickDeviceFolder'], ['openProject', 'device'], ['closed', true]]);
    const device = await readFolder('device');
    assert.deepEqual(device.names, ['.git', 'assets', 'project.source.json', 'project.txt', 'sb3-source.json']);
    assert.equal(device.head, 'ref: refs/heads/main\n');

    // The connection is kept for the same repository, so the second open asks for nothing.
    await openDialog();
    await dialog.getByLabel('Repository URL').fill('https://github.com/fixture/work.git');
    await dialog.getByRole('radio', {name: 'In this browser'}).check();
    await dialog.getByRole('button', {name: 'Open', exact: true}).click();
    assert.equal(await result(), true);
    assert.deepEqual(await calls(), [['createBrowserFolder', 'work'], ['openProject', 'browser-work'], ['closed', true]]);
    assert.deepEqual((await readFolder('browser-work')).names, ['.git', 'assets', 'project.source.json', 'project.txt', 'sb3-source.json']);
});
