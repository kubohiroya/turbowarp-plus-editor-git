import assert from 'node:assert/strict';
import {beforeEach, test} from 'node:test';
import {
    checkReview, createGitHubReviewApi, discardReview, emptyReviewDraft, forgetReviewSubmission, planReview, probeReviewRoutes,
    readReviewDraft, reviewRoute, sendReview, writeReviewDraft
} from '@kubohiroya/turbowarp-plus-editor-git/project-source-diff';
import {createReviewFixture, reviewRemote, reviewSession} from './github-review-fixture.js';

const store = new Map();
Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
}});
beforeEach(() => store.clear());

const head = 'b'.repeat(40);
const name = 'fixture/work#42';
const game = 'game/project.source.json', quiz = 'quiz/project.source.json', other = 'other/project.source.json';
const key = (file, sprite, id) => JSON.stringify([file, false, sprite, id]);
const comment = (file, sprite, id, body) => [key(file, sprite, id), {file, heading: `${sprite} · When green flag clicked · ${id}`, body}];

function draft(overrides = {}) {
    return {...emptyReviewDraft(), body: 'Looks good overall.', comments: Object.fromEntries([
        comment(game, 'Cat', 'a1', 'Move this after the wait.'),
        comment(quiz, 'Dog', 'b2', 'Ask the question once.')
    ]), ...overrides};
}

function setup(options = {}) {
    const fixture = createReviewFixture({head, ...options});
    const sessions = [];
    const api = createGitHubReviewApi({remote: reviewRemote, fetch: fixture.fetch, getSession: async (...args) => {
        sessions.push(args);
        return reviewSession();
    }});
    const target = {api, name, number: 42, head, changedFiles: [game, quiz, 'game/assets/cat.svg']};
    return {fixture, api, target, sessions, steps: () => fixture.requests.map(request => request.operation)};
}

test('plans threads for changed project files, up to 50, and puts the rest in the body', () => {
    const many = Object.fromEntries(Array.from({length: 52}, (_, index) => comment(game, 'Cat', 'x' + String(index).padStart(2, '0'), 'n' + index)));
    const plan = planReview({...emptyReviewDraft(), body: 'Overall', comments: {
        ...many, ...Object.fromEntries([comment(other, 'Bird', 'c3', 'Not in this pull request.'), comment(quiz, 'Dog', 'd4', '   ')])
    }}, {threads: true, changedFiles: [game, quiz]});
    assert.equal(plan.threads.length, 50);
    assert.ok(plan.threads.every(thread => thread.path === game));
    assert.equal(plan.threads[0].body, '**Cat · When green flag clicked · x00**\n\nn0');
    assert.deepEqual(plan.inBody.map(item => item.comment.body), ['n50', 'n51', 'Not in this pull request.']);
    assert.equal(plan.body, 'Overall\n\n---\n\n**game/project.source.json · Cat · When green flag clicked · x50**\n\nn50\n\n' +
        '**game/project.source.json · Cat · When green flag clicked · x51**\n\nn51\n\n' +
        '**other/project.source.json · Bird · When green flag clicked · c3**\n\nNot in this pull request.');
    const bodyOnly = planReview(draft(), {threads: false, changedFiles: [game, quiz]});
    assert.equal(bodyOnly.threads.length, 0);
    assert.equal(bodyOnly.inBody.length, 2);
});

test('sends a review in three steps, one at a time, and removes the draft', async () => {
    const {fixture, target, sessions, steps} = setup({delay: 1});
    writeReviewDraft(name, draft({event: 'APPROVE'}));
    const result = await sendReview(target);
    assert.equal(result.outcome, 'submitted');
    assert.match(result.url, /^https:\/\/github\.com\/fixture\/work\/pull\/42#pullrequestreview-/u);
    assert.deepEqual(steps(), ['addPullRequestReview', 'addPullRequestReviewThread', 'addPullRequestReviewThread', 'submitPullRequestReview']);
    assert.equal(fixture.maxActive, 1);
    const ids = new Set(fixture.requests.map(request => request.submitId));
    assert.equal(ids.size, 1);
    assert.deepEqual(fixture.requests.map(request => request.body), [
        {number: 42, commitOid: head},
        {number: 42, threadIndex: 0, path: game, body: '**Cat · When green flag clicked · a1**\n\nMove this after the wait.'},
        {number: 42, threadIndex: 1, path: quiz, body: '**Dog · When green flag clicked · b2**\n\nAsk the question once.'},
        {number: 42, threadCount: 2, event: 'APPROVE', body: 'Looks good overall.'}
    ]);
    assert.deepEqual(fixture.requests[0].init, {credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer'});
    assert.ok(sessions.every(args => args[0] === reviewRemote && args[1] === false && args[2] === true));
    assert.equal(fixture.reviews.length, 1);
    assert.equal(fixture.reviews[0].threads.length, 2);
    assert.equal(fixture.reviews[0].state, 'APPROVED');
    assert.equal(store.size, 0);
});

test('keeps no token, proxy address or GitHub ID in the stored draft', async () => {
    const {fixture, target} = setup();
    writeReviewDraft(name, draft());
    fixture.faults.push({operation: 'submitPullRequestReview', status: 502, code: 'UPSTREAM_FAILURE'});
    await sendReview(target);
    const stored = [...store.values()].join('\n');
    assert.doesNotMatch(stored, /rrrrrrrrrr|127\.0\.0\.1|Bearer|"P[0-9]|"R[0-9]/u);
    assert.deepEqual(Object.keys(JSON.parse(stored).submit).sort(), ['commitOid', 'id', 'route', 'state', 'threadKeys']);
});

test('does not start when a pending review exists on GitHub, and keeps the draft', async () => {
    const {fixture, target, steps} = setup();
    fixture.pending = {id: 'P0', commitOid: head, body: '', threads: [{path: game, body: 'from GitHub'}]};
    writeReviewDraft(name, draft());
    const result = await sendReview(target);
    assert.deepEqual(result, {outcome: 'not-sent', code: 'PENDING_REVIEW_EXISTS'});
    assert.deepEqual(steps(), ['addPullRequestReview']);
    assert.equal(readReviewDraft(name).submit, undefined);
    assert.equal(readReviewDraft(name).body, 'Looks good overall.');
    assert.equal(fixture.pending.id, 'P0');
});

test('discards the pending review when GitHub refuses a thread, and moves that file to the body', async () => {
    const {fixture, target, steps} = setup();
    writeReviewDraft(name, draft());
    fixture.faults.push({operation: 'addPullRequestReviewThread', status: 422, code: 'REVIEW_THREAD_REJECTED'});
    const result = await sendReview(target);
    assert.deepEqual(result, {outcome: 'not-sent', code: 'REVIEW_THREAD_REJECTED'});
    assert.deepEqual(steps(), ['addPullRequestReview', 'addPullRequestReviewThread', 'deletePullRequestReview']);
    assert.equal(fixture.pending, null);
    const kept = readReviewDraft(name);
    assert.equal(kept.submit, undefined);
    assert.deepEqual(kept.inBody, [game]);
    assert.equal(Object.keys(kept.comments).length, 2);

    // Sending again puts the refused file's comment in the body.
    fixture.requests.length = 0;
    assert.equal((await sendReview(target)).outcome, 'submitted');
    assert.deepEqual(steps(), ['addPullRequestReview', 'addPullRequestReviewThread', 'submitPullRequestReview']);
    assert.equal(fixture.requests[1].body.path, quiz);
    assert.match(fixture.requests[2].body.body, /\*\*game\/project\.source\.json · Cat · When green flag clicked · a1\*\*/u);
    assert.equal(fixture.requests[2].body.threadCount, 1);
});

test('reports a pending review left on GitHub when discarding fails, and discards it later', async () => {
    const {fixture, target, steps} = setup();
    writeReviewDraft(name, draft());
    fixture.faults.push({operation: 'addPullRequestReviewThread', status: 502, code: 'UPSTREAM_FAILURE'},
        {operation: 'deletePullRequestReview', status: 429, code: 'RATE_LIMITED', retryAfter: 30});
    const result = await sendReview(target);
    assert.deepEqual(result, {outcome: 'left', code: 'PENDING_REVIEW_LEFT', retryAfter: 30});
    assert.equal(readReviewDraft(name).submit.state, 'left');
    assert.ok(fixture.pending);
    // Sending is refused until the pending review is gone.
    assert.deepEqual(await sendReview(target), {outcome: 'left', code: 'PENDING_REVIEW_LEFT'});
    assert.deepEqual(steps(), ['addPullRequestReview', 'addPullRequestReviewThread', 'deletePullRequestReview']);
    assert.deepEqual(await discardReview(target), {outcome: 'not-sent'});
    assert.equal(fixture.pending, null);
    assert.equal(readReviewDraft(name).submit, undefined);
    assert.equal(readReviewDraft(name).body, 'Looks good overall.');
});

test('keeps a pending review after the last step is refused and sends it again only when asked', async () => {
    const {fixture, target, steps} = setup();
    writeReviewDraft(name, draft({event: 'APPROVE'}));
    fixture.faults.push({operation: 'submitPullRequestReview', status: 422, code: 'REVIEW_REJECTED'});
    const result = await sendReview(target);
    assert.deepEqual(result, {outcome: 'pending', code: 'REVIEW_REJECTED'});
    const kept = readReviewDraft(name);
    assert.equal(kept.submit.state, 'pending');
    assert.equal(kept.submit.threadKeys.length, 2);
    assert.ok(fixture.pending);
    assert.equal(fixture.reviews.length, 0);

    // The person changes the event and sends the last step again under the same ID; the threads are not repeated.
    writeReviewDraft(name, {...kept, event: 'COMMENT', comments: {...kept.comments, ...Object.fromEntries([
        comment(game, 'Cat', 'z9', 'Added after the threads.')])}});
    fixture.requests.length = 0;
    const again = await sendReview(target);
    assert.equal(again.outcome, 'submitted');
    assert.deepEqual(steps(), ['submitPullRequestReview']);
    assert.equal(fixture.requests[0].submitId, kept.submit.id);
    assert.equal(fixture.requests[0].body.event, 'COMMENT');
    assert.equal(fixture.requests[0].body.threadCount, 2);
    assert.match(fixture.requests[0].body.body, /Added after the threads\./u);
    assert.equal(fixture.reviews.length, 1);
});

test('never sends the last step again when its outcome is unknown, and checks it', async t => {
    for (const [name_, apply, then, outcome] of [
        ['published', true, undefined, 'submitted'],
        ['still pending', false, undefined, 'pending'],
        ['discarded on GitHub', false, fixture => {fixture.pending = null;}, 'closed']
    ]) {
        await t.test(name_, async () => {
            store.clear();
            const {fixture, target, steps} = setup();
            writeReviewDraft(name, draft());
            fixture.faults.push({operation: 'submitPullRequestReview', status: 504, code: 'UPSTREAM_TIMEOUT', apply, then});
            assert.deepEqual(await sendReview(target), {outcome: 'unknown', code: 'REVIEW_OUTCOME_UNKNOWN'});
            assert.equal(readReviewDraft(name).submit.state, 'submit-unknown');
            // Sending does not repeat it.
            assert.deepEqual(await sendReview(target), {outcome: 'unknown', code: 'REVIEW_OUTCOME_UNKNOWN'});
            assert.equal(steps().filter(step => step === 'submitPullRequestReview').length, 1);
            const checked = await checkReview(target);
            assert.equal(checked.outcome, outcome);
            assert.equal(steps().at(-1), 'pullRequestReviewContext');
            const kept = readReviewDraft(name);
            if (outcome === 'submitted') assert.equal(store.size, 0);
            else assert.equal(kept.body, 'Looks good overall.');
            if (outcome === 'pending') assert.equal(kept.submit.state, 'pending');
            if (outcome === 'closed') assert.equal(kept.submit, undefined);
            assert.equal(fixture.reviews.length, outcome === 'submitted' ? 1 : 0);
        });
    }
});

test('a reload while a step was out reads as unknown', async () => {
    const {target} = setup();
    writeReviewDraft(name, {...draft(), submit: {id: crypto.randomUUID(), commitOid: head, route: 'threads', state: 'submitting',
        threadKeys: []}});
    assert.equal(readReviewDraft(name).submit.state, 'submit-unknown');
    assert.deepEqual(await sendReview(target), {outcome: 'unknown', code: 'REVIEW_OUTCOME_UNKNOWN'});
});

test('treats a duplicate answer as unknown: a lost first step is checked and its pending review discarded', async () => {
    const {fixture, target, steps} = setup();
    writeReviewDraft(name, draft());
    fixture.faults.push({operation: 'addPullRequestReview', status: 409, code: 'REVIEW_DUPLICATE', apply: true});
    const result = await sendReview(target);
    assert.deepEqual(result, {outcome: 'not-sent', code: 'REVIEW_DUPLICATE'});
    assert.deepEqual(steps(), ['addPullRequestReview', 'pullRequestReviewContext', 'deletePullRequestReview']);
    assert.equal(fixture.pending, null);
    assert.equal(readReviewDraft(name).submit, undefined);
});

test('a lost answer to the last step is unknown, and the check finds the published review', async () => {
    const {fixture, target} = setup();
    writeReviewDraft(name, draft());
    fixture.faults.push({operation: 'submitPullRequestReview', network: true});
    assert.deepEqual(await sendReview(target), {outcome: 'unknown', code: 'REVIEW_OUTCOME_UNKNOWN'});
    assert.equal(fixture.reviews.length, 1);
    assert.equal((await checkReview(target)).outcome, 'submitted');
    assert.equal(store.size, 0);
});

test('reports a rate limit with its wait, and discards a pending review it stopped', async () => {
    const {fixture, target, steps} = setup();
    writeReviewDraft(name, draft());
    fixture.faults.push({operation: 'addPullRequestReview', status: 429, code: 'RATE_LIMITED', retryAfter: 42});
    assert.deepEqual(await sendReview(target), {outcome: 'not-sent', code: 'RATE_LIMITED', retryAfter: 42});
    assert.deepEqual(steps(), ['addPullRequestReview']);
    fixture.faults.push({operation: 'addPullRequestReviewThread', status: 429, code: 'RATE_LIMITED', retryAfter: 7});
    assert.deepEqual(await sendReview(target), {outcome: 'not-sent', code: 'RATE_LIMITED', retryAfter: 7});
    assert.deepEqual(steps().slice(1), ['addPullRequestReview', 'addPullRequestReviewThread', 'deletePullRequestReview']);
    assert.equal(fixture.pending, null);
    assert.equal(readReviewDraft(name).body, 'Looks good overall.');
});

test('falls back to the review body when the GraphQL routes are unavailable', async () => {
    const {fixture, api, target, steps} = setup({groups: ['reviews-body']});
    await probeReviewRoutes(api, 42);
    assert.deepEqual(steps(), ['pullRequestReviewContext', 'reviews']);
    assert.equal(reviewRoute(api), 'body');
    writeReviewDraft(name, draft());
    fixture.requests.length = 0;
    const result = await sendReview(target);
    assert.equal(result.outcome, 'submitted');
    assert.deepEqual(steps(), ['createReview']);
    const sent = fixture.requests[0].body;
    assert.deepEqual(Object.keys(sent).sort(), ['body', 'commit_id', 'event']);
    assert.equal(sent.commit_id, head);
    assert.match(sent.body, /^Looks good overall\.\n\n---\n\n\*\*game\/project\.source\.json · Cat/u);
    assert.match(sent.body, /Ask the question once\./u);
    assert.equal(fixture.reviews.length, 1);
});

test('a send that finds the GraphQL routes off sends nothing and falls back on the next send', async () => {
    const {api, target, steps} = setup({groups: ['reviews-body']});
    writeReviewDraft(name, draft());
    assert.deepEqual(await sendReview(target), {outcome: 'not-sent', code: 'GITHUB_API_UNAVAILABLE'});
    assert.equal(reviewRoute(api), 'body');
    assert.equal((await sendReview(target)).outcome, 'submitted');
    assert.deepEqual(steps(), ['addPullRequestReview', 'createReview']);
});

test('offers no sending when neither review route is available', async () => {
    const {api, target} = setup({groups: ['pulls-read']});
    await probeReviewRoutes(api, 42);
    assert.equal(reviewRoute(api), null);
    writeReviewDraft(name, draft());
    assert.deepEqual(await sendReview(target), {outcome: 'not-sent', code: 'UNSUPPORTED'});
});

test('checks an unknown body-only review by its author, commit and body', async () => {
    const {fixture, target} = setup({groups: ['reviews-body']});
    target.api.available.threads = false;
    writeReviewDraft(name, draft());
    fixture.faults.push({operation: 'createReview', status: 502, code: 'UPSTREAM_FAILURE', apply: true});
    assert.deepEqual(await sendReview(target), {outcome: 'unknown', code: 'REVIEW_OUTCOME_UNKNOWN'});
    assert.equal((await checkReview(target)).outcome, 'submitted');
    assert.equal(fixture.reviews.length, 1);

    // Not found: the words stay, and the next send uses a new ID.
    writeReviewDraft(name, draft({body: 'A second look.'}));
    fixture.faults.push({operation: 'createReview', status: 502, code: 'UPSTREAM_FAILURE'});
    await sendReview(target);
    const first = readReviewDraft(name).submit.id;
    assert.equal((await checkReview(target)).outcome, 'closed');
    fixture.requests.length = 0;
    assert.equal((await sendReview(target)).outcome, 'submitted');
    assert.notEqual(fixture.requests[0].submitId, first);
});

test('keeps the draft across failures and refuses an empty review before sending', async () => {
    const {fixture, target} = setup();
    writeReviewDraft(name, {...emptyReviewDraft(), event: 'REQUEST_CHANGES', comments: Object.fromEntries([comment(game, 'Cat', 'a1', 'Fix')])});
    assert.deepEqual(await sendReview(target), {outcome: 'not-sent', code: 'EMPTY_REVIEW'});
    assert.equal(fixture.requests.length, 0);
    writeReviewDraft(name, draft());
    for (const code of ['FORBIDDEN', 'UPSTREAM_TIMEOUT']) {
        fixture.faults.push({operation: 'addPullRequestReview', status: code === 'FORBIDDEN' ? 403 : 504, code});
        await sendReview(target);
        const kept = readReviewDraft(name);
        assert.equal(kept.body, 'Looks good overall.');
        assert.equal(Object.keys(kept.comments).length, 2);
    }
});

test('a submission the proxy no longer knows is shown with the reviews on that commit, and can be forgotten', async () => {
    const {fixture, target} = setup();
    writeReviewDraft(name, {...draft(), submit: {id: crypto.randomUUID(), commitOid: head, route: 'threads', state: 'submit-unknown',
        threadKeys: []}});
    fixture.reviews.push({id: 'R9', number: 9, login: 'reviewer', commitOid: head, state: 'COMMENTED', submittedAt: '2026-11-11T00:00:09Z',
        body: '', threads: []});
    const result = await checkReview(target);
    assert.deepEqual(result, {outcome: 'lost', code: 'REVIEW_STEP_CONFLICT', reviews: [{state: 'COMMENTED', submittedAt: '2026-11-11T00:00:09Z'}]});
    forgetReviewSubmission(name);
    assert.equal(readReviewDraft(name).submit, undefined);
    assert.equal(readReviewDraft(name).body, 'Looks good overall.');
});

test('runs one action at a time per review', async () => {
    const {fixture, target} = setup({delay: 5});
    writeReviewDraft(name, draft());
    const [first, second] = await Promise.all([sendReview(target), sendReview(target)]);
    assert.equal(first.outcome, 'submitted');
    assert.deepEqual(second, {outcome: 'not-sent', code: 'BUSY'});
    assert.equal(fixture.maxActive, 1);
    assert.equal(fixture.reviews.length, 1);
});

test('keeps the draft in memory when browser storage refuses it', () => {
    const saved = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {
        getItem: () => null, setItem: () => {throw new Error('quota');}, removeItem: () => {}
    }});
    try {
        writeReviewDraft('x/y#1', draft());
        assert.equal(readReviewDraft('x/y#1').body, 'Looks good overall.');
        writeReviewDraft('x/y#1', null);
        assert.equal(readReviewDraft('x/y#1').body, '');
    } finally {
        Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: saved});
    }
});
