import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium, expect} from '@playwright/test';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';

const origin = 'https://github.com/fixture/project';

async function open(t) {
    const server = await serveEditorRuntime({script: fileURLToPath(new URL('./connection-settings-page.js', import.meta.url))});
    t.after(() => server.close());
    const browser = await chromium.launch({headless: true});
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.route('**/*', route => new URL(route.request().url()).origin === new URL(server.url).origin ?
        route.continue() : route.abort());
    const errors = [];
    const newPage = async () => {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(server.url);
        await page.waitForFunction(() => typeof window.mountConnectionSettings === 'function');
        return page;
    };
    t.after(() => assert.deepEqual(errors, []));
    return newPage;
}

async function mount(page, options) {
    await page.evaluate(options => window.mountConnectionSettings(options), options);
    const label = options.dialog === 'preferences' ? 'GitHub connection settings' : 'Repository GitHub connection';
    const dialog = page.getByRole('dialog', {name: label, exact: true});
    await expect(dialog).toBeVisible();
    return dialog;
}

const preferred = dialog => dialog.getByRole('combobox', {name: 'Default connection mode', exact: true});
const status = dialog => dialog.getByRole('status');
const calls = page => page.evaluate(() => window.connectionFixture.calls);

test('connection preferences persist but fall back to the only available provider', async t => {
    const newPage = await open(t);
    const page = await newPage();
    const preferences = await mount(page, {dialog: 'preferences'});
    await expect(preferred(preferences)).toHaveValue('desktop');
    await expect(preferences.getByRole('checkbox')).toHaveCount(0);
    await expect(preferences.getByRole('button', {name: 'Connect to GitHub', exact: true})).toHaveCount(0);
    await preferred(preferences).selectOption('cloudflare');
    await preferences.getByRole('button', {name: 'Close', exact: true}).click();
    await expect(preferences).toHaveCount(0);

    await page.reload();
    const reloaded = await mount(page, {dialog: 'preferences'});
    await expect(preferred(reloaded)).toHaveValue('cloudflare');
    await preferred(reloaded).selectOption('desktop');

    const webOnly = await mount(await newPage(), {dialog: 'preferences', modes: ['cloudflare']});
    await expect(preferred(webOnly)).toHaveValue('cloudflare');
    await expect(preferred(webOnly).locator('option')).toHaveCount(1);
    const anotherDesktop = await mount(await newPage(), {dialog: 'preferences'});
    await expect(preferred(anotherDesktop)).toHaveValue('desktop');
});

test('the next-provider preference does not switch an active session', async t => {
    const newPage = await open(t);
    const page = await newPage();
    const repository = await mount(page, {dialog: 'repository', connected: true});
    await expect(repository.getByText('Connection mode · Desktop local')).toBeVisible();
    await expect(status(repository)).toHaveText('Connected');
    await expect(preferred(repository)).toHaveCount(0);

    const preferences = await mount(await newPage(), {dialog: 'preferences'});
    await preferred(preferences).selectOption('cloudflare');
    await expect(repository.getByText('Connection mode · Desktop local')).toBeVisible();
    await expect(status(repository)).toHaveText('Connected');
    assert.deepEqual(await calls(page), []);

    await repository.getByRole('button', {name: 'Disconnect', exact: true}).click();
    await expect(status(repository)).toHaveText('Disconnected');
    await expect(repository.getByText('Connection mode · Cloudflare')).toBeVisible();
    await repository.getByRole('button', {name: 'Connect to GitHub', exact: true}).click();
    await expect(status(repository)).toHaveText('Connected');
    assert.deepEqual(await calls(page), [['disconnect', 'desktop'], ['select', 'cloudflare'], ['connect', origin, false]]);
});

test('available Desktop methods gate connect and keep credentials out of the browser', async t => {
    const newPage = await open(t);
    const page = await newPage();
    const dialog = await mount(page, {dialog: 'repository'});
    const method = dialog.getByRole('combobox', {name: 'Authentication method', exact: true});
    const connect = dialog.getByRole('button', {name: 'Connect to GitHub', exact: true});
    await expect(method.locator('option')).toHaveCount(2);
    await expect(method.locator('option[value="github-app"]')).toHaveCount(0);
    await method.selectOption('git-credential-helper');
    const login = dialog.getByRole('textbox', {name: 'GitHub account name', exact: true});
    await expect(connect).toBeDisabled();
    await login.fill('   ');
    await expect(connect).toBeDisabled();
    await login.fill('  fixture  ');
    await page.evaluate(() => window.connectionFixture.failNext());
    await connect.click();
    await expect(dialog.getByRole('alert')).toContainText('Retry using the selected connection');
    await expect(status(dialog)).toHaveText('Disconnected');
    await expect(connect).toBeEnabled();

    await page.evaluate(() => window.connectionFixture.replaceMethods(['fine-grained-pat']));
    await expect(method).toHaveValue('fine-grained-pat');
    await expect(method.locator('option')).toHaveCount(1);
    await expect(login).toHaveCount(0);
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    await dialog.getByRole('checkbox', {name: 'Save the token on this device', exact: true}).check();
    await connect.click();
    await expect(status(dialog)).toHaveText('Connected');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    assert.deepEqual(await calls(page), [
        ['select', 'desktop'],
        ['connect', origin, false, false, {method: 'git-credential-helper', login: 'fixture'}],
        ['connect', origin, false, false, {method: 'fine-grained-pat', remember: true}]
    ]);
});
