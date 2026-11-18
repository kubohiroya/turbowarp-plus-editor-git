import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cloneRemoteProject, writeClonedProject} from '../dist/remote-repository.js';
import {openRepository} from '../dist/repository.js';
import {directoryHandle} from './directory.js';
import {adapterOptions, git, remote, startFixture} from './smart-http-fixture.js';

const project = '{"targets":[]}\n';
const source = '{"assets":"assets"}\n';

function cloneOptions(fixture, extra = {}) {
    const {connection, fetch} = adapterOptions(fixture, 'fixture-read');
    const asked = [];
    return {asked, options: {
        remote: 'https://github.com/fixture/work', fetch,
        async getSession(target, write) {
            asked.push([target, write]);
            return {connection, bearer: 'fixture-read', expiresAt: Date.now() + 60_000};
        },
        ...extra
    }};
}

async function emptyFolder(t) {
    const path = await mkdtemp(join(tmpdir(), 'tw-plus-clone-'));
    t.after(() => rm(path, {recursive: true, force: true}));
    return path;
}

const commitAll = (dir, message) => {
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message);
    return git(dir, 'rev-parse', 'HEAD');
};

// The remote's HEAD names `trunk`, which has the project at its root; `main` has none.
async function publishProject(fixture, files = {}) {
    const {seed, bare} = fixture;
    git(seed, 'switch', '-q', '-c', 'trunk');
    await mkdir(join(seed, 'assets'));
    await writeFile(join(seed, 'project.source.json'), project);
    await writeFile(join(seed, 'sb3-source.json'), source);
    await writeFile(join(seed, 'assets', 'costume.svg'), '<svg/>');
    commitAll(seed, 'add the project');
    for (const [name, text] of Object.entries(files)) await writeFile(join(seed, name), text);
    await writeFile(join(seed, 'project.source.json'), '{"targets":[1]}\n');
    const head = commitAll(seed, 'change the project');
    git(seed, 'push', '-q', bare, 'trunk');
    git(seed, 'tag', 'v1');
    git(seed, 'push', '-q', bare, 'v1');
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
    return head;
}

test('clones the default branch with a root project in memory and writes it into an empty folder', async t => {
    const fixture = await startFixture(t);
    const head = await publishProject(fixture);
    const {asked, options} = cloneOptions(fixture);
    const phases = new Set();
    const result = await cloneRemoteProject({...options, onProgress: event => phases.add(event.phase)});
    assert.equal(result.ok, true);
    const {snapshot} = result;
    assert.equal(snapshot.remote, remote);
    assert.equal(snapshot.branch, 'trunk');
    assert.equal(snapshot.head, head);
    assert.ok(phases.size > 0);
    assert.ok(asked.length > 0 && asked.every(([target, write]) => target === remote && write === false));
    const paths = snapshot.entries.map(entry => entry.path);
    for (const path of ['/project.source.json', '/sb3-source.json', '/assets/costume.svg', '/.git/HEAD', '/.git/config', '/.git/index'])
        assert.ok(paths.includes(path), path);
    assert.ok(!paths.some(path => path.startsWith('/project/')));
    // Nothing was sent to GitHub but reads.
    assert.ok(fixture.upstream.every(request => !request.path.endsWith('/git-receive-pack')));

    const path = await emptyFolder(t);
    assert.deepEqual(await writeClonedProject(directoryHandle(path), snapshot), {branch: 'trunk', head});
    assert.equal(await readFile(join(path, 'project.source.json'), 'utf8'), '{"targets":[1]}\n');
    assert.equal(await readFile(join(path, 'sb3-source.json'), 'utf8'), source);
    assert.equal(git(path, 'rev-parse', 'HEAD'), head);
    assert.equal(git(path, 'symbolic-ref', 'HEAD'), 'refs/heads/trunk');
    assert.equal(git(path, 'rev-parse', 'refs/remotes/origin/trunk'), head);
    assert.equal(git(path, 'rev-list', '--count', 'HEAD'), '3');
    assert.equal(git(path, 'status', '--porcelain'), '');
    assert.equal(git(path, 'config', 'remote.origin.url'), remote);
    assert.equal(git(path, 'config', '--get-all', 'remote.origin.fetch'), '+refs/heads/*:refs/remotes/origin/*');
    assert.equal(git(path, 'config', 'branch.trunk.remote'), 'origin');
    assert.equal(git(path, 'config', 'branch.trunk.merge'), 'refs/heads/trunk');
    assert.equal(git(path, 'tag', '--list'), '');
    // Like Git's clone: only the default branch, and origin/HEAD naming it.
    assert.equal(git(path, 'for-each-ref', '--format=%(refname)', 'refs/remotes'), 'refs/remotes/origin/HEAD\nrefs/remotes/origin/trunk');
    assert.equal(git(path, 'symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/trunk');
    git(path, 'fsck', '--no-dangling');
    const repository = await openRepository(directoryHandle(path));
    assert.equal(await repository.defaultProject(await repository.browse()), '');
});

test('a repository without a project at the root of its default branch is not cloned', async t => {
    const fixture = await startFixture(t);
    const {options} = cloneOptions(fixture);
    // The fixture's main branch has only project.txt.
    assert.deepEqual(await cloneRemoteProject(options), {ok: false, reason: 'not-project'});

    // A project in a project/ folder is not a project at the root.
    const {seed, bare} = fixture;
    await mkdir(join(seed, 'project'));
    await writeFile(join(seed, 'project', 'project.source.json'), project);
    await writeFile(join(seed, 'project', 'sb3-source.json'), source);
    commitAll(seed, 'project in a folder');
    git(seed, 'push', '-q', bare, 'main');
    assert.deepEqual(await cloneRemoteProject(options), {ok: false, reason: 'not-project'});
    assert.ok(fixture.upstream.every(request => !request.path.endsWith('/git-receive-pack')));
});

test('rejects entries the browser cannot write, bad URLs and missing sessions', async t => {
    const fixture = await startFixture(t);
    await publishProject(fixture, {'run.sh': '#!/bin/sh\n'});
    await chmod(join(fixture.seed, 'run.sh'), 0o755);
    commitAll(fixture.seed, 'make it executable');
    git(fixture.seed, 'push', '-q', fixture.bare, 'trunk');
    const {options} = cloneOptions(fixture);
    assert.deepEqual(await cloneRemoteProject(options), {ok: false, reason: 'unsupported', path: 'run.sh'});
    assert.deepEqual(await cloneRemoteProject({...options, remote: 'https://github.com/fixture/work/'}),
        {ok: false, reason: 'invalid-remote'});
    assert.deepEqual(await cloneRemoteProject({...options, getSession: async () => null}), {ok: false, reason: 'auth'});
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await assert.rejects(cloneRemoteProject({...options, signal: controller.signal}), /cancelled/u);
});

test('the writer refuses a folder that is not empty and writes nothing', async t => {
    const fixture = await startFixture(t);
    await publishProject(fixture);
    const {options} = cloneOptions(fixture);
    const {snapshot} = await cloneRemoteProject(options);
    const path = await emptyFolder(t);
    await writeFile(join(path, 'notes.txt'), 'mine\n');
    await assert.rejects(writeClonedProject(directoryHandle(path), snapshot), {code: 'notEmpty'});
    assert.deepEqual(await readdir(path), ['notes.txt']);
});
