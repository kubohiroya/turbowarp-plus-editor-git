import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openRepository, createReadOnlyFs} from '../dist/repository.js';
import {directoryHandle} from './directory.js';

async function fixture(t, commit = true) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twgit-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trimEnd();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Git panel fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    await fs.mkdir(path.join(root, 'projects/demo'), {recursive: true});
    const write = (name, text) => fs.writeFile(path.join(root, name), text);
    await write('projects/demo/project.source.json', '{"targets":[]}\n');
    await write('notes.txt', 'initial\n');
    await write('deleted.txt', 'delete\n');
    await write('staged-delete.txt', 'remove\n');
    await write('run.sh', '#!/bin/sh\necho initial\n');
    await fs.chmod(path.join(root, 'run.sh'), 0o755);
    if (commit) {git('add', '.'); git('commit', '-qm', 'initial project');}
    return {root, git, write, handle: directoryHandle(root)};
}
async function gitBytes(root) {
    const result = {};
    const visit = async directory => {
        for (const item of await fs.readdir(directory, {withFileTypes: true})) {
            const filename = path.join(directory, item.name);
            if (item.isDirectory()) await visit(filename);
            else result[path.relative(root, filename)] = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
        }
    };
    await visit(path.join(root, '.git'));
    return result;
}

test('matches CLI changes, separates staged and working bytes, and keeps Git metadata read-only', async t => {
    const {root, git, write, handle} = await fixture(t);
    await write('notes.txt', 'staged\n'); git('add', 'notes.txt');
    await write('notes.txt', 'working\n');
    await write('untracked.txt', 'new\n');
    await write('run.sh', '#!/bin/sh\necho edited\n');
    await fs.rm(path.join(root, 'deleted.txt'));
    git('rm', '-q', 'staged-delete.txt');
    await write('image.png', new Uint8Array([137, 80, 0, 71]));
    const expected = git('status', '--porcelain').split('\n').map(line => line.slice(3)).sort();
    const stagedPaths = git('diff', '--cached', '--name-only').split('\n').sort();
    const unstagedPaths = git('diff', '--name-only').split('\n').sort();
    const untrackedPaths = git('ls-files', '--others', '--exclude-standard').split('\n').sort();
    // Git itself may refresh the index, so capture the bytes after the CLI observation.
    const before = await gitBytes(root);
    const repo = await openRepository(handle);
    const snapshot = await repo.read();
    assert.equal(snapshot.branch, 'main');
    assert.equal(snapshot.head, git('rev-parse', 'HEAD'));
    assert.equal(snapshot.commits[0].message.trim(), 'initial project');
    assert.deepEqual([...new Set(snapshot.changes.map(change => change.path))].sort(), expected);
    const paths = group => snapshot.changes.filter(change => change.group === group).map(change => change.path).sort();
    assert.deepEqual(paths('staged'), stagedPaths);
    assert.deepEqual(paths('unstaged'), unstagedPaths);
    assert.deepEqual(paths('untracked'), untrackedPaths);
    assert.equal(snapshot.changes.find(change => change.path === 'run.sh').oldMode, 0o100755);
    const staged = snapshot.changes.find(change => change.path === 'notes.txt' && change.group === 'staged');
    const working = snapshot.changes.find(change => change.path === 'notes.txt' && change.group === 'unstaged');
    assert.match((await repo.readDiff(snapshot, staged)).patch, /-initial\n\+staged/);
    assert.match((await repo.readDiff(snapshot, working)).patch, /-staged\n\+working/);
    const binary = snapshot.changes.find(change => change.path === 'image.png');
    assert.equal((await repo.readDiff(snapshot, binary)).binary, true);
    assert.deepEqual(await gitBytes(root), before);
    const scope = await repo.read('projects/demo');
    assert.deepEqual(scope.changes, []);
});

test('reads packed commits and detached HEAD, with commit changes and an unborn repository', async t => {
    const {handle, git} = await fixture(t);
    git('gc', '--prune=now');
    git('checkout', '--detach', '-q');
    const repo = await openRepository(handle);
    const snapshot = await repo.read();
    assert.equal(snapshot.branch, undefined);
    const changes = await repo.historyChanges(snapshot, snapshot.head);
    assert.ok(changes.some(change => change.path === 'notes.txt'));
    assert.match((await repo.readDiff(snapshot, changes.find(change => change.path === 'notes.txt'))).patch, /\+initial/);
    const unborn = await fixture(t, false);
    const initial = await (await openRepository(unborn.handle)).read();
    assert.equal(initial.head, null);
    assert.deepEqual(initial.commits, []);
    assert.ok(initial.changes.every(change => change.group === 'untracked'));
});

test('returns both texts beside the diff and keeps project sources readable past the text diff limit', async t => {
    const {root, write, handle} = await fixture(t);
    const source = 'projects/demo/project.source.json';
    await write(source, '{"targets":[{"name":"Stage","isStage":true,"blocks":{}}]}\n');
    await fs.mkdir(path.join(root, 'projects/added'));
    await write('projects/added/project.source.json', '{"targets":[]}\n');
    const repo = await openRepository(handle);
    let snapshot = await repo.read();
    const change = path => snapshot.changes.find(item => item.path === path);
    const edited = await repo.readDiff(snapshot, change(source));
    assert.deepEqual(edited.text, {before: '{"targets":[]}\n', after: '{"targets":[{"name":"Stage","isStage":true,"blocks":{}}]}\n'});
    assert.match(edited.patch, /\+\{"targets":\[\{"name":"Stage"/);
    const added = change('projects/added/project.source.json');
    assert.equal(added.before, null);
    assert.deepEqual((await repo.readDiff(snapshot, added)).text, {before: '', after: '{"targets":[]}\n'});

    // Above the 1 MiB text diff limit, only project sources keep their text, up to 16 MiB.
    const padding = 'x'.repeat(1024 * 1024);
    await write(source, JSON.stringify({targets: [], padding}) + '\n');
    await write('notes.txt', padding + '\n');
    snapshot = await repo.read();
    const large = await repo.readDiff(snapshot, change(source));
    assert.equal(large.tooLarge, true);
    assert.equal(large.patch, '');
    assert.equal(JSON.parse(large.text.after).padding.length, padding.length);
    const notes = await repo.readDiff(snapshot, change('notes.txt'));
    assert.equal(notes.tooLarge, true);
    assert.equal(notes.text, undefined);
    await write(source, JSON.stringify({padding: 'x'.repeat(16 * 1024 * 1024)}));
    snapshot = await repo.read();
    const oversized = await repo.readDiff(snapshot, change(source));
    assert.equal(oversized.tooLarge, true);
    assert.equal(oversized.text, undefined);
});

test('rejects stale snapshots, active Git locks, and paths outside the granted root', async t => {
    const {root, git, write, handle} = await fixture(t);
    await write('notes.txt', 'edited\n');
    const repo = await openRepository(handle);
    const snapshot = await repo.read();
    await write('notes.txt', 'changed on disk\n');
    await assert.rejects(repo.readDiff(snapshot, snapshot.changes[0]), {code: 'changed'});
    const updated = await repo.read();
    assert.match((await repo.readDiff(updated, updated.changes[0])).patch, /changed on disk/);
    git('add', 'notes.txt');
    await assert.rejects(repo.readDiff(updated, updated.changes[0]), {code: 'changed'});
    await write('.git/index.lock', '');
    await assert.rejects(repo.read(), {code: 'changed'});
    await fs.rm(path.join(root, '.git/index.lock'));
    await assert.rejects(repo.openProject('../elsewhere'), {code: 'EACCES'});
    await fs.mkdir(path.join(root, 'projects/other'));
    await write('projects/other/.git', 'gitdir: elsewhere\n');
    await write('projects/other/project.source.json', '{}');
    await assert.rejects(repo.openProject('projects/other'), {code: 'invalid'});
    const project = await repo.openProject('projects/demo');
    assert.equal(project.name, 'demo');
    const adapter = createReadOnlyFs(handle);
    await assert.rejects(adapter.promises.writeFile('/notes.txt', 'changed'), {code: 'EROFS'});
});

test('asset loaders read each version of a project file without writing Git metadata', async t => {
    const {root, git, write, handle} = await fixture(t);
    const source = 'projects/demo/project.source.json';
    const costume = 'projects/demo/assets/costume.svg';
    const stage = steps => JSON.stringify({targets: [{name: 'Stage', isStage: true, blocks: {}, steps}]}) + '\n';
    await fs.mkdir(path.join(root, 'projects/demo/assets'));
    await write(costume, '<svg>parent</svg>');
    git('add', '.'); git('commit', '-qm', 'add costume');
    await write(costume, '<svg>head</svg>');
    await write(source, stage(1));
    git('add', '.'); git('commit', '-qm', 'change costume');
    await write(costume, '<svg>index</svg>');
    await write(source, stage(2));
    git('add', '.');
    await write(costume, '<svg>work</svg>');
    await write(source, stage(3));
    await fs.mkdir(path.join(root, 'projects/new/media'), {recursive: true});
    await write('projects/new/project.source.json', stage(4));
    await write('projects/new/sb3-source.json', JSON.stringify({formatVersion: 1, assetsDirectory: 'media'}));
    await write('projects/new/media/backdrop.png', new Uint8Array([137, 80, 78, 71]));
    git('status', '--porcelain');
    const bytes = await gitBytes(root);
    const repo = await openRepository(handle);
    const snapshot = await repo.read();
    const change = (group, path = source) => snapshot.changes.find(item => item.path === path && item.group === group);
    const read = async (loader, version, md5ext = 'costume.svg', signal = new AbortController().signal) => {
        const blob = await loader({version, md5ext, signal});
        return blob && new TextDecoder().decode(await blob.arrayBuffer());
    };
    const staged = repo.assetLoader(snapshot, change('staged'));
    assert.equal(await read(staged, 'before'), '<svg>head</svg>');
    assert.equal(await read(staged, 'after'), '<svg>index</svg>');
    const unstaged = repo.assetLoader(snapshot, change('unstaged'));
    assert.equal(await read(unstaged, 'before'), '<svg>index</svg>');
    assert.equal(await read(unstaged, 'after'), '<svg>work</svg>');
    const untracked = repo.assetLoader(snapshot, change('untracked', 'projects/new/project.source.json'));
    assert.equal(await read(untracked, 'before', 'backdrop.png'), null);
    assert.deepEqual([...new Uint8Array(await (await untracked({version: 'after', md5ext: 'backdrop.png',
        signal: new AbortController().signal})).arrayBuffer())], [137, 80, 78, 71]);
    const commit = (await repo.historyChanges(snapshot, snapshot.head)).find(item => item.path === source);
    assert.equal(commit.commit, snapshot.head);
    const history = repo.assetLoader(snapshot, commit);
    assert.equal(await read(history, 'before'), '<svg>parent</svg>');
    assert.equal(await read(history, 'after'), '<svg>head</svg>');

    // Missing files, names outside the assets directory, cancelled reads and oversized files resolve null.
    assert.equal(await read(unstaged, 'after', 'missing.svg'), null);
    for (const name of ['../project.source.json', 'assets/costume.svg', '.svg', 'costume', '..']) {
        assert.equal(await read(unstaged, 'after', name), null);
    }
    const cancelled = new AbortController();
    cancelled.abort();
    assert.equal(await read(unstaged, 'after', 'costume.svg', cancelled.signal), null);
    await write('projects/demo/assets/large.png', new Uint8Array(10 * 1024 * 1024 + 1));
    assert.equal(await read(unstaged, 'after', 'large.png'), null);
    for (const assetsDirectory of ['../demo/assets', '/assets', '.git', 'assets/', 7]) {
        await write('projects/demo/sb3-source.json', JSON.stringify({assetsDirectory}));
        assert.equal(await read(unstaged, 'after'), null, String(assetsDirectory));
    }
    // The working tree's sb3-source.json does not change where the index version reads its assets.
    assert.equal(await read(unstaged, 'before'), '<svg>index</svg>');
    await write('projects/demo/sb3-source.json', '{"assetsDirectory": ');
    assert.equal(await read(unstaged, 'after'), '<svg>work</svg>');
    assert.deepEqual(await gitBytes(root), bytes);
    assert.match((await repo.readDiff(snapshot, change('unstaged'))).text.after, /"steps":3/);
});
