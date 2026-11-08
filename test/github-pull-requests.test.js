import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGitHubPullRequests, gitHubRepositoryFromOrigin} from '@kubohiroya/turbowarp-plus-editor-git/project-source-diff';

const base = 'a'.repeat(40), head = 'b'.repeat(40), mergeBase = 'c'.repeat(40);
const signal = new AbortController().signal;
const pr = {
    number: 42, title: 'Start after receiving the signal', body_text: 'One signal for every sprite.',
    state: 'open', user: {login: 'tester'}, changed_files: 2,
    base: {sha: base, ref: 'main', repo: {full_name: 'owner/game'}},
    head: {sha: head, ref: 'start', repo: {full_name: 'contributor/game'}}
};
const source = steps => JSON.stringify({targets: [{name: 'Sprite', isStage: false,
    blocks: {move: {opcode: 'motion_movesteps', inputs: {STEPS: [1, [4, steps]]}}}}]}, null, 2);

test('GitHub HTTPS and SSH origins resolve without forwarding credentials or query data', () => {
    for (const origin of ['https://github.com/owner/game.git', 'git@github.com:owner/game.git', 'ssh://git@github.com/owner/game']) {
        assert.equal(gitHubRepositoryFromOrigin(origin), 'owner/game');
    }
    for (const origin of ['https://token@github.com/owner/game.git', 'https://github.com.evil.test/owner/game',
        'git@github.com:owner/../game', 'https://github.com/owner/game?access_token=secret']) {
        assert.equal(gitHubRepositoryFromOrigin(origin), null);
    }
});

test('a fork PR uses the immutable merge base and head source, including renamed paths', async () => {
    const requests = [];
    const client = createGitHubPullRequests('owner/game', async (url, options) => {
        const parsed = new URL(url);
        assert.equal(parsed.origin, 'https://api.github.com');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.signal, signal);
        assert.deepEqual(Object.keys(options.headers), ['Accept']);
        requests.push(parsed.pathname + parsed.search);
        switch (parsed.pathname) {
        case '/repos/owner/game/pulls': return Response.json([pr]);
        case '/repos/owner/game/pulls/42': return Response.json(pr);
        case '/repos/owner/game/pulls/42/files': return Response.json([
            {filename: 'new location/project.source.json', previous_filename: 'old/project.source.json', status: 'renamed'},
            {filename: 'game/assets/new.svg', status: 'added'}
        ]);
        case '/repos/owner/game/compare/' + base + '...' + head: return Response.json({merge_base_commit: {sha: mergeBase}});
        case '/repos/owner/game/contents/old/project.source.json':
            assert.equal(parsed.searchParams.get('ref'), mergeBase);
            return new Response(source(10));
        case '/repos/contributor/game/contents/new%20location/project.source.json':
            assert.equal(parsed.searchParams.get('ref'), head);
            return new Response(source(25));
        default: throw new Error('Unexpected endpoint: ' + url);
        }
    });
    assert.deepEqual(await client.list(2, signal), {items: [{number: 42, title: pr.title}], more: false});
    const review = await client.load(42, signal);
    assert.equal(review.url, 'https://github.com/owner/game/pull/42');
    assert.equal(review.description, pr.body_text);
    assert.equal(review.files.length, 2);
    assert.equal(review.files[0].previousPath, 'old/project.source.json');
    assert.match(review.files[0].patch, /^-\s+10\r?\n\+\s+25/m);
    assert.equal(review.files[1].status, 'added');
    assert.equal(requests.filter(path => path === '/repos/owner/game/pulls/42').length, 2);
});

test('a PR updated during the file list read cannot compare mixed revisions', async () => {
    let reads = 0;
    const client = createGitHubPullRequests('owner/game', async url => {
        if (url.includes('/files?')) return Response.json([{filename: 'project.source.json', status: 'modified'}]);
        assert.ok(url.endsWith('/pulls/42'));
        const version = reads++ === 0 ? pr.head : {...pr.head, sha: 'd'.repeat(40)};
        return Response.json({...pr, changed_files: 1, head: version});
    });
    await assert.rejects(client.load(42, signal), {code: 'changed'});
    assert.equal(reads, 2);
});
