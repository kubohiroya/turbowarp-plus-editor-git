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

test('project assets come from raw.githubusercontent.com at the merge base and head, capped and read-only', async () => {
    const raw = [];
    let api = 0;
    const svg = 'd'.repeat(32) + '.svg';
    const client = createGitHubPullRequests('owner/game', async (url, options) => {
        const parsed = new URL(url);
        if (parsed.origin === 'https://raw.githubusercontent.com') {
            assert.equal(options.credentials, 'omit');
            assert.equal(options.redirect, 'error');
            assert.equal(options.headers, undefined);
            assert.ok(options.signal instanceof AbortSignal);
            raw.push(parsed.pathname);
            switch (parsed.pathname) {
            case '/owner/game/' + mergeBase + '/old/sb3-source.json': return new Response('Not Found', {status: 404});
            case '/owner/game/' + mergeBase + '/old/assets/' + svg: return new Response('<svg>before</svg>');
            case '/contributor/game/' + head + '/new%20location/sb3-source.json':
                return Response.json({formatVersion: 1, assetsDirectory: 'media files'});
            case '/contributor/game/' + head + '/new%20location/media%20files/' + svg: return new Response('<svg>after</svg>');
            case '/contributor/game/' + head + '/new%20location/media%20files/' + 'e'.repeat(32) + '.png':
                return new Response('x', {headers: {'Content-Length': String(10 * 1024 * 1024 + 1)}});
            case '/contributor/game/' + head + '/new%20location/media%20files/' + 'f'.repeat(32) + '.png':
                return new Response(new ReadableStream({pull(controller) {controller.enqueue(new Uint8Array(1024 * 1024));}}));
            default: return new Response('Not Found', {status: 404});
            }
        }
        api++;
        switch (parsed.pathname) {
        case '/repos/owner/game/pulls/42': return Response.json({...pr, changed_files: 2});
        case '/repos/owner/game/pulls/42/files': return Response.json([
            {filename: 'new location/project.source.json', previous_filename: 'old/project.source.json', status: 'renamed'},
            {filename: 'project.source.json', status: 'added'}
        ]);
        case '/repos/owner/game/compare/' + base + '...' + head: return Response.json({merge_base_commit: {sha: mergeBase}});
        case '/repos/owner/game/contents/old/project.source.json': return new Response(source(10));
        case '/repos/contributor/game/contents/new%20location/project.source.json': return new Response(source(25));
        case '/repos/contributor/game/contents/project.source.json': return new Response(source(5));
        default: throw new Error('Unexpected endpoint: ' + url);
        }
    });
    const review = await client.load(42, signal);
    const apiRequests = api;
    const [renamed, added] = review.files;
    const read = async (loadAsset, version, md5ext = svg, own = new AbortController().signal) => {
        const blob = await loadAsset({version, md5ext, signal: own});
        return blob && blob.text();
    };
    assert.equal(await read(renamed.loadAsset, 'before'), '<svg>before</svg>');
    assert.equal(await read(renamed.loadAsset, 'after'), '<svg>after</svg>');
    assert.equal(await read(renamed.loadAsset, 'after', 'missing.svg'), null);
    // Oversized assets are refused by their declared length or while streaming.
    assert.equal(await read(renamed.loadAsset, 'after', 'e'.repeat(32) + '.png'), null);
    assert.equal(await read(renamed.loadAsset, 'after', 'f'.repeat(32) + '.png'), null);
    // Each version reads its sb3-source.json once; a missing one means `assets`.
    assert.deepEqual(raw.filter(path => path.endsWith('/sb3-source.json')), [
        '/owner/game/' + mergeBase + '/old/sb3-source.json', '/contributor/game/' + head + '/new%20location/sb3-source.json'
    ]);
    const count = raw.length;
    for (const name of ['../secret.svg', 'a/b.svg', '%2e%2e.svg', '']) assert.equal(await read(renamed.loadAsset, 'after', name), null);
    // An added file has no earlier version, and a cancelled read sends nothing.
    assert.equal(await read(added.loadAsset, 'before'), null);
    const cancelled = new AbortController();
    cancelled.abort();
    assert.equal(await read(renamed.loadAsset, 'after', svg, cancelled.signal), null);
    assert.equal(raw.length, count);
    // An assets directory outside the project folder is never requested.
    raw.length = 0;
    const repository = createGitHubPullRequests('owner/game', async url => {
        const parsed = new URL(url);
        if (parsed.origin === 'https://raw.githubusercontent.com') {
            raw.push(parsed.pathname);
            return parsed.pathname.endsWith('/sb3-source.json') ? Response.json({assetsDirectory: '../outside'}) : new Response('<svg/>');
        }
        if (parsed.pathname.endsWith('/files')) return Response.json([{filename: 'project.source.json', status: 'added'}]);
        if (parsed.pathname.endsWith('/pulls/42')) return Response.json({...pr, changed_files: 1});
        return new Response(source(1));
    });
    const outside = (await repository.load(42, signal)).files[0];
    assert.equal(await read(outside.loadAsset, 'after'), null);
    assert.deepEqual(raw, ['/contributor/game/' + head + '/sb3-source.json']);
    // Closing the pull request cancels its pending asset reads, and thumbnails never use the API.
    const closing = new AbortController();
    const closed = createGitHubPullRequests('owner/game', async (url, options) => {
        const parsed = new URL(url);
        if (parsed.origin === 'https://raw.githubusercontent.com') {
            return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
        }
        if (parsed.pathname.endsWith('/files')) return Response.json([{filename: 'project.source.json', status: 'added'}]);
        if (parsed.pathname.endsWith('/pulls/42')) return Response.json({...pr, changed_files: 1});
        return new Response(source(1));
    });
    const pending = read((await closed.load(42, closing.signal)).files[0].loadAsset, 'after');
    closing.abort();
    assert.equal(await pending, null);
    assert.equal(api, apiRequests);
});
