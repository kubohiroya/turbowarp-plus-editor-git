import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {openRepository} from '../dist/repository.js';
import {directoryHandle} from './directory.js';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twgit-branch-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trimEnd();
    const commit = message => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message);
    git('init', '-q', '-b', 'main');
    const write = async (name, text) => {
        await fs.mkdir(path.dirname(path.join(root, name)), {recursive: true});
        await fs.writeFile(path.join(root, name), text);
    };
    await write('projects/demo/project.source.json', '{"targets":[]}\n');
    await write('notes.txt', 'main\n');
    git('add', '.');
    commit('initial');
    // A second branch adds a project and removes notes, so switching writes, adds and removes files.
    git('switch', '-q', '-c', 'feature');
    await write('projects/other/project.source.json', '{"targets":[1]}\n');
    git('rm', '-q', 'notes.txt');
    git('add', '.');
    commit('feature');
    git('switch', '-q', 'main');
    return {root, git, write, commit, repository: await openRepository(directoryHandle(root))};
}
const run = (repository, operation) => repository.localOperation(operation, () => {});
const state = git => ({head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), status: git('status', '--porcelain'),
    index: git('ls-files', '-s')});

test('switching matches git switch for HEAD, the index and the work tree', async t => {
    const {root, git, repository} = await fixture(t);
    await run(repository, {kind: 'switchBranch', name: 'feature'});
    const ours = state(git);
    assert.equal(ours.branch, 'feature');
    assert.equal(ours.status, '');
    assert.equal(await fs.readFile(path.join(root, 'projects/other/project.source.json'), 'utf8'), '{"targets":[1]}\n');
    await assert.rejects(fs.access(path.join(root, 'notes.txt')));
    // The same switch with Git CLI from main ends in the same state.
    git('switch', '-q', 'main');
    git('switch', '-q', 'feature');
    assert.deepEqual(state(git), ours);
    await run(repository, {kind: 'switchBranch', name: 'main'});
    assert.equal(git('branch', '--show-current'), 'main');
    assert.equal(await fs.readFile(path.join(root, 'notes.txt'), 'utf8'), 'main\n');
    git('fsck', '--no-progress');
});

test('creates a branch at HEAD, with or without switching, as git branch does', async t => {
    const {git, repository} = await fixture(t);
    await run(repository, {kind: 'createBranch', name: 'idea', checkout: false});
    assert.equal(git('rev-parse', 'idea'), git('rev-parse', 'main'));
    assert.equal(git('branch', '--show-current'), 'main');
    await run(repository, {kind: 'createBranch', name: 'topic/next', checkout: true});
    assert.equal(git('branch', '--show-current'), 'topic/next');
    assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'main'));
    await assert.rejects(run(repository, {kind: 'createBranch', name: 'idea', checkout: false}), {code: 'branchExists'});
    await assert.rejects(run(repository, {kind: 'createBranch', name: 'bad..name', checkout: false}), {code: 'branchName'});
});

test('creates a branch from origin/<name> without writing tracking config', async t => {
    const {root, git, repository} = await fixture(t);
    git('update-ref', 'refs/remotes/origin/shared', git('rev-parse', 'feature'));
    const config = await fs.readFile(path.join(root, '.git/config'));
    assert.deepEqual((await repository.read()).remoteBranches, ['shared']);
    assert.equal(await repository.hasFolder('shared', 'projects/other', true), true);
    assert.equal(await repository.hasFolder('main', 'projects/other'), false);
    await run(repository, {kind: 'createBranch', name: 'shared', fromRemote: true, checkout: true});
    assert.equal(git('branch', '--show-current'), 'shared');
    assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'origin/shared'));
    assert.equal(git('status', '--porcelain'), '');
    assert.deepEqual(await fs.readFile(path.join(root, '.git/config')), config);
    assert.deepEqual((await repository.read()).remoteBranches, []);
});

test('refuses to switch with changes, or to a branch with executable files, and leaves everything as it was', async t => {
    const {root, git, write, commit, repository} = await fixture(t);
    await write('notes.txt', 'changed\n');
    await assert.rejects(run(repository, {kind: 'switchBranch', name: 'feature'}), {code: 'switchUnsafe'});
    assert.equal(git('status', '--porcelain'), ' M notes.txt');
    git('checkout', '-q', '--', 'notes.txt');
    await write('untracked.txt', 'new\n');
    await assert.rejects(run(repository, {kind: 'switchBranch', name: 'feature'}), {code: 'switchUnsafe'});
    await fs.rm(path.join(root, 'untracked.txt'));
    git('switch', '-q', '-c', 'tools');
    await write('run.sh', '#!/bin/sh\n');
    await fs.chmod(path.join(root, 'run.sh'), 0o755);
    git('add', 'run.sh');
    commit('tools');
    git('switch', '-q', 'main');
    const before = state(git);
    await assert.rejects(run(repository, {kind: 'switchBranch', name: 'tools'}), {code: 'unsupported'});
    assert.deepEqual(state(git), before);
    await assert.rejects(fs.access(path.join(root, 'run.sh')));
});

test('a stopped switch leaves HEAD, the index and the work tree as they were', async t => {
    const {root, git, repository} = await fixture(t);
    const before = state(git);
    let calls = 0;
    await assert.rejects(repository.localOperation({kind: 'switchBranch', name: 'feature'}, () => {
        // Stop after some of the switch's writes were applied, so they are put back.
        if (++calls > 5) throw new Error('stopped');
    }), /stopped/u);
    assert.deepEqual(state(git), before);
    assert.equal(await fs.readFile(path.join(root, 'notes.txt'), 'utf8'), 'main\n');
    await assert.rejects(fs.access(path.join(root, 'projects/other')));
});

test('creates a branch at a commit from the history, with or without switching, as git branch <name> <commit> does', async t => {
    const {root, git, write, commit, repository} = await fixture(t);
    const initial = git('rev-parse', 'main');
    await write('notes.txt', 'second\n');
    git('add', '.');
    commit('second');
    const config = await fs.readFile(path.join(root, '.git/config'));
    await run(repository, {kind: 'createBranch', name: 'from-history', at: initial, checkout: false});
    assert.equal(git('rev-parse', 'from-history'), initial);
    assert.equal(git('branch', '--show-current'), 'main');
    assert.equal(git('status', '--porcelain'), '');
    // A commit on another branch, switched to: HEAD, the index and the work tree match git switch.
    const feature = git('rev-parse', 'feature');
    assert.equal(await repository.hasFolder(feature, 'projects/other', 'commit'), true);
    await run(repository, {kind: 'createBranch', name: 'from-feature', at: feature, checkout: true});
    assert.equal(git('branch', '--show-current'), 'from-feature');
    assert.equal(git('rev-parse', 'HEAD'), feature);
    assert.equal(git('status', '--porcelain'), '');
    await assert.rejects(fs.access(path.join(root, 'notes.txt')));
    assert.deepEqual(await fs.readFile(path.join(root, '.git/config')), config);
    const ours = state(git);
    git('switch', '-q', 'main');
    git('switch', '-q', 'from-feature');
    assert.deepEqual(state(git), ours);
    // A name in use, an unknown commit, a tree instead of a commit, or `at` with `fromRemote` change nothing.
    const refs = git('for-each-ref', '--format=%(refname) %(objectname)');
    await assert.rejects(run(repository, {kind: 'createBranch', name: 'main', at: initial, checkout: false}), {code: 'branchExists'});
    await assert.rejects(run(repository, {kind: 'createBranch', name: 'x', at: '0'.repeat(40), checkout: false}), {code: 'invalid'});
    await assert.rejects(run(repository, {kind: 'createBranch', name: 'x', at: git('rev-parse', 'HEAD^{tree}'), checkout: false}),
        {code: 'invalid'});
    await assert.rejects(run(repository, {kind: 'createBranch', name: 'x', at: 'main', checkout: false}), {code: 'invalid'});
    await assert.rejects(run(repository, {kind: 'createBranch', name: 'x', at: initial, fromRemote: true, checkout: false}),
        {code: 'invalid'});
    assert.equal(git('for-each-ref', '--format=%(refname) %(objectname)'), refs);
    git('fsck', '--no-progress');
});
