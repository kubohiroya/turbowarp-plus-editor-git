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
    await assert.rejects(run(repository, {kind: 'commit', message: 'Locked'}), {code: 'changed'});
    await fs.rm(path.join(root, '.git/index.lock'));
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
