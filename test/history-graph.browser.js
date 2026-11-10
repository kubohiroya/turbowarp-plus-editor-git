import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';
import {openRepository} from '../dist/repository.js';
import {directoryHandle} from './directory.js';

// Screenshots go where TWGIT_SCREENSHOTS points, when set.
const screenshots = process.env.TWGIT_SCREENSHOTS;

async function repository(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twgit-graph-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    let clock = 1_760_000_000;
    const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', env: {...process.env,
        GIT_AUTHOR_NAME: 'Hiroya', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Hiroya',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: `@${clock += 3600} +0900`, GIT_COMMITTER_DATE: `@${clock} +0900`}}).trimEnd();
    const commit = async message => {
        await fs.writeFile(path.join(root, 'notes.txt'), message + '\n');
        git('add', '.');
        git('commit', '-qm', message);
        return git('rev-parse', 'HEAD');
    };
    git('init', '-q', '-b', 'main');
    await commit('ネコのスプライトを追加');
    await commit('旗が押されたら歩く');
    git('switch', '-q', '-c', 'jump');
    await commit('スペースキーでジャンプ');
    await commit('ジャンプの高さを調整');
    git('switch', '-q', 'main');
    await commit('背景を夜にする');
    git('merge', '-q', '--no-ff', '-X', 'theirs', '-m', 'jump ブランチを取り込む', 'jump');
    git('switch', '-q', '-c', 'sound', 'HEAD~1');
    await commit('効果音を追加');
    git('update-ref', 'refs/remotes/origin/sound-remote', 'HEAD');
    git('switch', '-q', 'main');
    await commit('スコアを表示');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD~1');
    git('update-ref', 'refs/remotes/origin/score', 'HEAD');
    const repo = await openRepository(directoryHandle(root));
    const {branches} = await repo.read();
    return {commits: (await repo.history()).commits, branches};
}

test('the history graph draws lanes, moves with the keyboard and offers each commit\'s actions in Japanese', async t => {
    const {commits, branches} = await repository(t);
    const server = await serveEditorRuntime({script: fileURLToPath(new URL('./history-graph-page.js', import.meta.url))});
    const browser = await chromium.launch();
    t.after(async () => {await browser.close(); await server.close();});
    const context = await browser.newContext({viewport: {width: 480, height: 620}, locale: 'ja-JP', deviceScaleFactor: 2});
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: server.url});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    await page.goto(server.url);
    await page.evaluate(value => mountGraph(value), {commits, locale: 'ja', localBranches: branches});

    const rows = page.locator('.twgit-graph-commit');
    assert.equal(await rows.count(), commits.length);
    // Every row draws its lanes and a dot; the merge row draws two lines below its dot.
    assert.equal(await page.locator('.twgit-graph-row > svg[aria-hidden="true"]').count(), commits.length);
    assert.equal(await page.locator('.twgit-graph-row > svg circle').count(), commits.length);
    const merge = commits.findIndex(commit => commit.parents.length === 2);
    assert.ok(await page.locator('.twgit-graph-row').nth(merge).locator('path').count() >= 3);
    assert.ok(await page.locator('.twgit-graph-row > svg').first().evaluate(svg => svg.getBoundingClientRect().width) >= 28);
    // The accessible name has the subject, author, date and branches.
    const main = commits.findIndex(commit => commit.refs.some(ref => ref.name === 'main'));
    assert.match(await rows.nth(main).getAttribute('aria-label'), /^スコアを表示, Hiroya, .+, ブランチ: main \(現在\), origin\/score$/u);
    assert.equal(await page.getByRole('button', {name: 'さらに表示'}).count(), 1);

    // Tab enters the list at the first commit; arrows move, Enter and Space select.
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.oid), commits[0].oid);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press(' ');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.oid), commits.at(-1).oid);
    await page.keyboard.press('Home');
    assert.deepEqual(await page.evaluate(() => calls), [['select', commits[2].oid], ['select', commits[1].oid]]);
    assert.equal(await rows.nth(1).getAttribute('aria-pressed'), 'true');
    assert.equal(await rows.nth(2).getAttribute('aria-pressed'), 'false');
    // Only one row and its actions button are in the Tab order.
    assert.equal(await page.locator('.twgit-graph-commit[tabindex="0"]').count(), 1);

    const menuItems = async index => {
        await rows.nth(index).focus();
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-haspopup')), 'menu');
        await page.keyboard.press('Enter');
        const menu = page.getByRole('menu', {name: '操作'});
        await menu.waitFor();
        await page.waitForFunction(() => document.activeElement.getAttribute('role') === 'menuitem');
        return menu.getByRole('menuitem').allTextContents();
    };
    const closeMenu = async () => {
        await page.keyboard.press('Escape');
        assert.equal(await page.getByRole('menu').count(), 0);
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-haspopup')), 'menu');
    };
    // A commit with a local branch that is not the current one, and an origin branch without a local one.
    const sound = commits.findIndex(commit => commit.refs.some(ref => ref.name === 'sound'));
    assert.deepEqual(await menuItems(sound), ['ここからブランチを作る…', 'sound に切り替える', 'sound-remote を作って切り替える',
        'コミットの ID をコピー']);
    if (screenshots) await page.screenshot({path: path.join(screenshots, 'history-menu.png')});
    await closeMenu();
    // origin/score has no local branch; origin/main's commit has neither; main is current, so it is not offered.
    const score = commits.findIndex(commit => commit.refs.some(ref => ref.name === 'origin/score'));
    assert.deepEqual(await menuItems(score), ['ここからブランチを作る…', 'score を作って切り替える', 'コミットの ID をコピー']);
    // ArrowUp wraps to the last item; choosing copies the commit ID.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.getByRole('status').getByText('コミットの ID をコピーしました。').waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), commits[score].oid);
    const plain = commits.findIndex(commit => commit.refs.length === 0);
    assert.deepEqual(await menuItems(plain), ['ここからブランチを作る…', 'コミットの ID をコピー']);
    await closeMenu();

    // Create branch here: the name, then Enter, with "Switch to it" on by default.
    const sprite = commits.length - 1;
    await menuItems(sprite);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', {name: 'ここからブランチを作る…'});
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('checkbox', {name: '作ったら切り替える'}).isChecked(), true);
    await page.keyboard.type('from-start');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => calls.some(call => call[0] === 'createBranch'));
    assert.deepEqual((await page.evaluate(() => calls)).at(-1), ['createBranch', commits[sprite].oid, 'from-start', true]);
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.oid), commits[sprite].oid);
    // Switch and create from origin call through with the branch name.
    await menuItems(sound);
    await page.getByRole('menuitem', {name: 'sound に切り替える'}).click();
    await menuItems(score);
    await page.getByRole('menuitem', {name: 'score を作って切り替える'}).click();
    await page.getByRole('button', {name: 'さらに表示'}).click();
    assert.deepEqual((await page.evaluate(() => calls)).slice(-3), [['switchBranch', 'sound'], ['createFromRemote', 'score'], ['showMore']]);

    await page.locator('body').click({position: {x: 470, y: 600}});
    await rows.nth(1).focus();
    if (screenshots) await page.screenshot({path: path.join(screenshots, 'history-graph.png')});
    assert.deepEqual(errors, []);
});
