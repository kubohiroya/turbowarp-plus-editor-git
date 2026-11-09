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

test('probes Git metadata and the scoped work tree, and reports active Git locks', async t => {
    const {root, git, write, handle} = await fixture(t);
    const repository = await openRepository(handle);
    const snapshot = await repository.read('projects/demo');
    assert.equal(await repository.probe('projects/demo'), snapshot.probe);

    await write('notes.txt', 'outside the selected project\n');
    assert.equal(await repository.probe('projects/demo'), snapshot.probe, 'edits outside the scope are ignored');

    await write('projects/demo/project.source.json', '{"targets":[{"changed":true}]}\n');
    const edited = await repository.probe('projects/demo');
    assert.notEqual(edited, snapshot.probe, 'a work-tree edit in the scope changes the probe');

    git('add', 'projects/demo');
    const staged = await repository.probe('projects/demo');
    assert.notEqual(staged, edited, 'staging changes the index part of the probe');

    git('commit', '-qm', 'external commit');
    assert.notEqual(await repository.probe('projects/demo'), staged, 'a commit changes the branch ref');

    await fs.writeFile(path.join(root, '.git/index.lock'), '');
    assert.equal(await repository.probe('projects/demo'), 'locked');
    await fs.rm(path.join(root, '.git/index.lock'));
    const fresh = await repository.read('projects/demo');
    assert.equal(await repository.probe('projects/demo'), fresh.probe);
});
