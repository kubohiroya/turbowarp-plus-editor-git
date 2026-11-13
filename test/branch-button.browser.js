import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';

// Screenshots go where TWGIT_SCREENSHOTS points, when set.
const screenshots = process.env.TWGIT_SCREENSHOTS;
const repository = {repository: true, branch: 'main', head: '1234567890abcdef1234567890abcdef12345678',
    branches: ['jump', 'main', 'sound'], remoteBranches: ['score'], writable: true, busy: false, project: true};
const noRepository = {repository: false, branch: undefined, head: null, branches: [], remoteBranches: [], writable: false, busy: false,
    project: false};

async function open(t, locale) {
    const server = await serveEditorRuntime({script: fileURLToPath(new URL('./branch-button-page.js', import.meta.url))});
    const browser = await chromium.launch();
    t.after(async () => {await browser.close(); await server.close();});
    const page = await browser.newPage({viewport: {width: 640, height: 420}, locale: locale === 'ja' ? 'ja-JP' : 'en-US', deviceScaleFactor: 2});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    // The snackbar's time runs on a clock the test moves.
    await page.clock.install();
    await page.goto(server.url);
    const mount = state => page.evaluate(value => mountBranchButton(value), {state, locale});
    const calls = () => page.evaluate(() => calls);
    const focused = () => page.evaluate(() => document.activeElement.textContent);
    t.after(() => assert.deepEqual(errors, []));
    return {page, mount, calls, focused};
}

test('the branch button lists the branches, moves with the keyboard and switches through the panel in Japanese', async t => {
    const {page, mount, calls, focused} = await open(t, 'ja');
    await mount(repository);
    const button = page.getByRole('button', {name: 'ブランチ: main'});
    assert.equal(await button.getAttribute('aria-haspopup'), 'menu');
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.match(await button.textContent(), /^main▾$/u);
    if (screenshots) await page.screenshot({path: path.join(screenshots, 'branch-button.png')});

    // ArrowDown opens the menu on the current branch; the arrows wrap, Home and End go to the ends.
    await button.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu', {name: 'ブランチ'});
    await menu.waitFor();
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await menu.locator('[role^="menuitem"]').allTextContents(),
        ['jump', '✓main', 'sound', 'score を作って切り替える', '新しいブランチ…', 'ローカル Git を開く']);
    assert.deepEqual(await menu.getByRole('menuitemradio').evaluateAll(items => items.map(item => item.getAttribute('aria-checked'))),
        ['false', 'true', 'false']);
    assert.equal(await focused(), '✓main');
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), 'sound');
    await page.keyboard.press('End');
    assert.equal(await focused(), 'ローカル Git を開く');
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), 'jump');
    await page.keyboard.press('ArrowUp');
    assert.equal(await focused(), 'ローカル Git を開く');
    await page.keyboard.press('Home');
    assert.equal(await focused(), 'jump');
    if (screenshots) await page.screenshot({path: path.join(screenshots, 'branch-menu.png')});
    // Escape closes the menu and returns to the button.
    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0);
    assert.equal(await button.evaluate(element => element === document.activeElement), true);

    // ArrowUp opens on the last item. Choosing the current branch only closes the menu.
    await page.keyboard.press('ArrowUp');
    assert.equal(await focused(), 'ローカル Git を開く');
    await page.keyboard.press('Enter');
    assert.deepEqual(await calls(), [['open']]);
    await button.click();
    await menu.getByRole('menuitemradio', {name: 'main'}).click();
    assert.equal(await menu.count(), 0);
    assert.deepEqual(await calls(), [['open']]);

    // A switch goes through the panel; its result shows in a snackbar, and the panel stays closed.
    const snackbar = page.locator('[data-git-snackbar]');
    await button.click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.deepEqual((await calls()).at(-1), ['switchBranch', 'sound']);
    await page.evaluate(() => finish({done: true}));
    await snackbar.getByRole('status').getByText('ブランチを切り替えました。').waitFor();
    // With a project folder selected, it offers the panel's Reload Project; focus stays on the button.
    const reload = snackbar.getByRole('button', {name: '作品を再読込'});
    assert.equal(await reload.count(), 1);
    assert.equal(await button.evaluate(element => element === document.activeElement), true);
    if (screenshots) await page.screenshot({path: path.join(screenshots, 'branch-snackbar.png')});
    // Tab reaches its buttons; while focused it stays, and it hides after six seconds once left alone.
    await page.keyboard.press('Tab');
    assert.equal(await reload.evaluate(element => element === document.activeElement), true);
    await page.clock.runFor(7000);
    assert.equal(await snackbar.count(), 1);
    await page.keyboard.press('Tab');
    assert.equal(await snackbar.getByRole('button', {name: '閉じる'}).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    await reload.click();
    await snackbar.waitFor({state: 'detached'});
    assert.deepEqual((await calls()).at(-1), ['reload']);
    assert.equal(await button.evaluate(element => element === document.activeElement), true);
    // A refused switch tells the panel's reason as an alert, with a way to open the panel.
    await button.click();
    await menu.getByRole('menuitemradio', {name: 'jump'}).click();
    await page.evaluate(() => finish({done: false, error: 'ブランチを切り替える前に、実行を止めてください。'}));
    await snackbar.getByRole('alert').getByText('ブランチを切り替える前に、実行を止めてください。').waitFor();
    assert.equal(await snackbar.getByRole('button', {name: '作品を再読込'}).count(), 0);
    await snackbar.getByRole('button', {name: 'ローカル Git を開く'}).click();
    await snackbar.waitFor({state: 'detached'});
    assert.deepEqual((await calls()).slice(-2), [['switchBranch', 'jump'], ['open']]);
    // A switch cancelled at the panel's question tells nothing.
    await button.click();
    await menu.getByRole('menuitemradio', {name: 'jump'}).click();
    await page.evaluate(() => finish({done: false}));
    await menu.waitFor({state: 'detached'});
    await page.clock.runFor(100);
    assert.equal(await snackbar.count(), 0);
    // Without a project folder there is nothing to reload; a new result replaces the old, and hides by itself.
    await mount({...repository, project: false});
    await button.click();
    await menu.getByRole('menuitem', {name: 'score を作って切り替える'}).click();
    await page.evaluate(() => finish({done: true}));
    await snackbar.getByText('ブランチを切り替えました。').waitFor();
    assert.deepEqual(await snackbar.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), ['閉じる']);
    assert.equal(await snackbar.locator('button.twgit-close svg').count(), 1);
    assert.deepEqual((await calls()).at(-1), ['createFromRemote', 'score']);
    await page.clock.runFor(5000);
    assert.equal(await snackbar.count(), 1);
    await page.clock.runFor(1500);
    await snackbar.waitFor({state: 'detached'});
    // Hovering keeps it; Escape on it closes it and returns to the button.
    await button.click();
    await menu.getByRole('menuitemradio', {name: 'sound'}).click();
    await page.evaluate(() => finish({done: false, error: '最初の理由'}));
    await snackbar.getByText('最初の理由').waitFor();
    await button.click();
    await menu.getByRole('menuitemradio', {name: 'sound'}).click();
    await page.evaluate(() => finish({done: false, error: '次の理由'}));
    await snackbar.getByText('次の理由').waitFor();
    assert.equal(await snackbar.count(), 1);
    await snackbar.hover();
    await page.clock.runFor(7000);
    assert.equal(await snackbar.count(), 1);
    await snackbar.getByRole('button', {name: 'ローカル Git を開く'}).focus();
    await page.keyboard.press('Escape');
    await snackbar.waitFor({state: 'detached'});
    assert.equal(await button.evaluate(element => element === document.activeElement), true);
    assert.deepEqual((await calls()).filter(call => call[0] === 'open'), [], 'Escape runs no action');
    await mount(repository);

    // New Branch: a small form at HEAD, with "Switch to it" on. A refused name stays to be corrected.
    await button.click();
    await menu.getByRole('menuitem', {name: '新しいブランチ…'}).click();
    const dialog = page.getByRole('dialog', {name: '新しいブランチ'});
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('checkbox', {name: '作ったら切り替える'}).isChecked(), true);
    const input = dialog.getByRole('textbox', {name: '新しいブランチの名前'});
    assert.equal(await input.evaluate(element => element === document.activeElement), true);
    await page.keyboard.type('main');
    await page.keyboard.press('Enter');
    assert.deepEqual((await calls()).at(-1), ['createBranch', 'main', true]);
    assert.equal(await input.isDisabled(), true);
    await page.evaluate(() => finish({done: false, error: '同じ名前のブランチがすでにあります。'}));
    await dialog.getByRole('alert').getByText('同じ名前のブランチがすでにあります。').waitFor();
    await page.waitForFunction(() => document.activeElement.matches('[role="dialog"] input:not([type])') &&
        document.activeElement.selectionEnd === 4);
    await page.keyboard.type('title-screen');
    await dialog.getByRole('checkbox').uncheck();
    await dialog.getByRole('button', {name: 'ブランチを作る'}).click();
    assert.deepEqual((await calls()).at(-1), ['createBranch', 'title-screen', false]);
    await page.evaluate(() => finish({done: true}));
    await dialog.waitFor({state: 'detached'});
    // Created without switching: the snackbar says so, and the panel stays closed.
    await snackbar.getByRole('status').getByText('ブランチを作りました。').waitFor();
    assert.deepEqual((await calls()).at(-1), ['createBranch', 'title-screen', false]);
    assert.equal(await button.evaluate(element => element === document.activeElement), true);
    await snackbar.getByRole('button', {name: '閉じる'}).click();
    // Escape cancels the form.
    await button.click();
    await menu.getByRole('menuitem', {name: '新しいブランチ…'}).click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({state: 'detached'});

    // While the panel is busy, the branches cannot be chosen.
    await mount({...repository, busy: true});
    await button.click();
    assert.deepEqual(await menu.locator('[aria-disabled="true"]').allTextContents(),
        ['jump', 'sound', 'score を作って切り替える', '新しいブランチ…']);
    await menu.getByRole('menuitemradio', {name: 'jump'}).click({force: true});
    assert.deepEqual(await calls(), []);
    // A click elsewhere closes the menu.
    await page.mouse.click(20, 300);
    await menu.waitFor({state: 'detached'});
});

test('the branch button tells each repository state apart, and only lists the branches without writes', async t => {
    const {page, mount, calls} = await open(t, 'ja');
    // No repository: "Git", which offers to choose one.
    await mount(noRepository);
    const git = page.getByRole('button', {name: 'ローカル Git'});
    assert.match(await git.textContent(), /^Git▾$/u);
    await git.click();
    const menu = page.getByRole('menu', {name: 'ブランチ'});
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['リポジトリを選択…', 'ローカル Git を開く']);
    await page.keyboard.press('Enter');
    assert.deepEqual(await calls(), [['choose']]);

    // A detached HEAD shows its short commit ID; no branch is current.
    await mount({...repository, branch: undefined});
    const detached = page.getByRole('button', {name: 'ブランチ未選択の HEAD: 1234567'});
    await detached.click();
    assert.deepEqual(await menu.getByRole('menuitemradio').evaluateAll(items => items.map(item => item.getAttribute('aria-checked'))),
        ['false', 'false', 'false']);
    await page.keyboard.press('Escape');

    // A branch without records yet says so, and offers no new branch, since there is no commit to start one at.
    await mount({...repository, head: null, branches: [], remoteBranches: []});
    const unborn = page.getByRole('button', {name: 'ブランチ: main (まだ記録がありません)'});
    assert.match(await unborn.textContent(), /^mainまだ記録がありません▾$/u);
    await unborn.click();
    assert.deepEqual(await menu.locator('[role^="menuitem"]').allTextContents(), ['ローカル Git を開く']);
    await page.keyboard.press('Escape');

    // Without writes, the branches are listed but cannot be chosen, and nothing creates one.
    await mount({...repository, writable: false});
    await page.getByRole('button', {name: 'ブランチ: main'}).click();
    assert.deepEqual(await menu.locator('[role^="menuitem"]').allTextContents(), ['jump', '✓main', 'sound', 'ローカル Git を開く']);
    assert.equal(await menu.locator('[role="menuitemradio"][aria-disabled="true"]').count(), 3);
    await menu.getByRole('menuitemradio', {name: 'sound'}).click({force: true});
    assert.deepEqual(await calls(), []);
    assert.equal(await menu.count(), 1);
});

test('the branch button speaks English', async t => {
    const {page, mount} = await open(t, 'en');
    await mount(repository);
    await page.getByRole('button', {name: 'Branch: main'}).click();
    assert.deepEqual(await page.getByRole('menu', {name: 'Branches'}).locator('[role^="menuitem"]').allTextContents(),
        ['jump', '✓main', 'sound', 'Create and switch to score', 'New Branch…', 'Open Local Git']);
    await page.getByRole('menuitemradio', {name: 'jump'}).click();
    await page.evaluate(() => finish({done: true}));
    const snackbar = page.locator('[data-git-snackbar]');
    await snackbar.getByText('Switched branches.').waitFor();
    assert.deepEqual(await snackbar.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label') ?? button.textContent)),
        ['Reload Project', 'Close']);
    await mount(noRepository);
    await page.getByRole('button', {name: 'Local Git'}).click();
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Choose Repository…', 'Open Local Git']);
});

test('the branch button shares the panel\'s repository, switches as the panel does and follows other tools', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twgit-entry-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', env: {...process.env,
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid'}}).trim();
    git('init', '-q', '-b', 'main');
    await fs.writeFile(path.join(root, 'notes.txt'), 'main\n');
    git('add', '.');
    git('commit', '-qm', 'first');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('branch', 'jump');
    git('update-ref', 'refs/remotes/origin/score', 'HEAD');
    for (const panelFirst of [false, true]) {
        const server = await serveEditorRuntime({script: fileURLToPath(new URL('./branch-entry-page.js', import.meta.url))});
        // Writes to a dropped directory need these, as in the Editor's browser tests.
        const args = ['--enable-experimental-web-platform-features'];
        if (process.platform === 'darwin') args.push('--single-process', '--no-zygote', '--disable-crash-reporter');
        const browser = await chromium.launch({args});
        try {
            const page = await browser.newPage({viewport: {width: 900, height: 700}});
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
            await page.goto(server.url);
            await page.evaluate(options => mountEntry(options), {locale: 'en', writable: true, panelFirst});
            const cdp = await page.context().newCDPSession(page);
            for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', {
                type, x: 100, y: 100, data: {items: [], files: [root], dragOperationsMask: 1}});
            await page.waitForFunction(() => window.directoryReady);
            const panel = page.getByRole('dialog', {name: 'Local Git'});
            const menu = page.getByRole('menu', {name: 'Branches'});
            // Choose Repository… from the button picks the repository and opens the panel on it.
            await page.getByRole('button', {name: 'Local Git', exact: true}).click();
            await menu.getByRole('menuitem', {name: 'Choose Repository…'}).click();
            await panel.getByText('Repository · ' + path.basename(root)).waitFor();
            await page.getByRole('button', {name: 'Branch: main', exact: true}).waitFor();
            const changes = panel.getByRole('tab', {name: 'Changes'});
            const history = panel.getByRole('tab', {name: 'History'});
            const github = panel.getByRole('tab', {name: 'GitHub'});
            const currentStep = panel.getByRole('list', {name: 'Work steps'}).locator('[aria-current="step"]');
            assert.equal(await changes.getAttribute('aria-selected'), 'true');
            await page.evaluate(() => host.setDirty(true));
            await currentStep.getByText('Save project').waitFor();
            await fs.writeFile(path.join(root, 'notes.txt'), `Updated ${panelFirst}\n`);
            await page.evaluate(() => host.setDirty(false));
            await panel.getByRole('button', {name: 'Refresh', exact: true}).click();
            await currentStep.getByText('Review changes').waitFor();
            const notes = panel.locator('[data-git-group="unstaged"]').filter({hasText: 'notes.txt'});
            await notes.locator('[data-git-file-kind="text"]').waitFor();
            await notes.locator('[data-git-status="unstaged"]').getByText('Unstaged').waitFor();
            await notes.click();
            const workingDiff = panel.locator('.twgit-diff .diff').getByText(`Updated ${panelFirst}`, {exact: true});
            await workingDiff.waitFor();
            assert.equal(await panel.getByRole('button', {name: 'Switch: jump'}).count(), 0);
            await changes.press('End');
            assert.equal(await github.getAttribute('aria-selected'), 'true');
            await panel.getByRole('tabpanel', {name: 'GitHub'}).getByText('GitHub sync is unavailable in this Editor.').waitFor();
            await github.press('ArrowLeft');
            assert.equal(await history.getAttribute('aria-selected'), 'true');
            await panel.getByRole('button', {name: /^first, /}).click();
            const committedNotes = panel.locator('[data-git-group="commit"]').filter({hasText: 'notes.txt'});
            await committedNotes.locator('[data-git-status="commit"]').getByText('Committed').waitFor();
            await committedNotes.click();
            await panel.locator('.twgit-diff .diff').getByText('main', {exact: true}).waitFor();
            await changes.click();
            await workingDiff.waitFor();
            await history.click();
            await panel.locator('.twgit-diff .diff').getByText('main', {exact: true}).waitFor();
            await changes.click();
            await panel.getByRole('button', {name: 'Add to Next Record: notes.txt'}).click();
            await currentStep.getByText('Record locally').waitFor();
            await panel.getByLabel('Message for this record').fill('Record the saved notes');
            await panel.getByRole('button', {name: 'Record (Commit)'}).click();
            await panel.getByText('Recorded the changes (commit).').waitFor();
            assert.equal(git('log', '-1', '--format=%s'), 'Record the saved notes');
            assert.equal(await currentStep.count(), 0);
            await history.click();
            // A switch from the panel moves the button.
            await panel.getByRole('button', {name: 'Switch: jump'}).click();
            await page.getByRole('button', {name: 'Branch: jump', exact: true}).waitFor();
            assert.equal(git('branch', '--show-current'), 'jump');
            await panel.getByRole('button', {name: 'Close', exact: true}).click();
            await panel.waitFor({state: 'detached'});
            // With the panel closed, the button follows branches another tool creates and switches to.
            git('branch', 'from-cli');
            git('switch', '-q', 'from-cli');
            await page.getByRole('button', {name: 'Branch: from-cli', exact: true}).waitFor({timeout: 10_000});
            // A switch from the button goes through the panel's checks: unsaved edits refuse it, and a snackbar tells why.
            const snackbar = page.locator('[data-git-snackbar]');
            await page.evaluate(() => {host.dirty = true;});
            await page.getByRole('button', {name: 'Branch: from-cli', exact: true}).click();
            await menu.getByRole('menuitemradio', {name: 'main', exact: true}).click();
            await snackbar.getByRole('alert').getByText('Stop the project, and save or record (or undo) every change, before switching branches.').waitFor();
            assert.equal(git('branch', '--show-current'), 'from-cli');
            assert.equal(await panel.count(), 0);
            // Its action opens the panel, which shows the same reason.
            await snackbar.getByRole('button', {name: 'Open Local Git'}).click();
            await panel.getByText('Stop the project, and save or record (or undo) every change, before switching branches.').waitFor();
            await panel.getByRole('button', {name: 'Close', exact: true}).click();
            await page.evaluate(() => {host.dirty = false;});
            await page.getByRole('button', {name: 'Branch: from-cli', exact: true}).click();
            await menu.getByRole('menuitemradio', {name: 'main', exact: true}).click();
            await snackbar.getByRole('status').getByText('Switched branches.').waitFor();
            await page.getByRole('button', {name: 'Branch: main', exact: true}).waitFor();
            assert.equal(git('branch', '--show-current'), 'main');
            assert.equal(await panel.count(), 0);
            // No project folder is selected, so there is nothing to reload.
            assert.equal(await snackbar.getByRole('button', {name: 'Reload Project'}).count(), 0);
            // Create and switch to an origin branch.
            await page.getByRole('button', {name: 'Branch: main', exact: true}).click();
            await menu.getByRole('menuitem', {name: 'Create and switch to score'}).click();
            await page.getByRole('button', {name: 'Branch: score', exact: true}).waitFor();
            assert.equal(git('branch', '--show-current'), 'score');
            await snackbar.getByRole('button', {name: 'Close'}).click();
            git('switch', '-q', 'main');
            git('branch', '-q', '-D', 'score', 'from-cli');
            // Disposing the panel removes the button.
            await page.evaluate(() => panel.dispose());
            await page.locator('.twgit-branch-button').waitFor({state: 'detached'});
            assert.deepEqual(errors, []);
        } finally {
            await browser.close();
            await server.close();
        }
    }
});
