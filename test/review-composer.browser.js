import assert from 'node:assert/strict';
import {test} from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';

// Screenshots go where TWGIT_SCREENSHOTS points, when set.
const screenshots = process.env.TWGIT_SCREENSHOTS;
const head = 'b'.repeat(40);
const block = (opcode, {next = null, parent = null, inputs = {}, fields = {}, x = 0, y = 0} = {}) =>
    ({opcode, next, parent, inputs, fields, shadow: false, topLevel: parent === null, ...(parent === null ? {x, y} : {})});
const source = (name, blocks) => `${JSON.stringify({targets: [
    {isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {}, costumes: [], sounds: []},
    {isStage: false, name, variables: {}, lists: {}, broadcasts: {}, blocks, comments: {}, costumes: [], sounds: []}
]}, null, 2)}\n`;
const cat = {flag: block('event_whenflagclicked', {next: 'move'}), move: block('motion_movesteps', {parent: 'flag', inputs: {STEPS: [1, [4, '10']]}})};
const catAfter = structuredClone(cat);
catAfter.move.next = 'turn';
catAfter.turn = block('motion_turnright', {parent: 'move', inputs: {DEGREES: [1, [4, '15']]}});
const files = [{path: 'game/project.source.json', before: source('Cat', cat), after: source('Cat', catAfter)}];

async function open(t, locale) {
    const server = await serveEditorRuntime({script: fileURLToPath(new URL('./review-composer-page.js', import.meta.url))});
    const browser = await chromium.launch();
    t.after(async () => {await browser.close(); await server.close();});
    const page = await browser.newPage({viewport: {width: 940, height: 1000}, locale: locale === 'ja' ? 'ja-JP' : 'en-US', deviceScaleFactor: 2});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(server.url);
    await page.evaluate(value => mountReviewComposer(value), {files, locale, head});
    const script = page.locator('.twgit-review-script').first();
    await script.locator('summary').click();
    await script.locator('svg .blocklyBlockCanvas path.blocklyPath').first().waitFor({timeout: 10_000});
    return {page, script, fixture: () => page.evaluate(() => ({requests: reviewFixture.requests.map(request => request.operation),
        reviews: reviewFixture.reviews.length, pending: !!reviewFixture.pending, maxActive: reviewFixture.maxActive}))};
}

test('writes an overall and a code comment, shows where they go and sends them as one review', async t => {
    const {page, script, fixture} = await open(t, 'en');
    await script.getByRole('textbox', {name: 'Comment on this code'}).fill('Turn after moving, so the cat faces the wall.');
    const composer = page.getByRole('region', {name: 'Send a review'});
    await composer.getByRole('textbox', {name: 'Overall comment'}).fill('Thanks! One question about the turn.');
    await composer.getByRole('radio', {name: 'Request changes'}).check();
    const summary = composer.locator('[data-git-review-summary]');
    assert.equal(await summary.textContent(), '1 code comments go to their project.source.json as threads, and 0 go in the review body.');
    assert.match(await script.locator('summary').textContent(), /Commented/u);
    // The draft is kept in the browser without the connection's secrets.
    const stored = await page.evaluate(() => localStorage.getItem('turbowarp-plus-git:review-draft:fixture/work#7'));
    assert.match(stored, /Turn after moving/u);
    assert.doesNotMatch(stored, /rrrrrrrr|127\.0\.0\.1/u);
    if (screenshots) await page.screenshot({path: path.join(screenshots, 'review-composer.png'), fullPage: true});
    if (screenshots) await composer.screenshot({path: path.join(screenshots, 'review-send-summary.png')});

    await composer.getByRole('button', {name: 'Send Review'}).click();
    await composer.getByText('Sent the review.').waitFor();
    assert.deepEqual(await fixture(), {requests: ['pullRequestReviewContext', 'addPullRequestReview', 'addPullRequestReviewThread',
        'submitPullRequestReview'], reviews: 1, pending: false, maxActive: 1});
    assert.equal(await page.evaluate(() => localStorage.getItem('turbowarp-plus-git:review-draft:fixture/work#7')), null);
    await composer.getByRole('button', {name: 'Dismiss'}).click();
    assert.equal(await composer.getByText('Sent the review.').count(), 0);
});

test('shows a pending review left on GitHub in Japanese and discards it on request', async t => {
    const {page, script, fixture} = await open(t, 'ja');
    await page.evaluate(() => reviewFixture.faults.push({operation: 'addPullRequestReviewThread', status: 502, code: 'UPSTREAM_FAILURE'},
        {operation: 'deletePullRequestReview', status: 502, code: 'UPSTREAM_FAILURE'}));
    await script.getByRole('textbox', {name: 'このコードへのコメント'}).fill('回る前に少し待つとよさそうです。');
    const composer = page.getByRole('region', {name: 'レビューを送る'});
    await composer.getByRole('button', {name: 'レビューを送信'}).click();
    const alert = composer.getByRole('alert');
    await alert.waitFor();
    assert.match(await alert.textContent(), /GitHub に保留中のレビューが残っています/u);
    assert.equal(await composer.getByRole('button', {name: 'レビューを送信'}).count(), 0);
    assert.equal(await alert.getByRole('button', {name: '閉じる'}).getAttribute('title'), '閉じる');
    if (screenshots) await composer.screenshot({path: path.join(screenshots, 'review-pending-left.png')});
    assert.equal((await fixture()).pending, true);

    await composer.getByRole('button', {name: '保留中のレビューを破棄'}).click();
    await composer.getByText('保留中のレビューを破棄しました。書いた内容は残っています。').waitFor();
    assert.equal((await fixture()).pending, false);
    assert.equal(await script.getByRole('textbox', {name: 'このコードへのコメント'}).inputValue(), '回る前に少し待つとよさそうです。');
    assert.equal(await composer.getByRole('button', {name: 'レビューを送信'}).count(), 1);
});
