import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {openRepository} from '../dist/repository.js';
import {directoryHandle} from './directory.js';

async function fixture(t, {identity = true} = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twgit-local-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trimEnd();
    git('init', '-q', '-b', 'main');
    if (identity) {
        git('config', 'user.name', 'Git panel fixture');
        git('config', 'user.email', 'fixture@example.invalid');
    }
    const write = (name, text) => fs.writeFile(path.join(root, name), text);
    await fs.mkdir(path.join(root, 'projects/demo'), {recursive: true});
    await write('projects/demo/project.source.json', '{"targets":[]}\n');
    await write('notes.txt', 'initial\n');
    await write('run.sh', '#!/bin/sh\n');
    await fs.chmod(path.join(root, 'run.sh'), 0o755);
    git('add', '.');
    git('-c', 'user.name=Setup', '-c', 'user.email=setup@example.invalid', 'commit', '-qm', 'initial');
    return {root, git, write, repository: await openRepository(directoryHandle(root))};
}
const run = (repository, operation) => repository.localOperation(operation, () => {});

test('stages, unstages and commits as Git CLI sees it, without touching the work tree or config', async t => {
    const {root, git, write, repository} = await fixture(t);
    const config = await fs.readFile(path.join(root, '.git/config'));
    await write('projects/demo/project.source.json', '{"targets":[1]}\n');
    await write('new.txt', 'new\n');
    await fs.rm(path.join(root, 'notes.txt'));
    await run(repository, {kind: 'stage', paths: ['projects/demo/project.source.json', 'new.txt', 'notes.txt']});
    assert.equal(git('status', '--porcelain'), 'A  new.txt\nD  notes.txt\nM  projects/demo/project.source.json');
    await run(repository, {kind: 'unstage', paths: ['new.txt']});
    assert.equal(git('status', '--porcelain'), 'D  notes.txt\nM  projects/demo/project.source.json\n?? new.txt');
    await run(repository, {kind: 'commit', message: 'Update the demo\n\nWith details.', author: {name: 'Editor', email: 'editor@example.invalid'}});
    assert.equal(git('status', '--porcelain'), '?? new.txt');
    assert.equal(git('log', '-1', '--format=%an <%ae>|%s|%b'), 'Git panel fixture <fixture@example.invalid>|Update the demo|With details.');
    assert.equal(git('show', 'HEAD:projects/demo/project.source.json'), '{"targets":[1]}');
    git('fsck', '--no-progress');
    assert.deepEqual(await fs.readFile(path.join(root, '.git/config')), config);
    assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'new\n');
    const snapshot = await repository.read();
    assert.deepEqual(snapshot.changes.map(change => [change.group, change.path]), [['untracked', 'new.txt']]);
});

test('uses the Editor author only when Git has none, and never writes it to the config', async t => {
    const {root, git, write, repository} = await fixture(t, {identity: false});
    const config = await fs.readFile(path.join(root, '.git/config'));
    await write('notes.txt', 'changed\n');
    await run(repository, {kind: 'stage', paths: ['notes.txt']});
    // No identity in this repository's config. The machine's global Git config may still have one, so pass ours.
    await run(repository, {kind: 'commit', message: 'Change notes', author: {name: 'Editor', email: 'editor@example.invalid'}});
    assert.match(git('log', '-1', '--format=%an <%ae>'), /<.+@.+>/u);
    assert.deepEqual(await fs.readFile(path.join(root, '.git/config')), config);
});

test('refuses an empty message, nothing staged, executable files and a held index lock', async t => {
    const {root, git, write, repository} = await fixture(t);
    await assert.rejects(run(repository, {kind: 'commit', message: 'Nothing'}), {code: 'nothingStaged'});
    await write('notes.txt', 'changed\n');
    await run(repository, {kind: 'stage', paths: ['notes.txt']});
    await assert.rejects(run(repository, {kind: 'commit', message: '  \n'}), {code: 'commitMessage'});
    await write('run.sh', '#!/bin/sh\necho changed\n');
    await assert.rejects(run(repository, {kind: 'stage', paths: ['run.sh']}), {code: 'unsupported'});
    assert.equal(git('ls-files', '-s', 'run.sh').split(' ')[0], '100755');
    await fs.writeFile(path.join(root, '.git/index.lock'), '');
    await assert.rejects(run(repository, {kind: 'commit', message: 'Locked'}), {code: 'locked'});
    await fs.rm(path.join(root, '.git/index.lock'));
    // A merge in progress belongs to the tool that started it.
    await fs.writeFile(path.join(root, '.git/MERGE_HEAD'), git('rev-parse', 'HEAD') + '\n');
    await assert.rejects(run(repository, {kind: 'stage', paths: ['notes.txt']}), {code: 'locked'});
    await fs.rm(path.join(root, '.git/MERGE_HEAD'));
    await run(repository, {kind: 'commit', message: 'Unlocked'});
    assert.equal(git('log', '-1', '--format=%s'), 'Unlocked');
});

test('a guard that stops the operation leaves the index and branch as they were', async t => {
    const {root, git, write, repository} = await fixture(t);
    await write('notes.txt', 'changed\n');
    const index = await fs.readFile(path.join(root, '.git/index'));
    let calls = 0;
    await assert.rejects(repository.localOperation({kind: 'stage', paths: ['notes.txt']}, () => {
        if (++calls > 1) throw new Error('stopped');
    }), /stopped/u);
    assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), index);
    assert.equal(git('status', '--porcelain'), ' M notes.txt');
});

async function versions(t) {
    const state = await fixture(t);
    const {root, git, write} = state;
    const folder = 'projects/demo';
    await fs.mkdir(path.join(root, folder, 'assets'));
    await write(folder + '/assets/old.svg', '<svg id="old"/>');
    await write(folder + '/sb3-source.json', '{"formatVersion":1}');
    git('add', folder);
    git('commit', '-qm', 'historical version');
    const old = git('rev-parse', 'HEAD');
    await fs.rm(path.join(root, folder, 'assets/old.svg'));
    await write(folder + '/assets/new.svg', '<svg id="new"/>');
    await write(folder + '/project.source.json', '{"targets":[1]}');
    await write(folder + '/README.md', 'New notes\n');
    git('add', folder);
    git('commit', '-qm', 'current version');
    return {...state, folder, old, current: git('rev-parse', 'HEAD')};
}

test('restores tracked project files in one commit and can restore the previous version again', async t => {
    const {root, git, write, repository, folder, old, current} = await versions(t);
    await write('notes.txt', 'unrelated unstaged edit');
    const plan = await repository.planProjectRestore(old, folder);
    assert.deepEqual(plan.changes.map(({path, before, after}) => [path, !!before, !!after]), [
        [folder + '/assets/new.svg', true, false], [folder + '/assets/old.svg', false, true],
        [folder + '/project.source.json', true, true]
    ]);
    await run(repository, {kind: 'restoreProject', plan});
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(git('rev-parse', 'HEAD^'), current);
    assert.match(git('log', '-1', '--format=%s'), new RegExp(old));
    assert.equal(git('diff', old, 'HEAD', '--', folder + '/assets', folder + '/project.source.json'), '');
    assert.equal(await fs.readFile(path.join(root, folder, 'README.md'), 'utf8'), 'New notes\n');
    assert.equal(git('status', '--porcelain'), ' M notes.txt');
    const restored = git('rev-parse', 'HEAD');
    await run(repository, {kind: 'restoreProject', plan: await repository.planProjectRestore(current, folder)});
    assert.equal(git('rev-parse', 'HEAD^'), restored);
    assert.equal(git('diff', current, 'HEAD'), '');
});

test('refuses a dirty project, an untracked collision, an unrelated staged file and a stale plan', async t => {
    const {root, git, write, repository, folder, old, current} = await versions(t);
    const plan = await repository.planProjectRestore(old, folder);
    const restore = () => run(repository, {kind: 'restoreProject', plan});
    await write(folder + '/project.source.json', 'unsaved on disk');
    await assert.rejects(restore(), {code: 'restoreUnsafe'});
    git('restore', '--', folder + '/project.source.json');
    await write(folder + '/assets/old.svg', 'untracked file');
    await assert.rejects(restore(), {code: 'restoreUnsafe'});
    assert.equal(await fs.readFile(path.join(root, folder, 'assets/old.svg'), 'utf8'), 'untracked file');
    await fs.unlink(path.join(root, folder, 'assets/old.svg'));
    await write('notes.txt', 'unrelated staged edit');
    git('add', 'notes.txt');
    await assert.rejects(restore(), {code: 'restoreUnsafe'});
    assert.equal(git('rev-parse', 'HEAD'), current);
    git('commit', '-qm', 'moved HEAD outside the panel');
    await assert.rejects(restore(), {code: 'changed'});
    assert.equal(git('status', '--porcelain'), '');
});

test('rolls back worktree and index when restoring a file fails', async t => {
    const {root, git, folder, old, current} = await versions(t);
    const index = await fs.readFile(path.join(root, '.git/index'));
    const repository = await openRepository(directoryHandle(root, filename => {
        if (filename.endsWith('/' + folder + '/project.source.json')) throw new Error('injected write failure');
    }));
    const plan = await repository.planProjectRestore(old, folder);
    await assert.rejects(run(repository, {kind: 'restoreProject', plan}), /injected write failure/);
    assert.equal(git('rev-parse', 'HEAD'), current);
    assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), index);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(await fs.readFile(path.join(root, folder, 'assets/new.svg'), 'utf8'), '<svg id="new"/>');
    await assert.rejects(fs.stat(path.join(root, folder, 'assets/old.svg')), {code: 'ENOENT'});
});
