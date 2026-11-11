import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {GitPanelError, openRepository, pullRequestRef} from '../dist/repository.js';
import {pullRequestBranch} from '../dist/index.js';
import {directoryHandle} from './directory.js';
import {commit, git, publishPullRequest, remote, startFixture} from './smart-http-fixture.js';

const project = steps => JSON.stringify({targets: [{name: 'Sprite', isStage: false, currentCostume: 0,
    costumes: [{name: 'look', assetId: 'a'.repeat(32), md5ext: 'a'.repeat(32) + '.svg', dataFormat: 'svg'}],
    blocks: {move: {opcode: 'motion_movesteps', topLevel: true, inputs: {STEPS: [1, [4, String(steps)]]}}}}]}, null, 2) + '\n';
const asset = 'a'.repeat(32) + '.svg';
const svg = color => `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${color}"/></svg>\n`;

function withOrigin(t) {
    const fetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (url, init) => {
        const headers = new Headers(init.headers);
        headers.set('Origin', 'https://editor.example.invalid');
        return fetch(url, {...init, headers});
    });
}

const sessionFor = (fixture, bearer = 'fixture-read', proxyOrigin = fixture.origin) => async (target, write) => {
    assert.equal(target, remote);
    assert.equal(write, false);
    return {connection: {mode: 'desktop', proxyOrigin}, bearer, expiresAt: Date.now() + 60000};
};

async function listFiles(dir, prefix = '') {
    const result = [];
    for (const entry of await readdir(join(dir, prefix), {withFileTypes: true})) {
        if (entry.name === '.git') continue;
        const path = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) result.push(...await listFiles(dir, path));
        else result.push([path, await readFile(join(dir, path), 'utf8')]);
    }
    return result.sort();
}

/** The work tree, index, HEAD, config and local branches: none of them may change when a pull request is fetched. */
async function localState(client) {
    return {files: await listFiles(client), index: await readFile(join(client, '.git/index')),
        head: await readFile(join(client, '.git/HEAD'), 'utf8'), config: await readFile(join(client, '.git/config'), 'utf8'),
        branches: git(client, 'for-each-ref', 'refs/heads'), status: git(client, '--no-optional-locks', 'status', '--porcelain')};
}

async function seedProject(fixture) {
    const {seed, bare} = fixture;
    await mkdir(join(seed, 'game/assets'), {recursive: true});
    await writeFile(join(seed, 'game/project.source.json'), project(10));
    await writeFile(join(seed, 'game/assets', asset), svg('red'));
    await writeFile(join(seed, 'notes.txt'), 'notes\n');
    git(seed, 'add', '-A');
    commit(seed, 'add the game');
    git(seed, 'push', '-q', bare, 'main');
}

test('a fork pull request is fetched from refs/pull/<n>/head over the connection and compared from local objects', async t => {
    const fixture = await startFixture(t);
    const {client, seed, bare} = fixture;
    withOrigin(t);
    await seedProject(fixture);
    const {dir: fork, head} = await publishPullRequest(fixture, 7, {fork: true, edit: async dir => {
        await writeFile(join(dir, 'game/project.source.json'), project(25));
        await writeFile(join(dir, 'game/assets', asset), svg('blue'));
        await rename(join(dir, 'notes.txt'), join(dir, 'readme.txt'));
        await writeFile(join(dir, 'added.txt'), 'added\n');
    }});
    // GitHub's base branch moves on after the fork was made, so the merge base is not the branch tip.
    await writeFile(join(seed, 'project.txt'), 'main moved\n');
    commit(seed, 'main moved');
    git(seed, 'push', '-q', bare, 'main');
    assert.equal(git(bare, 'branch', '--contains', head), '');

    const before = await localState(client);
    const repository = await openRepository(directoryHandle(client));
    const fetched = await repository.fetchPullRequest(7, sessionFor(fixture), () => {});
    assert.deepEqual(fetched, {number: 7, head, ref: 'refs/pull/origin/7/head', defaultBranch: 'main', branches: ['main']});
    assert.equal(pullRequestRef(7), fetched.ref);
    assert.equal(git(client, 'rev-parse', 'refs/pull/origin/7/head'), head);
    assert.equal(git(client, 'rev-parse', 'refs/remotes/origin/main'), git(bare, 'rev-parse', 'main'));
    // Git CLI sees a complete commit, yet lists it neither as a branch nor as a tag.
    git(client, 'fsck', '--no-dangling', '--connectivity-only');
    assert.doesNotMatch(git(client, 'branch', '-a'), /pull/);
    assert.equal(git(client, 'tag'), '');
    assert.match(git(client, 'log', '--all', '--format=%H'), new RegExp(head));
    assert.deepEqual(await localState(client), before);

    const review = await repository.readPullRequest(head, {branch: fetched.defaultBranch});
    const mergeBase = git(client, 'merge-base', 'refs/remotes/origin/main', head);
    assert.equal(review.mergeBase, mergeBase);
    assert.notEqual(mergeBase, git(client, 'rev-parse', 'refs/remotes/origin/main'));
    assert.deepEqual(review.base, {ref: 'main', sha: git(client, 'rev-parse', 'refs/remotes/origin/main')});
    // The changed paths match Git's three-dot comparison, with exact renames paired like GitHub's.
    const expected = git(client, 'diff', '--name-status', '-M100%', mergeBase, head).split('\n').map(line => line.split('\t'));
    assert.deepEqual(review.files.map(file => [file.status ?? 'patch', file.path, file.previousPath]).sort(), expected.map(
        ([status, ...paths]) => status === 'A' ? ['added', paths[0], undefined] : status.startsWith('R') ?
            ['updated', paths[1], paths[0]] : status === 'D' ? ['removed', paths[0], undefined] :
                [paths[0].endsWith('project.source.json') ? 'patch' : 'updated', paths[0], undefined]).sort());
    const projectFile = review.files.find(file => file.path === 'game/project.source.json');
    assert.match(projectFile.patch, /^-.*"10"\r?\n\+.*"25"/m);
    const signal = new AbortController().signal;
    assert.equal(await (await projectFile.loadAsset({version: 'before', md5ext: asset, signal})).text(), svg('red'));
    assert.equal(await (await projectFile.loadAsset({version: 'after', md5ext: asset, signal})).text(), svg('blue'));
    assert.equal(await projectFile.loadAsset({version: 'after', md5ext: '../escape.svg', signal}), null);

    // Comparing with GitHub's recorded base commit gives the same merge base without a branch.
    const byCommit = await repository.readPullRequest(head, {sha: mergeBase});
    assert.equal(byCommit.mergeBase, mergeBase);
    await assert.rejects(repository.readPullRequest(head, {branch: 'missing'}), {code: 'baseMissing'});
    await assert.rejects(repository.readPullRequest(head, {branch: '../../config'}), {code: 'baseMissing'});

    // A force-pushed head replaces the kept ref; the ref survives Git's prune and gc.
    const {head: moved} = await publishPullRequest(fixture, 7, {fork: true, from: fork, edit: async dir => {
        git(dir, 'reset', '-q', '--hard', 'HEAD~1');
        await writeFile(join(dir, 'game/project.source.json'), project(40));
    }});
    assert.equal((await repository.fetchPullRequest(7, sessionFor(fixture), () => {})).head, moved);
    assert.equal(git(client, 'rev-parse', 'refs/pull/origin/7/head'), moved);
    git(client, 'fetch', '-q', '--prune', bare, '+refs/heads/*:refs/remotes/origin/*');
    git(client, 'gc', '-q', '--prune=now');
    assert.equal(git(client, 'rev-parse', 'refs/pull/origin/7/head'), moved);
    git(client, 'cat-file', '-e', moved + '^{tree}');
    assert.deepEqual({...await localState(client), index: undefined}, {...before, index: undefined});
});

test('a same-repository pull request keeps its branch apart from the kept head, and remote fetch leaves the head', async t => {
    const fixture = await startFixture(t);
    const {client} = fixture;
    withOrigin(t);
    await seedProject(fixture);
    const {head} = await publishPullRequest(fixture, 3, {branch: 'feature', edit: async dir => {
        await writeFile(join(dir, 'game/project.source.json'), project(11));
    }});
    const repository = await openRepository(directoryHandle(client));
    const fetched = await repository.fetchPullRequest(3, sessionFor(fixture), () => {});
    assert.deepEqual(fetched.branches, ['feature', 'main']);
    assert.equal(git(client, 'rev-parse', 'refs/remotes/origin/feature'), head);
    assert.equal(git(client, 'rev-parse', pullRequestRef(3)), head);
    const review = await repository.readPullRequest(head, {branch: 'main'});
    assert.deepEqual(review.files.map(file => file.path), ['game/project.source.json']);
    await repository.remoteOperation('fetch', sessionFor(fixture), () => {});
    assert.equal(git(client, 'rev-parse', pullRequestRef(3)), head);
});

test('fetching a pull request reports the connection, access, a missing number and the network without writing', async t => {
    const fixture = await startFixture(t);
    const {client} = fixture;
    withOrigin(t);
    await seedProject(fixture);
    await publishPullRequest(fixture, 5, {fork: true, edit: dir => writeFile(join(dir, 'game/project.source.json'), project(12))});
    const repository = await openRepository(directoryHandle(client));
    const refs = () => git(client, 'for-each-ref');
    const before = {refs: refs(), state: await localState(client)};
    const unchanged = async () => assert.deepEqual({refs: refs(), state: await localState(client)}, before);

    const upstream = fixture.upstream.length;
    await assert.rejects(repository.fetchPullRequest(5, async () => null, () => {}), {code: 'session'});
    assert.equal(fixture.upstream.length, upstream);
    await assert.rejects(repository.fetchPullRequest(5, sessionFor(fixture, 'fixture-expired'), () => {}), {code: 'session'});
    await assert.rejects(repository.fetchPullRequest(5, sessionFor(fixture, 'fixture-unknown'), () => {}), {code: 'session'});
    await assert.rejects(repository.fetchPullRequest(5, sessionFor(fixture, 'fixture-cloudflare'), () => {}), {code: 'forbidden'});
    // The number is checked against the advertisement before any objects are asked for.
    const posts = () => fixture.upstream.filter(request => request.method === 'POST').length;
    const asked = posts();
    await assert.rejects(repository.fetchPullRequest(99, sessionFor(fixture), () => {}), {code: 'pullRequestNotFound'});
    assert.equal(posts(), asked);
    await assert.rejects(repository.fetchPullRequest(0, sessionFor(fixture), () => {}), {code: 'pullRequestNotFound'});
    await assert.rejects(repository.fetchPullRequest(5, sessionFor(fixture, 'fixture-read', 'http://127.0.0.1:9'), () => {}),
        {code: 'network'});
    await assert.rejects(repository.fetchPullRequest(5, sessionFor(fixture), () => {throw new Error('stop');}), /stop/);
    const packs = async () => (await readdir(join(client, '.git/objects/pack'))).sort();
    const packsBefore = await packs();
    let calls = 0;
    // A guard that stops after the objects arrive leaves nothing behind.
    await assert.rejects(repository.fetchPullRequest(5, sessionFor(fixture), () => {
        if (++calls > 2) throw new Error('stop late');
    }), /stop late/);
    await unchanged();
    assert.deepEqual(await packs(), packsBefore);
    await repository.fetchPullRequest(5, sessionFor(fixture), () => {});
    assert.notEqual(refs(), before.refs);
});

/** Fetches pull request 7 from a fork that changes the game, and returns the repository and the fetched head. */
async function fetchedPullRequest(t) {
    const fixture = await startFixture(t);
    const {client} = fixture;
    withOrigin(t);
    await seedProject(fixture);
    git(client, 'pull', '-q', '--ff-only', fixture.bare, 'main');
    const {head} = await publishPullRequest(fixture, 7, {fork: true, edit: async dir => {
        await writeFile(join(dir, 'game/project.source.json'), project(25));
        await writeFile(join(dir, 'game/assets', asset), svg('blue'));
        await writeFile(join(dir, 'added.txt'), 'added\n');
    }});
    const repository = await openRepository(directoryHandle(client));
    assert.equal((await repository.fetchPullRequest(7, sessionFor(fixture), () => {})).head, head);
    return {fixture, client, repository, head};
}
const openPullRequest = (repository, head, guard = () => {}) => repository.localOperation(
    {kind: 'createBranch', name: pullRequestBranch(7), at: head, checkout: true, reuse: true}, guard);
const everything = async client => ({refs: git(client, 'for-each-ref'), state: await localState(client)});

test('a fetched pull request opens on the branch pr/<n> at its head, and the previous branch stays to switch back', async t => {
    const {client, repository, head} = await fetchedPullRequest(t);
    assert.equal(pullRequestBranch(7), 'pr/7');
    git(client, 'check-ref-format', '--branch', pullRequestBranch(7));
    const main = git(client, 'rev-parse', 'main');
    const before = await localState(client);
    await openPullRequest(repository, head);
    assert.equal(git(client, 'branch', '--show-current'), 'pr/7');
    assert.equal(git(client, 'rev-parse', 'HEAD'), head);
    assert.equal(git(client, 'status', '--porcelain'), '');
    assert.equal(await readFile(join(client, 'game/project.source.json'), 'utf8'), project(25));
    assert.equal(await readFile(join(client, 'game/assets', asset), 'utf8'), svg('blue'));
    assert.equal(await readFile(join(client, 'added.txt'), 'utf8'), 'added\n');
    // An ordinary branch without tracking config; main is untouched and still listed.
    assert.equal(await readFile(join(client, '.git/config'), 'utf8'), before.config);
    assert.equal(git(client, 'rev-parse', 'main'), main);
    assert.deepEqual((await repository.read()).branches.sort(), ['main', 'pr/7']);
    git(client, 'fsck', '--no-progress');

    await repository.localOperation({kind: 'switchBranch', name: 'main'}, () => {});
    assert.deepEqual({...await localState(client), branches: undefined, index: undefined},
        {...before, branches: undefined, index: undefined});
    assert.equal(git(client, 'status', '--porcelain'), '');
});

test('opening a pull request again reuses pr/<n> at the same commit, and refuses one at another commit untouched', async t => {
    const {client, repository, head} = await fetchedPullRequest(t);
    await openPullRequest(repository, head);
    await repository.localOperation({kind: 'switchBranch', name: 'main'}, () => {});
    await openPullRequest(repository, head);
    assert.equal(git(client, 'branch', '--show-current'), 'pr/7');
    assert.equal(git(client, 'rev-parse', 'pr/7'), head);
    // Opening it while already on it is the same switch.
    await openPullRequest(repository, head);
    assert.equal(git(client, 'branch', '--show-current'), 'pr/7');

    // The person recorded on pr/7 (or the pull request moved): the branch is never moved, nothing is written.
    await repository.localOperation({kind: 'switchBranch', name: 'main'}, () => {});
    git(client, 'branch', '-f', 'pr/7', 'main');
    const before = await everything(client);
    await assert.rejects(openPullRequest(repository, head), {code: 'pullRequestBranch'});
    assert.deepEqual(await everything(client), before);
    assert.equal(git(client, 'rev-parse', 'pr/7'), git(client, 'rev-parse', 'main'));
    // Without reuse an existing name is still refused as before, and reuse needs a commit.
    await assert.rejects(repository.localOperation({kind: 'createBranch', name: 'pr/7', at: head, checkout: true}, () => {}),
        {code: 'branchExists'});
    await assert.rejects(repository.localOperation({kind: 'createBranch', name: 'pr/9', checkout: true, reuse: true}, () => {}),
        {code: 'invalid'});
    assert.deepEqual(await everything(client), before);
});

test('opening a pull request with work-tree changes or unsaved edits is refused and leaves everything byte-identical', async t => {
    const {client, repository, head} = await fetchedPullRequest(t);
    await writeFile(join(client, 'notes.txt'), 'edited, not recorded\n');
    let before = await everything(client);
    await assert.rejects(openPullRequest(repository, head), {code: 'switchUnsafe'});
    assert.deepEqual(await everything(client), before);
    git(client, 'checkout', '--', 'notes.txt');

    await writeFile(join(client, 'untracked.txt'), 'new\n');
    before = await everything(client);
    await assert.rejects(openPullRequest(repository, head), {code: 'switchUnsafe'});
    assert.deepEqual(await everything(client), before);
    await rm(join(client, 'untracked.txt'));

    // The Editor's unsaved edits stop it through the guard, as for any switch.
    before = await everything(client);
    await assert.rejects(openPullRequest(repository, head, () => {throw new GitPanelError('switchUnsafe');}), {code: 'switchUnsafe'});
    assert.deepEqual(await everything(client), before);
    assert.doesNotMatch(git(client, 'branch'), /pr\/7/);
});
