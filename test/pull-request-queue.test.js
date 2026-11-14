import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPullRequestQueue, inspectPublicationRepository, preparePublicationCommit, publicationCommits,
    pushPublicationCommit} from '../dist/pull-request-queue.js';
import {createGitHubPublicationHost} from '../dist/github-publication-host.js';
import {directoryHandle} from './directory.js';
import {adapterOptions, commit, git, remote, startFixture, writeDiscovery} from './smart-http-fixture.js';

const id = '149d8a60-9a90-4ae3-bf15-9be62b91af38';
const mergeId = '827db84f-930c-4b02-b536-94428c98e229';
const baseOid = 'a'.repeat(40);
const headOid = 'b'.repeat(40);
const mergedOid = 'c'.repeat(40);
const head = 'tw-plus/pr-' + id;
const intent = {id, remote, repositoryId: 7, head, base: 'main', baseOid, commitOid: headOid,
    title: 'New project behavior', body: 'Work for the next version.', goal: 'merge',
    issue: {title: 'New behavior', body: 'Description', closeAfterMerge: true}};

function fixture({existingIssue} = {}) {
    const state = {baseOid, headOid: null, base: 'main', checks: 'PENDING', checksCount: 1, mergeStatus: 'pending', closingCount: 0,
        reviewDecision: null, merged: false, loseIssue: false, losePull: false, downstack: false};
    const calls = [];
    const jobs = new Map();
    const journal = {
        exclusive: (_key, run) => run(),
        get: async key => structuredClone(jobs.get(key)),
        put: async (key, job) => {jobs.set(key, structuredClone(job));}
    };
    let issue = existingIssue;
    let pullBody;
    const pull = () => ({
        number: 28, state: state.merged ? 'closed' : 'open', merged: state.merged, merge_commit_sha: mergedOid, body: pullBody,
        head: {ref: head, sha: state.headOid, repo: {id: state.forkId ?? 7}},
        base: {ref: state.base, sha: state.baseOid, repo: {id: 7}}, changed_files: 1,
        ...(state.downstack && {stack: {number: 2, position: 2}})
    });
    const host = createGitHubPublicationHost({
        remote, repositoryId: 7,
        grant: async capability => ({repositoryId: 7, accessToken: capability.replaceAll('-', '_')}),
        async pushCommit(oid, ref) {
            assert.equal(ref, 'refs/heads/' + head);
            assert.equal(oid, headOid);
            calls.push('push');
            state.headOid = oid;
        },
        async fetch(input, init) {
            assert.equal(init.redirect, 'error');
            const url = new URL(input);
            assert.equal(url.origin, 'https://api.github.com');
            assert.equal(init.headers['X-GitHub-Api-Version'], '2026-03-10');
            const path = url.pathname;
            const route = path.replace('/repos/fixture/work', '');
            const send = payload => Response.json(payload);
            if (route.startsWith('/git/ref/heads/')) {
                const name = route.slice('/git/ref/heads/'.length);
                const sha = name === 'main' ? state.baseOid : state.headOid;
                return sha ? send({ref: 'refs/heads/' + name, object: {type: 'commit', sha}}) : new Response(null, {status: 404});
            }
            if (route === '/issues' && init.method === 'POST') {
                assert.equal(init.headers.Authorization, 'Bearer issues_write');
                calls.push('issue');
                issue = {...JSON.parse(init.body), number: 12, state: 'open'};
                if (state.loseIssue) throw new Error('lost issue response');
                return send(issue);
            }
            if (route === '/issues') return send(issue ? [issue] : []);
            if (route === '/issues/12') {
                if (init.method === 'PATCH') {
                    calls.push('close');
                    assert.equal(state.merged, true);
                    assert.equal(init.headers.Authorization, 'Bearer issues_write');
                    issue.state = 'closed';
                }
                return send(issue);
            }
            if (route === '/pulls' && init.method === 'POST') {
                calls.push('pull');
                assert.equal(init.headers.Authorization, 'Bearer pulls_write');
                const draft = JSON.parse(init.body);
                assert.equal(draft.head, head);
                assert.equal(draft.base, 'main');
                if (issue) assert.match(draft.body, /Refs #12/);
                pullBody = draft.body;
                if (state.losePull) throw new Error('lost PR response');
                return send(pull());
            }
            if (route === '/pulls') {
                assert.equal(url.searchParams.get('head'), 'fixture:' + head);
                return send(pullBody ? [pull()] : []);
            }
            if (route === '/pulls/28') return send(pull());
            if (route === '/pulls/28/files') return send([
                {filename: 'project/project.source.json', sha: 'd'.repeat(40), status: 'modified', additions: 2, deletions: 1}
            ]);
            if (path === '/graphql') {
                assert.equal(init.headers.Authorization, 'Bearer checks_read');
                assert.deepEqual(JSON.parse(init.body).variables, {owner: 'fixture', name: 'work', number: 28});
                return send({data: {repository: {databaseId: 7, pullRequest: {headRefOid: state.headOid, baseRefOid: state.baseOid,
                    isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: state.reviewDecision,
                    closingIssuesReferences: {totalCount: state.closingCount},
                    commits: {nodes: [{commit: {oid: state.headOid, statusCheckRollup: {
                        state: state.checks, contexts: {totalCount: state.checksCount}
                    }}}]}
                }}}});
            }
            if (route === '/pulls/28/merge-async/' + mergeId) return send({status: state.mergeStatus});
            if (route === '/pulls/28/merge-async') {
                calls.push('merge');
                assert.equal(init.headers.Authorization, 'Bearer merge');
                assert.deepEqual(JSON.parse(init.body), {sha: headOid, merge_method: 'squash', merge_action: 'default', bypass_rules: false});
                return Response.json({status: 'pending', details: {uuid: mergeId}}, {status: 202});
            }
            assert.fail('Unexpected GitHub endpoint: ' + route);
        }
    });
    const openQueue = () => createPullRequestQueue({journal, repository: {id: 7, remote}, port: host});
    return {state, calls, openQueue, host};
}

test('creates the PR, waits for checks, requests merge separately, and closes the issue after verified merge', async () => {
    const {state, calls, openQueue} = fixture();
    const queue = openQueue();
    await queue.enqueue(intent);
    assert.equal((await queue.advance(id)).status, 'pushed');
    assert.equal((await queue.advance(id)).status, 'issueReady');
    assert.equal((await queue.advance(id)).status, 'waiting');
    assert.equal((await queue.advance(id)).status, 'waiting');
    assert.deepEqual(calls, ['push', 'issue', 'pull']);
    state.checks = 'FAILURE';
    assert.equal((await queue.advance(id)).pause, 'checksFailed');
    assert.deepEqual(calls, ['push', 'issue', 'pull']);
    state.checks = 'SUCCESS';
    assert.equal((await queue.advance(id)).status, 'ready');
    assert.deepEqual(calls, ['push', 'issue', 'pull']);
    const restarted = openQueue();
    assert.equal((await restarted.advance(id)).mergeRequestId, mergeId);
    assert.equal((await restarted.advance(id)).status, 'merging');
    assert.deepEqual(calls, ['push', 'issue', 'pull', 'merge']);
    state.merged = true;
    assert.equal((await restarted.advance(id)).mergeOid, mergedOid);
    assert.equal((await restarted.advance(id)).status, 'done');
    assert.deepEqual(calls, ['push', 'issue', 'pull', 'merge', 'close']);
});

test('references an existing Issue and completes a PR-only job without closing or merging', async () => {
    const issue = {number: 12, title: 'Existing Issue', state: 'open'};
    const {calls, openQueue} = fixture({existingIssue: issue});
    const queue = openQueue();
    await queue.enqueue({...intent, goal: 'pr', issue: {number: 12, closeAfterMerge: false}});
    assert.equal((await queue.advance(id)).status, 'pushed');
    assert.equal((await queue.advance(id)).issueNumber, 12);
    assert.equal((await queue.advance(id)).pullNumber, 28);
    assert.equal((await openQueue().advance(id)).status, 'done');
    assert.equal(issue.state, 'open');
    assert.deepEqual(calls, ['push', 'pull']);
});

test('recovers a lost Issue and PR response by their markers and stops when the base changes', async () => {
    const {state, calls, openQueue} = fixture();
    const queue = openQueue();
    await queue.enqueue(intent);
    await queue.advance(id);
    state.loseIssue = true;
    assert.equal((await queue.advance(id)).pause, 'issueUnknown');
    assert.equal((await openQueue().advance(id)).issueNumber, 12);
    state.losePull = true;
    assert.equal((await queue.advance(id)).pause, 'pullUnknown');
    assert.equal((await openQueue().advance(id)).pullNumber, 28);
    state.checks = 'SUCCESS';
    assert.equal((await queue.advance(id)).status, 'ready');
    state.baseOid = 'e'.repeat(40);
    assert.equal((await queue.advance(id)).pause, 'baseChanged');
    assert.deepEqual(calls, ['push', 'issue', 'pull']);
});

test('stops for absent checks, changed reviews and downstack merges', async () => {
    const {state, calls, openQueue, host} = fixture();
    const queue = openQueue();
    await queue.enqueue({...intent, issue: undefined});
    for (let i = 0; i < 3; i++) await queue.advance(id);
    state.checksCount = 0;
    assert.equal((await queue.advance(id)).pause, 'noChecks');
    state.checksCount = 1;
    state.checks = 'SUCCESS';
    state.reviewDecision = 'CHANGES_REQUESTED';
    assert.equal((await queue.advance(id)).pause, 'reviewChanges');
    state.reviewDecision = null;
    const approved = await host.observePullRequest(28);
    state.base = 'other';
    assert.deepEqual(await host.mergePullRequest({number: 28, head, base: 'main', headOid, baseOid,
        diffDigest: approved.diffDigest, allowNoChecks: false}), {state: 'rejected'});
    state.base = 'main';
    state.closingCount = 1;
    assert.equal((await queue.advance(id)).pause, 'closingIssues');
    state.closingCount = 0;
    state.downstack = true;
    assert.equal((await queue.advance(id)).pause, 'downstack');
    assert.deepEqual(calls, ['push', 'pull']);
});

test('requires an explicit approval of no checks on the reviewed diff', async () => {
    const {state, calls, openQueue} = fixture();
    const queue = openQueue();
    await assert.rejects(queue.enqueue({...intent, body: 'Closes #12'}), /Invalid publication intent/u);
    await queue.enqueue({...intent, issue: undefined});
    for (let i = 0; i < 3; i++) await queue.advance(id);
    state.checksCount = 0;
    assert.equal((await queue.advance(id)).pause, 'noChecks');
    state.baseOid = 'e'.repeat(40);
    await assert.rejects(queue.confirmNoChecks(id), /Pull request changed/u);
    state.baseOid = baseOid;
    assert.equal((await queue.confirmNoChecks(id)).noChecksApproved, true);
    assert.equal((await queue.advance(id)).status, 'ready');
    assert.deepEqual(calls, ['push', 'pull']);
    assert.equal((await queue.advance(id)).mergeRequestId, mergeId);
});

test('pushes the journaled OID without moving local HEAD, and refuses a conflicting publication branch', async t => {
    const server = await startFixture(t);
    const file = join(server.client, 'project.txt');
    await writeFile(file, 'approved\n');
    const approved = commit(server.client, 'approved');
    await writeFile(file, 'next local change\n');
    const local = commit(server.client, 'later');
    const configuredRemote = remote.slice(0, -4);
    git(server.client, 'remote', 'set-url', 'origin', configuredRemote);
    const originalConfig = await readFile(join(server.client, '.git/config'));
    const {getSession, fetch} = adapterOptions(server);
    const access = {root: directoryHandle(server.client), async getSession(target, write) {
        assert.equal(target, configuredRemote);
        assert.equal(write, true);
        return getSession(target, write);
    }};
    assert.deepEqual(await inspectPublicationRepository({...access, fetch}), {
        remote: configuredRemote, defaultBranch: 'main', branches: [{name: 'main', oid: git(server.bare, 'rev-parse', 'main')}]
    });
    const ref = 'refs/heads/' + head;
    const push = (oid, send = fetch) => pushPublicationCommit({
        ...access, remote, oid, ref, fetch: send
    });
    await push(approved);
    const count = server.upstream.length;
    await push(approved);
    assert.equal(server.upstream.length, count + 1);
    assert.equal(git(server.bare, 'rev-parse', ref), approved);
    assert.equal(git(server.client, 'rev-parse', 'HEAD'), local);
    assert.equal(await readFile(file, 'utf8'), 'next local change\n');
    assert.deepEqual(await readFile(join(server.client, '.git/config')), originalConfig);
    await assert.rejects(push(local), {code: 'diverged'});
    git(server.bare, 'update-ref', '-d', ref);
    const other = git(server.bare, 'rev-parse', 'main');
    let discoveries = 0;
    await assert.rejects(push(approved, async (url, init) => {
        if (String(url).endsWith(writeDiscovery) && ++discoveries === 2) git(server.bare, 'update-ref', ref, other);
        return fetch(url, init);
    }), {code: 'diverged'});
    assert.equal(git(server.bare, 'rev-parse', ref), other);
});

test('publishes just the selected commits without changing HEAD, the worktree or the index', async t => {
    const folder = await mkdtemp(join(tmpdir(), 'tw-publish-selection-'));
    t.after(() => rm(folder, {force: true, recursive: true}));
    const run = (...args) => git(folder, ...args);
    run('init', '-q', '-b', 'main');
    run('config', 'user.name', 'Commit fixture');
    run('config', 'user.email', 'fixture@example.invalid');
    const add = async (file, text, message) => {
        await writeFile(join(folder, file), text);
        run('add', file);
        run('commit', '-qm', message);
        return run('rev-parse', 'HEAD');
    };
    const base = await add('base.txt', 'base\n', 'Base');
    const first = await add('one.txt', 'one\n', 'First');
    const skipped = await add('skip.txt', 'skipped\n', 'Skipped');
    const last = await add('two.txt', 'two\n', 'Last');
    await writeFile(join(folder, 'skip.txt'), 'modified locally\n');
    run('add', 'skip.txt');
    const index = await readFile(join(folder, '.git', 'index'));
    const root = directoryHandle(folder);
    const commits = await publicationCommits(root, last, {name: 'main', oid: base}, async () => null, () => {});
    assert.deepEqual(commits.map(item => item.oid), [last, skipped, first]);
    const result = await preparePublicationCommit(root, base, [first, last], () => {});
    assert.equal(run('rev-list', '--count', base + '..' + result), '2');
    assert.equal(run('diff', '--name-only', base, result), 'one.txt\ntwo.txt');
    assert.equal(run('rev-parse', 'HEAD'), last);
    assert.equal(run('show', result + ':two.txt'), 'two');
    assert.deepEqual(await readFile(join(folder, '.git', 'index')), index);
    assert.equal(await readFile(join(folder, 'skip.txt'), 'utf8'), 'modified locally\n');
});

test('a manual merge checks the selected revision and supports a PR from a fork', async () => {
    const {state, host, openQueue, calls} = fixture();
    const queue = openQueue();
    await queue.enqueue({...intent, goal: 'pr', issue: undefined});
    for (let i = 0; i < 3; i++) await queue.advance(id);
    state.forkId = 9;
    state.checks = 'SUCCESS';
    const observation = await host.readMergeStatus(28);
    assert.deepEqual(await host.readPullRequestChecks(28), {head: headOid, base: baseOid, checks: 'passed'});
    assert.equal(observation.headRepositoryId, 9);
    const expected = {number: 28, head, base: 'main', headOid, baseOid, diffDigest: observation.diffDigest, allowNoChecks: false};
    state.checks = 'PENDING';
    assert.deepEqual(await host.mergeSelectedPullRequest(expected), {state: 'rejected'});
    assert.deepEqual(calls, ['push', 'pull']);
    state.checks = 'SUCCESS';
    assert.deepEqual(await host.mergeSelectedPullRequest(expected), {state: 'accepted', requestId: mergeId});
    assert.deepEqual(calls, ['push', 'pull', 'merge']);
});
