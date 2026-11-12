import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPullRequestQueue, validatePublicationIntent} from '../dist/pull-request-queue.js';
import {createGitHubPublicationHost} from '../dist/github-publication-host.js';

const remote = 'https://github.com/fixture/work.git';
const repositoryId = 42;
const id = '149d8a60-9a90-4ae3-bf15-9be62b91af38';
const head = 'tw-plus/pr-' + id;
const parentOid = 'a'.repeat(40);
const headOid = 'b'.repeat(40);
const trunkOid = 'c'.repeat(40);
const rebasedOid = 'd'.repeat(40);
const mergedOid = 'e'.repeat(40);
const parent = {number: 11, head: 'feature', headOid: parentOid, targetBase: 'main'};
const stackNumber = 14;
const childNumber = 12;
const now = '2026-10-01T00:00:00Z';
const mergeId = '827db84f-930c-4b02-b536-94428c98e229';

function fixture({existing = false, lostResponse = false, goal = 'merge', binary = false} = {}) {
    const calls = [];
    const records = new Map();
    const state = {linked: false, checks: 'PENDING', changed: false, incomplete: false, modeChanged: false,
        parentOid, childOid: null, rebased: false, parentMerged: false, lowerMerged: false, childMerged: false};
    const pull = (number, ref, sha, base, baseSha, merged = false) => ({
        number, state: merged ? 'closed' : 'open', merged, merged_at: merged ? now : null,
        ...(merged && {merge_commit_sha: mergedOid}),
        head: {ref, sha, repo: {id: repositoryId}}, base: {ref: base, sha: baseSha, repo: {id: repositoryId}}
    });
    const lower = () => ({...pull(10, 'foundation', '0'.repeat(40), 'main', trunkOid, state.lowerMerged),
        stack: {number: stackNumber, position: 1}});
    const getParent = () => ({...pull(parent.number, parent.head, state.parentOid,
        existing && !state.lowerMerged ? 'foundation' : 'main',
        existing && !state.lowerMerged ? '0'.repeat(40) : trunkOid, state.parentMerged),
        ...((existing || state.linked) && {stack: {number: stackNumber, position: existing ? 2 : 1}})});
    let body;
    const child = () => ({...pull(childNumber, head, state.childOid, state.rebased ? 'main' : parent.head,
        state.rebased ? trunkOid : state.parentOid, state.childMerged), body, changed_files: 1,
        ...(state.linked && {stack: {number: stackNumber, position: existing ? 3 : 2}})});
    const stack = () => ({number: stackNumber, base: {ref: 'main'}, open: !state.childMerged,
        pull_requests: [...(existing ? [lower()] : []), getParent(), ...(state.linked ? [child()] : [])]});
    const port = createGitHubPublicationHost({remote, repositoryId,
        async grant(capability) {return {repositoryId, accessToken: 'token_' + capability.replace('-', '_')};},
        async pushCommit(sha, ref) {
            assert.equal(sha, headOid);
            assert.equal(ref, 'refs/heads/' + head);
            state.childOid = sha;
            calls.push('push');
        },
        async fetch(url, init) {
            const route = new URL(url);
            assert.equal(route.origin, 'https://api.github.com');
            const pathname = route.pathname.replace('/repos/fixture/work', '');
            const method = init.method;
            const headers = new Headers(init.headers);
            assert.equal(headers.get('X-GitHub-Api-Version'), '2026-03-10');
            if (pathname === '/pulls/10' && existing) return Response.json(lower());
            if (pathname === '/pulls/' + parent.number) return Response.json(getParent());
            if (pathname === '/pulls/' + childNumber && headers.get('Accept') === 'application/vnd.github.diff') {
                const mode = state.modeChanged ? 'old mode 100644\nnew mode 100755\n' : '';
                return new Response('diff --git a/project.source.json b/project.source.json\n' + mode +
                    'index 7ab456f..f9b27a6' + (mode ? '' : ' 100644') + '\n' +
                    '--- a/project.source.json\n+++ b/project.source.json\n@@ -1 +1 @@\n-old\n+new\n');
            }
            if (pathname === '/pulls/' + childNumber && body) return Response.json(child());
            if (pathname === '/git/ref/heads/' + parent.head || pathname === '/git/ref/heads/' + head) {
                const ref = pathname.slice('/git/ref/'.length);
                const sha = ref === 'heads/' + parent.head ? state.parentOid : state.childOid;
                return sha ? Response.json({ref: 'refs/' + ref, object: {sha, type: 'commit'}}) : new Response(null, {status: 404});
            }
            if (pathname === '/compare/' + parentOid + '...' + headOid) {
                assert.equal(headers.get('Authorization'), 'Bearer token_stacks');
                return Response.json({status: 'ahead', merge_base_commit: {sha: parentOid}});
            }
            if (pathname === '/pulls' && method === 'GET') return Response.json(body ? [child()] : []);
            if (pathname === '/pulls' && method === 'POST') {
                const draft = JSON.parse(init.body);
                assert.equal(draft.head, head);
                assert.equal(draft.base, parent.head);
                body = draft.body;
                calls.push('pull');
                return Response.json(child(), {status: 201});
            }
            if (pathname === '/stacks/' + stackNumber && method === 'GET') {
                assert.equal(headers.get('Authorization'), 'Bearer token_stacks');
                return Response.json(stack());
            }
            if (pathname === (existing ? '/stacks/' + stackNumber + '/add' : '/stacks') && method === 'POST') {
                assert.equal(headers.get('Authorization'), 'Bearer token_stacks');
                assert.deepEqual(JSON.parse(init.body), {pull_requests: existing ? [childNumber] : [parent.number, childNumber]});
                state.linked = true;
                calls.push(existing ? 'append' : 'createStack');
                if (lostResponse) throw new Error('GitHub committed the stack write but the connection was lost');
                return Response.json(stack(), {status: existing ? 200 : 201});
            }
            if (pathname === '/pulls/' + childNumber + '/files') {
                if (binary) return Response.json([{
                    filename: 'assets/costume.png', sha: 'f'.repeat(40), status: 'modified', additions: 0, deletions: 0
                }]);
                return Response.json([{
                    filename: 'project.source.json', sha: 'f'.repeat(40), status: 'modified', additions: 1, deletions: 1,
                    patch: state.incomplete ? '@@ -1,2 +1,2 @@\n-old\n+new' :
                        (state.rebased ? '@@ -15 +15 @@' : '@@ -1 +1 @@') + '\n-old\n+' + (state.changed ? 'different' : 'new')
                }]);
            }
            if (pathname === '/graphql') {
                calls.push('checks:' + state.childOid);
                return Response.json({data: {repository: {databaseId: repositoryId, pullRequest: {
                    headRefOid: state.childOid, baseRefOid: trunkOid, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
                    reviewDecision: null, closingIssuesReferences: {totalCount: 0},
                    commits: {nodes: [{commit: {oid: state.childOid, statusCheckRollup: {
                        state: state.checks, contexts: {totalCount: 1}
                    }}}]}
                }}}});
            }
            if (pathname === '/pulls/' + childNumber + '/merge-async' && method === 'PUT') {
                assert.equal(state.parentMerged, true);
                assert.equal(!existing || state.lowerMerged, true);
                assert.deepEqual(JSON.parse(init.body), {sha: rebasedOid, merge_method: 'squash', merge_action: 'default', bypass_rules: false});
                calls.push('merge');
                return Response.json({status: 'pending', details: {uuid: mergeId}}, {status: 202});
            }
            assert.fail(method + ' ' + pathname);
        }
    });
    const stackParent = {...parent, ...(existing && {stackNumber})};
    const intent = {id, remote, repositoryId, head, base: parent.head, baseOid: parentOid, commitOid: headOid,
        title: 'Child', body: 'Child patch', goal, stackParent};
    const journal = {exclusive: (_key, run) => run(), async get(key) {return structuredClone(records.get(key));},
        async put(key, job) {records.set(key, structuredClone(job));}};
    const open = () => createPullRequestQueue({repository: {id: repositoryId, remote}, port, journal});
    return {intent, port, calls, state, open};
}

async function untilStacking(queue, intent) {
    await queue.enqueue(intent);
    assert.equal((await queue.advance(id)).status, 'pushed');
    assert.equal((await queue.advance(id)).status, 'issueReady');
    assert.equal((await queue.advance(id)).status, 'stacking');
}

test('recovers a native stack write by reading membership and rechecks the rebased child and CI before merge', async () => {
    const {intent, state, calls, open} = fixture({lostResponse: true});
    const queue = open();
    await untilStacking(queue, intent);
    assert.equal((await queue.advance(id)).pause, 'stackUnknown');
    const reopened = open();
    const recovered = await reopened.advance(id);
    assert.equal(recovered.status, 'waitingForParent');
    assert.equal(recovered.stackNumber, stackNumber);
    assert.equal((await reopened.advance(id)).status, 'waitingForParent');
    assert.deepEqual(calls, ['push', 'pull', 'createStack']);

    state.parentMerged = true;
    assert.equal((await reopened.advance(id)).status, 'waitingForParent');
    state.rebased = true;
    state.childOid = rebasedOid;
    assert.equal((await reopened.advance(id)).status, 'waiting');
    assert.equal(calls.at(-1), 'checks:' + rebasedOid);
    state.checks = 'SUCCESS';
    const ready = await reopened.advance(id);
    assert.deepEqual(ready.stackMergeRefs, {baseOid: trunkOid, headOid: rebasedOid});
    assert.equal(ready.status, 'ready');
    assert.equal((await reopened.advance(id)).mergeRequestId, mergeId);
    assert.equal(calls.filter(call => call === 'merge').length, 1);
    state.childMerged = true;
    assert.equal((await reopened.advance(id)).status, 'merged');
    assert.equal((await reopened.advance(id)).status, 'done');
});

test('adds the child above only the approved top of an existing native stack', async () => {
    const {intent, port, calls, open} = fixture({existing: true, goal: 'pr'});
    assert.equal(await port.stackParent(10), null);
    assert.deepEqual(await port.stackParent(11), intent.stackParent);
    const queue = open();
    await untilStacking(queue, intent);
    const result = await queue.advance(id);
    assert.equal(result.status, 'done');
    assert.equal(result.stackNumber, stackNumber);
    assert.deepEqual(calls, ['push', 'pull', 'append']);
});

test('does not publish when the approved parent or stack changed before push', async () => {
    const {intent, state, calls, open} = fixture({existing: true});
    assert.throws(() => validatePublicationIntent({...intent, baseOid: trunkOid}), /Invalid stack parent/u);
    assert.throws(() => validatePublicationIntent({...intent, allowNoChecks: true}), /Invalid stack parent/u);
    const queue = open();
    await queue.enqueue(intent);
    state.parentOid = trunkOid;
    assert.equal((await queue.advance(id)).pause, 'stackParentChanged');
    assert.deepEqual(calls, []);
});

test('keeps all downstack PRs out of automated merge and requires a complete matching rebased diff', async () => {
    const {intent, state, calls, open} = fixture({existing: true});
    const queue = open();
    await untilStacking(queue, intent);
    assert.equal((await queue.advance(id)).status, 'waitingForParent');
    state.parentMerged = true;
    assert.equal((await queue.advance(id)).status, 'waitingForParent');
    state.lowerMerged = true;
    state.rebased = true;
    state.childOid = rebasedOid;
    state.checks = 'SUCCESS';
    state.incomplete = true;
    assert.equal((await queue.advance(id)).pause, 'comparisonUnavailable');
    state.incomplete = false;
    state.changed = true;
    assert.equal((await queue.advance(id)).pause, 'stackDiffChanged');
    state.changed = false;
    state.modeChanged = true;
    assert.equal((await queue.advance(id)).pause, 'stackDiffChanged');
    assert.equal(calls.includes('merge'), false);
});

test('allows a binary project asset in a native stack and pauses automatic merge without complete diff proof', async () => {
    const {intent, state, calls, open} = fixture({binary: true});
    const queue = open();
    await untilStacking(queue, intent);
    const linked = await queue.advance(id);
    assert.equal(linked.stackNumber, stackNumber);
    assert.equal(linked.status, 'waitingForParent');
    state.parentMerged = true;
    state.rebased = true;
    state.childOid = rebasedOid;
    state.checks = 'SUCCESS';
    assert.equal((await queue.advance(id)).pause, 'comparisonUnavailable');
    assert.ok(calls.includes('createStack'));
    assert.equal(calls.includes('merge'), false);
});
