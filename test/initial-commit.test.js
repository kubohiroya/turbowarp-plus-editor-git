import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareInitialRepository, publishInitialCommit, pushInitialRepository} from '../dist/initial-commit.js';
import {directoryHandle} from './directory.js';
import {adapterOptions, git, remote, startFixture, writeDiscovery} from './smart-http-fixture.js';

const encode = text => new TextEncoder().encode(text);
const files = [
    {path: 'README.md', bytes: encode('# Fixture\n')},
    {path: '.gitignore', bytes: encode('/ignored.bin\n')},
    {path: 'ignored.bin', bytes: Uint8Array.of(0, 1, 255)},
    {path: 'project/project.source.json', bytes: encode('{"targets":[]}\n')}
];
const receivePosts = fixture => fixture.upstream.filter(request =>
    request.method === 'POST' && request.path.endsWith('/git-receive-pack')).length;
const operationId = '00000000-0000-4000-8000-000000000001';

async function localRoot(t) {
    const path = await mkdtemp(join(tmpdir(), 'tw-plus-initial-'));
    t.after(() => rm(path, {recursive: true, force: true}));
    return path;
}

function options(fixture) {
    const transport = adapterOptions(fixture);
    return {
        remote, repositoryId: 7, files, timestamp: 1_765_000_000,
        author: {name: 'Initial commit', email: 'author@example.invalid'},
        fetch: transport.fetch,
        prepared: async () => {},
        getWriteGrant: async target => {
            assert.deepEqual(target, {remote, repositoryId: 7});
            return {...target, session: await transport.getSession()};
        }
    };
}

test('publishes the complete first commit and reconciles the same OID after an uncertain response', async t => {
    const fixture = await startFixture(t);
    git(fixture.bare, 'update-ref', '-d', 'refs/heads/main');
    const input = options(fixture);
    let prepared;
    let requestsBefore = 0;
    input.prepared = async oid => {
        assert.equal(fixture.requests.length, requestsBefore);
        if (prepared) assert.equal(oid, prepared);
        prepared = oid;
    };
    fixture.dropPush = true;
    await assert.rejects(publishInitialCommit(input), {code: 'pushUnknown'});
    assert.equal(receivePosts(fixture), 1);
    assert.equal(git(fixture.bare, 'rev-parse', 'main'), prepared);
    fixture.dropPush = false;
    requestsBefore = fixture.requests.length;
    assert.deepEqual(await publishInitialCommit(input), {oid: prepared});
    assert.equal(receivePosts(fixture), 1);
    assert.equal(git(fixture.bare, 'rev-list', '--count', 'main'), '1');
    assert.equal(git(fixture.bare, 'show', 'main:README.md'), '# Fixture');
    assert.equal(git(fixture.bare, 'show', 'main:project/project.source.json'), '{"targets":[]}');
    assert.deepEqual(execFileSync('git', ['show', 'main:ignored.bin'], {cwd: fixture.bare}), Buffer.from([0, 1, 255]));
});

test('refuses nonempty or differently authorized repositories', async t => {
    const fixture = await startFixture(t);
    const input = options(fixture);
    const head = git(fixture.bare, 'rev-parse', 'main');
    await assert.rejects(publishInitialCommit(input), {code: 'diverged'});
    assert.equal(receivePosts(fixture), 0);
    assert.equal(git(fixture.bare, 'rev-parse', 'main'), head);
    const getWriteGrant = input.getWriteGrant;
    const calls = fixture.requests.length;
    await assert.rejects(publishInitialCommit({...input, async getWriteGrant(target) {
        return {...await getWriteGrant(target), repositoryId: 8};
    }}), {code: 'session'});
    await assert.rejects(publishInitialCommit({...input, async getWriteGrant(target) {
        const grant = await getWriteGrant(target);
        return {...grant, session: {...grant.session, repositoryId: 8}};
    }}), {code: 'session'});
    assert.equal(fixture.requests.length, calls);
    await assert.rejects(publishInitialCommit({...input, async prepared() {
        throw new Error('Journal unavailable');
    }}), /Journal unavailable/u);
    assert.equal(fixture.requests.length, calls);
});

test('refuses a branch created by another client between discovery and push', async t => {
    const fixture = await startFixture(t);
    const old = git(fixture.bare, 'rev-parse', 'main');
    git(fixture.bare, 'update-ref', '-d', 'refs/heads/main');
    const input = options(fixture);
    const send = input.fetch;
    let discoveries = 0;
    input.fetch = async (url, init) => {
        if (String(url).endsWith(writeDiscovery) && ++discoveries === 2)
            git(fixture.bare, 'update-ref', 'refs/heads/main', old);
        return send(url, init);
    };
    await assert.rejects(publishInitialCommit(input), {code: 'diverged'});
    assert.equal(receivePosts(fixture), 0);
    assert.equal(git(fixture.bare, 'rev-parse', 'main'), old);
});

test('prepares the selected folder as a Git worktree, then publishes exactly its first commit', async t => {
    const fixture = await startFixture(t);
    git(fixture.bare, 'update-ref', '-d', 'refs/heads/main');
    const path = await localRoot(t);
    const directory = directoryHandle(path);
    const input = {...options(fixture), operationId, directory, author: {
        name: 'Initial # commit', email: 'author@example.invalid'
    }, files: [
        ...files,
        {path: 'LICENSE', bytes: encode('Fixture license\n')}
    ]};

    const prepared = await prepareInitialRepository(input);
    assert.equal(prepared.branch, 'main');
    assert.equal(fixture.requests.length, 0);
    assert.equal(git(path, 'rev-parse', 'HEAD'), prepared.oid);
    assert.equal(git(path, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(git(path, 'status', '--short'), '');
    assert.equal(git(path, 'remote', 'get-url', 'origin'), remote);
    assert.equal(git(path, 'config', 'branch.main.merge'), 'refs/heads/main');
    assert.equal(git(path, 'config', '--local', 'user.name'), input.author.name);
    assert.equal(git(path, 'config', '--local', 'user.email'), input.author.email);
    assert.equal(await readFile(join(path, 'README.md'), 'utf8'), '# Fixture\n');
    assert.equal(await readFile(join(path, 'LICENSE'), 'utf8'), 'Fixture license\n');
    assert.equal(await readFile(join(path, 'project', 'project.source.json'), 'utf8'), '{"targets":[]}\n');
    assert.deepEqual(await prepareInitialRepository(input), prepared);

    await assert.rejects(pushInitialRepository({...input, oid: 'e'.repeat(40)}), {code: 'changed'});
    assert.equal(fixture.requests.length, 0);
    const results = await Promise.all([
        pushInitialRepository({...input, oid: prepared.oid}),
        pushInitialRepository({...input, oid: prepared.oid})
    ]);
    assert.deepEqual(results, [prepared, prepared]);
    assert.equal(receivePosts(fixture), 1);
    assert.equal(git(fixture.bare, 'rev-parse', 'main'), prepared.oid);
    assert.equal(git(path, 'rev-parse', 'origin/main'), prepared.oid);
    assert.equal(git(path, 'status', '--short'), '');
    git(fixture.bare, 'update-ref', '-d', 'refs/heads/main');
    await assert.rejects(pushInitialRepository({...input, oid: prepared.oid}), {code: 'diverged'});
    assert.equal(receivePosts(fixture), 1);
});

test('resumes an interrupted local initialization only for the same inputs', async t => {
    const fixture = await startFixture(t);
    const path = await localRoot(t);
    let interrupted = true;
    const directory = directoryHandle(path, filename => {
        if (interrupted && filename.endsWith('project.source.json')) {
            interrupted = false;
            throw new Error('local write interrupted');
        }
    });
    const input = {...options(fixture), operationId, directory};
    await assert.rejects(prepareInitialRepository(input), /local write interrupted/u);
    assert.deepEqual(await readdir(join(path, 'project')), []);
    assert.equal(await readFile(join(path, 'README.md'), 'utf8'), '# Fixture\n');
    await assert.rejects(prepareInitialRepository({...input, timestamp: input.timestamp + 1}), {code: 'changed'});
    await assert.rejects(prepareInitialRepository({
        ...input, operationId: '00000000-0000-4000-8000-000000000002'
    }), {code: 'changed'});

    await writeFile(join(path, 'README.md'), 'Locally edited\n');
    await assert.rejects(prepareInitialRepository(input), {code: 'changed'});
    assert.equal(await readFile(join(path, 'README.md'), 'utf8'), 'Locally edited\n');
    await writeFile(join(path, 'README.md'), '# Fixture\n');
    const {oid} = await prepareInitialRepository(input);
    assert.equal(git(path, 'rev-parse', 'HEAD'), oid);
    assert.equal(git(path, 'status', '--short'), '');
    assert.equal(fixture.requests.length, 0);
});

test('keeps existing folders and existing Git metadata untouched', async t => {
    const fixture = await startFixture(t);
    const path = await localRoot(t);
    const input = {...options(fixture), operationId, directory: directoryHandle(path)};
    await writeFile(join(path, 'existing.txt'), 'existing');
    await assert.rejects(prepareInitialRepository(input), {code: 'changed'});
    assert.deepEqual(await readdir(path), ['existing.txt']);
    await mkdir(join(path, '.git'));
    await assert.rejects(prepareInitialRepository(input), {code: 'changed'});
    assert.deepEqual(await readdir(join(path, '.git')), []);
    assert.equal(await readFile(join(path, 'existing.txt'), 'utf8'), 'existing');
    assert.equal(fixture.requests.length, 0);
});

test('reconciles an uncertain push and repairs tracking state without sending again', async t => {
    const fixture = await startFixture(t);
    git(fixture.bare, 'update-ref', '-d', 'refs/heads/main');
    const path = await localRoot(t);
    const input = {...options(fixture), operationId, directory: directoryHandle(path)};
    const prepared = await prepareInitialRepository(input);
    fixture.dropPush = true;
    await assert.rejects(pushInitialRepository({...input, oid: prepared.oid}), {code: 'pushUnknown'});
    assert.equal(git(fixture.bare, 'rev-parse', 'main'), prepared.oid);
    fixture.dropPush = false;
    assert.deepEqual(await pushInitialRepository({...input, oid: prepared.oid}), prepared);
    assert.equal(git(path, 'rev-parse', 'origin/main'), prepared.oid);
    assert.equal(receivePosts(fixture), 1);
});

test('records an accepted push before a failed local tracking update', async t => {
    const fixture = await startFixture(t);
    git(fixture.bare, 'update-ref', '-d', 'refs/heads/main');
    const path = await localRoot(t);
    const directory = directoryHandle(path, filename => {
        if (filename.endsWith('/refs/remotes/origin/main')) throw new Error('local tracking unavailable');
    });
    const input = {...options(fixture), operationId, directory};
    const prepared = await prepareInitialRepository(input);
    await assert.rejects(pushInitialRepository({...input, oid: prepared.oid}), {code: 'pushRefresh'});
    assert.equal(git(fixture.bare, 'rev-parse', 'main'), prepared.oid);
    git(fixture.bare, 'update-ref', '-d', 'refs/heads/main');
    await assert.rejects(pushInitialRepository({
        ...input, directory: directoryHandle(path), oid: prepared.oid
    }), {code: 'diverged'});
    assert.equal(receivePosts(fixture), 1);
});
