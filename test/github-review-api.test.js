import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGitHubReviewApi, isReviewThreadPath} from '@kubohiroya/turbowarp-plus-editor-git/project-source-diff';
import {reviewBearer, reviewProxyOrigin, reviewRemote, reviewSession} from './github-review-fixture.js';

const head = 'b'.repeat(40);
const id = '0b6a2c1e-3f4d-4a5b-8c6d-7e8f9a0b1c2d';

function client(respond, session = reviewSession()) {
    const requests = [];
    const api = createGitHubReviewApi({remote: reviewRemote, getSession: async () => session,
        fetch: async (url, init) => {
            requests.push({url, init});
            return respond(url, init);
        }});
    return {api, requests};
}
const json = (status, value) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

test('sends to the connection proxy with the proxy Bearer only, and no cookies, referrer or redirects', async () => {
    const {api, requests} = client(() => json(200, {state: 'PENDING', commitOid: head}));
    await api.start(42, id, head);
    const [{url, init}] = requests;
    assert.equal(url, reviewProxyOrigin + '/v1/github/fixture/work/graphql/addPullRequestReview');
    assert.deepEqual(init.headers, {Authorization: 'Bearer ' + reviewBearer, Accept: 'application/json',
        'Content-Type': 'application/json', 'Review-Submit-Id': id});
    assert.equal(init.body, JSON.stringify({number: 42, commitOid: head}));
    assert.deepEqual([init.method, init.credentials, init.redirect, init.cache, init.referrerPolicy],
        ['POST', 'omit', 'error', 'no-store', 'no-referrer']);
});

test('reads proxy error codes and wait times, never the error text', async () => {
    const {api} = client(() => json(429, {code: 'RATE_LIMITED', requestId: '11111111-2222-4333-8444-555555555555', retryAfter: 12,
        message: 'secret upstream text'}));
    await assert.rejects(api.thread(42, id, 0, 'game/project.source.json', 'Hi'), error => {
        assert.equal(error.code, 'RATE_LIMITED');
        assert.equal(error.retryAfter, 12);
        assert.equal(error.unknown, false);
        assert.doesNotMatch(error.message + JSON.stringify(error.options), /secret/u);
        return true;
    });
    // An unknown code keeps the status's meaning; an unrecognised status after a mutation is an unknown outcome.
    const odd = client(() => json(409, {code: 'SOMETHING_ELSE'}));
    await assert.rejects(odd.api.submit(42, id, 0, 'COMMENT', 'x'), {code: 'REVIEW_STEP_CONFLICT'});
    const teapot = client(() => new Response('no', {status: 418}));
    await assert.rejects(teapot.api.submit(42, id, 0, 'COMMENT', 'x'), error => error.code === 'UPSTREAM_FAILURE' && error.unknown);
    // A route without a JSON error body is unavailable.
    const missing = client(() => new Response('Not found', {status: 404}));
    await assert.rejects(missing.api.create(42, id, head, 'COMMENT', 'x'), {code: 'GITHUB_API_UNAVAILABLE'});
    assert.equal(missing.api.available.body, false);
});

test('a mutation whose answer is lost or malformed has an unknown outcome', async () => {
    const lost = client(() => {throw new TypeError('Failed to fetch');});
    await assert.rejects(lost.api.submit(42, id, 1, 'COMMENT', ''), error => error.code === 'NETWORK_ERROR' && error.unknown);
    const malformed = client(() => json(200, {state: 'PENDING'}));
    await assert.rejects(malformed.api.submit(42, id, 1, 'COMMENT', ''), error => error.code === 'INVALID_RESPONSE' && error.unknown);
    const read = client(() => {throw new TypeError('Failed to fetch');});
    await assert.rejects(read.api.context(42), error => error.code === 'NETWORK_ERROR' && !error.unknown);
});

test('sends nothing without a valid session or with values the proxy would refuse', async () => {
    const none = client(() => assert.fail('no request'), null);
    await assert.rejects(none.api.context(42), {code: 'SESSION_REQUIRED'});
    const expired = client(() => assert.fail('no request'), {...reviewSession(), expiresAt: Date.now() - 1});
    await assert.rejects(expired.api.context(42), {code: 'SESSION_EXPIRED'});
    const elsewhere = client(() => assert.fail('no request'), {...reviewSession(), connection: {mode: 'desktop', proxyOrigin: 'http://evil.example'}});
    await assert.rejects(elsewhere.api.context(42), {code: 'INVALID_CONNECTION'});
    const {api} = client(() => assert.fail('no request'));
    await assert.rejects(api.thread(42, id, 0, '../project.source.json', 'x'), {code: 'BAD_REQUEST'});
    await assert.rejects(api.thread(42, id, 50, 'game/project.source.json', 'x'), {code: 'BAD_REQUEST'});
    await assert.rejects(api.start(42, 'not-a-uuid', head), {code: 'BAD_REQUEST'});
    await assert.rejects(api.create(42, id, head, 'COMMENT', ''), {code: 'BAD_REQUEST'});
    assert.throws(() => createGitHubReviewApi({remote: 'https://example.com/a/b.git', getSession: async () => null}),
        {code: 'INVALID_REMOTE'});
});

test('accepts only project.source.json thread paths the proxy accepts', () => {
    assert.ok(isReviewThreadPath('project.source.json'));
    assert.ok(isReviewThreadPath('games/cat/project.source.json'));
    for (const path of ['/a/project.source.json', 'a//project.source.json', 'a/./project.source.json', 'a\\project.source.json',
        'a/project.source.json.bak', 'a/\u0001/project.source.json']) assert.equal(isReviewThreadPath(path), false, path);
});
