import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {GitPanelError, openRepository} from '../dist/repository.js';
import {directoryHandle} from './directory.js';
import {commit, git, remote, startFixture} from './smart-http-fixture.js';

test('panel operations preserve worktrees on rejected pulls and never retry an uncertain push', async t => {
    const fixture = await startFixture(t);
    const {client, seed, bare} = fixture;
    const source = join(client, 'project.txt');
    const files = [source, join(client, '.git/index'), join(client, '.git/config')];
    const capture = () => Promise.all(files.map(file => readFile(file)));
    const fetch = globalThis.fetch;
    let editDuringRequest = false;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        if (editDuringRequest) {
            editDuringRequest = false;
            await writeFile(source, 'external edit during network request\n');
        }
        const headers = new Headers(init.headers);
        headers.set('Origin', 'https://editor.example.invalid');
        return fetch(url, {...init, headers});
    });
    let allowWrite = false;
    const session = async (target, write) => {
        assert.equal(target, remote);
        if (write && !allowWrite) return null;
        return {connection: {mode: 'desktop', proxyOrigin: fixture.origin},
            bearer: allowWrite ? 'fixture-write' : 'fixture-read', expiresAt: Date.now() + 60000};
    };
    let failPath;
    const repository = await openRepository(directoryHandle(client, filename => {
        if (filename === failPath) {failPath = undefined; throw new Error('Fixture write failure');}
    }));
    const operate = (action, guard = () => {}) => repository.remoteOperation(action, session, guard);
    const initial = git(client, 'rev-parse', 'HEAD');
    assert.equal((await repository.read()).upstream.state, 'same');
    const beforeFetch = await capture();
    await writeFile(join(seed, 'project.txt'), 'incoming\n');
    const incoming = commit(seed, 'incoming');
    git(seed, 'push', bare, 'main');
    await operate('fetch');
    assert.equal(git(client, 'rev-parse', 'refs/remotes/origin/main'), incoming);
    assert.equal(git(client, 'rev-parse', 'HEAD'), initial);
    assert.deepEqual(await capture(), beforeFetch);
    assert.deepEqual((await repository.read()).upstream, {state: 'behind', ahead: 0, behind: 1});

    await writeFile(source, 'local edit\n');
    const dirty = await capture();
    const requestCount = fixture.requests.length;
    await assert.rejects(operate('pull'), {code: 'pullUnsafe'});
    assert.equal(fixture.requests.length, requestCount);
    assert.deepEqual(await capture(), dirty);
    await writeFile(source, 'initial\n');
    editDuringRequest = true;
    await assert.rejects(operate('pull'), {code: 'changed'});
    assert.equal(git(client, 'rev-parse', 'HEAD'), initial);
    assert.equal(await readFile(source, 'utf8'), 'external edit during network request\n');
    await writeFile(source, 'initial\n');
    await assert.rejects(operate('pull', () => {throw new GitPanelError('pullUnsafe');}), {code: 'pullUnsafe'});
    failPath = join(client, '.git/index');
    const beforeWriteFailure = await capture();
    await assert.rejects(operate('pull'), /Fixture write failure/);
    assert.equal(git(client, 'rev-parse', 'HEAD'), initial);
    assert.deepEqual(await capture(), beforeWriteFailure);
    await operate('pull');
    assert.equal(git(client, 'rev-parse', 'HEAD'), incoming);
    assert.equal(await readFile(source, 'utf8'), 'incoming\n');
    assert.equal(git(client, 'status', '--porcelain'), '');

    const writesBefore = fixture.upstream.length;
    await assert.rejects(operate('push'), {code: 'session'});
    assert.equal(fixture.upstream.length, writesBefore);
    allowWrite = true;
    await writeFile(source, 'outgoing\n');
    const pushed = commit(client, 'outgoing');
    await operate('push');
    assert.equal(git(bare, 'rev-parse', 'main'), pushed);
    assert.equal(git(bare, 'show', 'main:project.txt'), 'outgoing');
    await writeFile(source, 'response dropped\n');
    const uncertain = commit(client, 'response dropped');
    fixture.dropPush = true;
    const writeCount = () => fixture.upstream.filter(request => request.method === 'POST' &&
        request.path.endsWith('/git-receive-pack')).length;
    const count = writeCount();
    await assert.rejects(operate('push'), {code: 'pushUnknown'});
    assert.equal(writeCount(), count + 1);
    assert.equal(git(bare, 'rev-parse', 'main'), uncertain);
    assert.equal(git(client, 'rev-parse', 'refs/remotes/origin/main'), pushed);
    await assert.rejects(operate('push'), {code: 'pushUnknown'});
    assert.equal(writeCount(), count + 1);
    fixture.dropPush = false;
    await operate('fetch');
    assert.equal(git(client, 'rev-parse', 'refs/remotes/origin/main'), uncertain);

    git(seed, 'pull', '--ff-only', bare, 'main');
    await writeFile(join(seed, 'project.txt'), 'diverged remotely\n');
    commit(seed, 'diverged remotely');
    git(seed, 'push', bare, 'main');
    await writeFile(source, 'diverged locally\n');
    const local = commit(client, 'diverged locally');
    const beforeDiverged = await capture();
    await assert.rejects(operate('pull'), {code: 'diverged'});
    assert.equal(git(client, 'rev-parse', 'HEAD'), local);
    assert.equal(git(client, 'rev-parse', 'refs/remotes/origin/main'), uncertain);
    assert.deepEqual(await capture(), beforeDiverged);
});

test('a push response that fails after its report-status leaves the outcome unknown', async t => {
    const fixture = await startFixture(t);
    const {client, bare} = fixture;
    const fetch = globalThis.fetch;
    let truncate = false;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        const headers = new Headers(init.headers);
        headers.set('Origin', 'https://editor.example.invalid');
        const response = await fetch(url, {...init, headers});
        if (!truncate || init.method !== 'POST') return response;
        const bytes = new Uint8Array(await response.arrayBuffer());
        const body = new ReadableStream({
            start(controller) {controller.enqueue(bytes);},
            pull(controller) {controller.error(new TypeError('network error'));}
        });
        return new Response(body, {status: response.status, headers: response.headers});
    });
    const session = async () => ({connection: {mode: 'desktop', proxyOrigin: fixture.origin},
        bearer: 'fixture-write', expiresAt: Date.now() + 60000});
    const repository = await openRepository(directoryHandle(client));
    const tracking = git(client, 'rev-parse', 'refs/remotes/origin/main');
    await writeFile(join(client, 'project.txt'), 'truncated response\n');
    const pushed = commit(client, 'truncated response');
    truncate = true;
    await assert.rejects(repository.remoteOperation('push', session, () => {}), {code: 'pushUnknown'});
    assert.equal(git(bare, 'rev-parse', 'main'), pushed);
    assert.equal(git(client, 'rev-parse', 'refs/remotes/origin/main'), tracking);
});
