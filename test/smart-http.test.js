import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {join} from 'node:path';
import {test} from 'node:test';
import gitClient from 'isomorphic-git';
import {createGitSmartHttp, MAX_GIT_REQUEST_BYTES} from '../dist/smart-http.js';
import {adapterOptions, commit, git, proxyPath, readDiscovery, remote, startFixture, writeDiscovery} from './smart-http-fixture.js';

const error = code => ({name: 'GitSmartHttpError', code});
const body = (...sizes) => (async function* () {for (const size of sizes) yield new Uint8Array(size);})();
const discovery = {url: remote + readDiscovery};
const receive = {url: remote + '/git-receive-pack', method: 'POST'};

test('adds a fresh ID only to receive-pack POST and treats a duplicate as an unknown push result', async () => {
    const origin = 'http://127.0.0.1:49000';
    const sent = [];
    const requestId = '00000000-0000-4000-8000-000000000001';
    const transport = createGitSmartHttp({...adapterOptions({origin}), fetch: async (url, init) => {
        sent.push({url, id: init.headers.get('Git-Push-Id')});
        if (url.endsWith('/git-receive-pack')) return Response.json({code: 'PUSH_DUPLICATE', requestId}, {status: 409});
        return new Response(new Uint8Array([0]), {headers: {'Content-Type': init.headers.get('Accept')}});
    }});
    for (const request of [{url: remote + writeDiscovery}, discovery,
        {url: remote + '/git-upload-pack', method: 'POST', body: body(1)}]) {
        const response = await transport.http.request(request);
        for await (const _bytes of response.body) {}
    }
    for (let count = 0; count < 2; count++) {
        await assert.rejects(transport.http.request({...receive, body: body(1)}), {
            ...error('PUSH_OUTCOME_UNKNOWN'), statusCode: 409, requestId
        });
    }
    assert.deepEqual(sent.slice(0, 3).map(request => request.id), [null, null, null]);
    const ids = sent.slice(3).map(request => request.id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});

test('Smart HTTP fetch, fast-forward and push agree with Git CLI on real repositories', {timeout: 30000}, async t => {
    const fixture = await startFixture(t);
    const {seed, client, bare} = fixture;
    const transport = createGitSmartHttp(adapterOptions(fixture));
    const args = {fs, dir: client, remote: 'origin', ref: 'main', ...transport};
    const source = join(client, 'project.txt');
    const original = git(client, 'rev-parse', 'HEAD');
    await writeFile(join(seed, 'project.txt'), 'remote change\n');
    const remoteCommit = commit(seed, 'remote change');
    git(seed, 'push', bare, 'main');

    const fetched = await gitClient.fetch(args);
    assert.equal(fetched.fetchHead, remoteCommit);
    assert.equal(git(client, 'rev-parse', 'refs/remotes/origin/main'), remoteCommit);
    assert.equal(git(client, 'rev-parse', 'HEAD'), original);
    assert.equal(await readFile(source, 'utf8'), 'initial\n');

    await gitClient.fastForward(args);
    assert.equal(git(client, 'rev-parse', 'HEAD'), remoteCommit);
    assert.equal(await readFile(source, 'utf8'), 'remote change\n');

    await writeFile(source, 'local change\n');
    const pushed = commit(client, 'local change');
    const push = await gitClient.push({...args, force: false});
    assert.equal(push.ok, true);
    assert.equal(git(bare, 'rev-parse', 'main'), pushed);
    assert.equal(git(bare, 'show', 'main:project.txt'), 'local change');

    await writeFile(source, 'server commits the push before the response drops\n');
    const ambiguous = commit(client, 'dropped response');
    fixture.dropPush = true;
    const priorWrites = fixture.upstream.filter(req => req.method === 'POST' && req.path.endsWith('/git-receive-pack')).length;
    await assert.rejects(gitClient.push({...args, force: false}), error('PUSH_OUTCOME_UNKNOWN'));
    assert.equal(git(bare, 'rev-parse', 'main'), ambiguous);
    assert.equal(fixture.upstream.filter(req => req.method === 'POST' && req.path.endsWith('/git-receive-pack')).length,
        priorWrites + 1);
    fixture.dropPush = false;

    git(seed, 'pull', '--ff-only', bare, 'main');
    await writeFile(join(seed, 'project.txt'), 'diverging remote\n');
    const diverged = commit(seed, 'diverging remote');
    git(seed, 'push', bare, 'main');
    await writeFile(source, 'diverging local\n');
    const local = commit(client, 'diverging local');
    await writeFile(join(client, 'untracked.txt'), 'keep this\n');
    const index = await readFile(join(client, '.git/index'));
    await assert.rejects(gitClient.fastForward(args), {code: 'FastForwardError'});
    assert.equal(git(client, 'rev-parse', 'HEAD'), local);
    assert.equal(git(client, 'rev-parse', 'refs/remotes/origin/main'), diverged);
    assert.equal(await readFile(source, 'utf8'), 'diverging local\n');
    assert.equal(await readFile(join(client, 'untracked.txt'), 'utf8'), 'keep this\n');
    assert.deepEqual(await readFile(join(client, '.git/index')), index);
    assert.equal(git(client, 'config', 'http.corsProxy'), 'https://rejected.example.invalid');
    assert.equal(git(client, 'config', 'remote.origin.url'), remote);
    assert.ok(fixture.upstream.every(req => req.authorization === 'Basic ' +
        Buffer.from('x-access-token:fixture-upstream-token').toString('base64')));
    assert.ok(fixture.requests.every(req => !req.url.includes('fixture-write') && !req.headers.cookie));
});

test('adapter rejects untrusted inputs before sending a request', async () => {
    const fixture = {origin: 'http://127.0.0.1:49000'};
    let sent = 0;
    const options = {...adapterOptions(fixture), fetch: async () => {
        sent++;
        return new Response('fixture', {headers: {'Content-Type': 'application/x-git-upload-pack-advertisement'}});
    }};
    for (const value of [
        'http://github.com/fixture/work.git', 'https://fixture@github.com/fixture/work.git',
        'https://github.com:443/fixture/work.git', 'https://github.com.evil/fixture/work.git',
        'https://github.com/fixture/other/../work.git', 'https://github.com/fixture/%2ework.git',
        'https://github.com/fixture/work.git?token=fixture', 'https://github.com/fixture/work.git#ref',
        'https://github.com/fixture/..', 'https://github.com/fixture/Kelvin', 'https://github.com/fixture/work.git\n'
    ]) assert.throws(() => createGitSmartHttp({...options, remote: value}), error('INVALID_REMOTE'));
    for (const connection of [
        {mode: 'desktop', proxyOrigin: 'http://localhost:49000'},
        {mode: 'desktop', proxyOrigin: 'http://127.0.0.1:49000/extra'},
        {mode: 'cloudflare', proxyOrigin: fixture.origin}
    ]) assert.throws(() => createGitSmartHttp({...options, connection}), error('INVALID_CONNECTION'));

    const {http} = createGitSmartHttp({...options, maxRequestBytes: 8});
    for (const request of [
        {url: 'https://github.com/fixture/other.git' + readDiscovery},
        {url: remote + readDiscovery + '&service=git-receive-pack'},
        {url: remote + '/objects/info/packs'}, {url: remote + '/info/refs'},
        {...discovery, method: 'PUT'}, {...discovery, body: body(1)}, receive
    ]) await assert.rejects(http.request(request), error('INVALID_REQUEST'));
    await assert.rejects(http.request({...receive, body: body(4, 5)}), error('PAYLOAD_TOO_LARGE'));
    assert.throws(() => createGitSmartHttp({...options, maxRequestBytes: MAX_GIT_REQUEST_BYTES + 1}), error('INVALID_CONNECTION'));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(http.request({...discovery, signal: controller.signal}), error('ABORTED'));

    const session = await options.getSession();
    for (const [candidate, code] of [
        [null, 'SESSION_REQUIRED'], [{...session, expiresAt: 0}, 'SESSION_EXPIRED'],
        [{...session, connection: {...session.connection, mode: 'cloudflare'}}, 'INVALID_SESSION'],
        [{...session, connection: {...session.connection, proxyOrigin: 'http://127.0.0.1:49001'}}, 'INVALID_SESSION'],
        [{...session, bearer: 'fixture\r\nCookie: leak'}, 'INVALID_SESSION']
    ]) await assert.rejects(createGitSmartHttp({...options, getSession: async () => candidate}).http.request(discovery), error(code));
    await assert.rejects(createGitSmartHttp({...options, getSession() {throw Error('fixture secret');}})
        .http.request(discovery), error('SESSION_UNAVAILABLE'));
    assert.equal(sent, 0);
});

test('fixture rejects disallowed CORS, permissions, redirects, and invalid transfer lengths', {timeout: 30000}, async t => {
    const fixture = await startFixture(t);
    const url = fixture.origin + proxyPath(readDiscovery);
    const origin = 'https://editor.example.invalid';
    const call = (headers, init = {}, path = readDiscovery) => fetch(fixture.origin + proxyPath(path), {...init, headers});
    const auth = {Origin: origin, Authorization: 'Bearer fixture-write'};
    const preflight = {'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization'};

    const badHost = await new Promise((resolve, reject) => {
        httpRequest(url, {headers: {...auth, Host: 'rebinding.example.invalid'}}, response => {
            response.resume();
            resolve(response.statusCode);
        }).on('error', reject).end();
    });
    assert.equal(badHost, 403);

    const allowed = await call({Origin: origin, ...preflight}, {method: 'OPTIONS'});
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
    for (const [headers, init, path, status] of [
        [{...auth, Origin: 'null'}, {}, readDiscovery, 403],
        [{...auth, Origin: 'https://wrong.example.invalid'}, {}, readDiscovery, 403],
        [{Authorization: auth.Authorization}, {}, readDiscovery, 403],
        [{Origin: origin, ...preflight, 'Access-Control-Request-Headers': 'authorization, x-custom'}, {method: 'OPTIONS'}, readDiscovery, 403],
        [auth, {method: 'DELETE'}, readDiscovery, 400],
        [auth, {}, readDiscovery + '&url=https://wrong.example.invalid', 400],
        [{...auth, 'Content-Type': 'application/x-git-receive-pack-request'},
            {method: 'POST', body: new Uint8Array(1024 * 1024 + 1)}, '/git-receive-pack', 413],
        [{...auth, 'Content-Type': 'application/x-git-receive-pack-request'},
            {method: 'POST', body: new ReadableStream({start(controller) {controller.enqueue(Uint8Array.of(1)); controller.close();}}),
                duplex: 'half'}, '/git-receive-pack', 411]
    ]) {
        const response = await call(headers, init, path);
        assert.equal(response.status, status, JSON.stringify({headers, method: init.method, path}));
        await response.body?.cancel();
    }
    for (const [bearer, path, code] of [
        ['revoked-token', readDiscovery, 'SESSION_REQUIRED'], ['fixture-expired', readDiscovery, 'SESSION_EXPIRED'],
        ['fixture-cloudflare', readDiscovery, 'FORBIDDEN'], ['fixture-read', writeDiscovery, 'FORBIDDEN']
    ]) await assert.rejects(createGitSmartHttp(adapterOptions(fixture, bearer)).http.request({url: remote + path}), error(code));
    fixture.redirect = 'upstream';
    await assert.rejects(createGitSmartHttp(adapterOptions(fixture)).http.request(discovery), error('REDIRECT_REJECTED'));
    fixture.redirect = 'proxy';
    await assert.rejects(createGitSmartHttp(adapterOptions(fixture)).http.request(discovery), error('NETWORK_ERROR'));
    assert.equal(fixture.requests.some(req => req.url === '/redirect-target'), false);
    assert.deepEqual(fixture.upstream, []);
});

test('adapter bounds uploads, streams successful responses, and sanitizes errors', async () => {
    const origin = 'https://proxy.example.invalid';
    const connection = {mode: 'cloudflare', proxyOrigin: origin};
    const options = {remote, connection, getSession: async () => ({connection, bearer: 'fixture-session',
        expiresAt: Date.now() + 60_000}), maxRequestBytes: 8};
    const sent = [];
    const transport = createGitSmartHttp({...options, fetch: async (url, init) => {
        sent.push({url, init});
        return new Response(new ReadableStream({
            start(controller) {controller.enqueue(Uint8Array.of(1)); controller.enqueue(Uint8Array.of(2)); controller.close();}
        }), {headers: {'Content-Type': 'application/x-git-receive-pack-result', 'Set-Cookie': 'fixture-cookie'}});
    }});
    const response = await transport.http.request({...receive, body: body(4, 4),
        headers: {Authorization: 'spoof', Cookie: 'spoof', 'Git-Protocol': 'version=2'}, fetchOptions: {redirect: 'follow'}});
    assert.deepEqual(await Array.fromAsync(response.body), [Uint8Array.of(1), Uint8Array.of(2)]);
    assert.deepEqual(response.headers, {'content-type': 'application/x-git-receive-pack-result'});
    assert.equal(sent.length, 1);
    const [{url, init}] = sent;
    assert.equal(url, origin + proxyPath('/git-receive-pack'));
    assert.equal(init.body.size, 8);
    assert.equal(init.headers.get('authorization'), 'Bearer fixture-session');
    assert.equal(init.headers.has('cookie'), false);
    assert.equal(init.headers.has('git-protocol'), false);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.referrerPolicy, 'no-referrer');

    const rejected = createGitSmartHttp({...options, fetch: async () => new Response(
        JSON.stringify({code: 'forged-fixture-secret', requestId: 'fixture-secret', message: 'fixture-secret'}),
        {status: 413, headers: {'Content-Type': 'application/json'}})});
    await assert.rejects(rejected.http.request({...receive, body: body(1)}), {
        ...error('PAYLOAD_TOO_LARGE'), message: 'PAYLOAD_TOO_LARGE', requestId: undefined, statusCode: 413
    });
    const interrupted = createGitSmartHttp({...options, fetch: async () => new Response(new ReadableStream({
        start(controller) {controller.error(new Error('fixture-secret'));}
    }), {headers: {'Content-Type': 'application/x-git-receive-pack-result'}})});
    const streamed = await interrupted.http.request({...receive, body: body(1)});
    await assert.rejects(Array.fromAsync(streamed.body), error('PUSH_OUTCOME_UNKNOWN'));
});
