import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createSaveCommitQueue} from '../dist/task-queue.js';
import {directoryHandle} from './directory.js';

function memoryJournal(beforePut) {
    const records = new Map();
    return {
        async get(id) {return records.get(id);},
        async list() {return [...records.values()];},
        async put(record) {
            beforePut?.(record.job);
            records.set(record.job.id, {root: record.root, job: structuredClone(record.job)});
        }
    };
}

async function fixture(t, journal = memoryJournal()) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twgit-queue-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trimEnd();
    const write = (name, bytes) => fs.writeFile(path.join(root, name), bytes);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Queue fixture');
    git('config', 'user.email', 'queue@example.invalid');
    await fs.mkdir(path.join(root, 'project/assets'), {recursive: true});
    await write('project/project.source.json', '{"targets":[]}\n');
    await write('project/assets/removed', 'old');
    await write('notes.txt', 'initial\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    const makeQueue = (beforeWrite, projectFolder) => {
        const handle = directoryHandle(root, beforeWrite);
        handle.isSameEntry = async other => handle.location === other.location;
        return createSaveCommitQueue({root: handle, journal, projectFolder});
    };
    return {root, git, write, makeQueue};
}

test('commits exactly the captured saved project including binary assets and deletes', async t => {
    const {root, git, write, makeQueue} = await fixture(t);
    const queue = makeQueue();
    await write('project/project.source.json', '{"targets":[1]}\n');
    await write('project/assets/new', Uint8Array.of(0, 1, 255));
    await fs.rm(path.join(root, 'project/assets/removed'));
    await write('notes.txt', 'outside the approved project scope\n');
    const selection = await queue.capture({scope: 'project'});
    const job = await queue.enqueue({selection, message: 'Update project'});
    assert.deepEqual(selection.files.map(file => file.path), [
        'project/assets/new', 'project/assets/removed', 'project/project.source.json'
    ]);
    assert.equal(job.status, 'queued');
    const [result, repeated] = await Promise.all([queue.run(job.id), queue.run(job.id)]);
    assert.equal(result.status, 'completed');
    assert.deepEqual(repeated, result);
    assert.equal(git('rev-parse', 'HEAD'), result.commitOid);
    assert.equal(git('rev-list', '--count', 'HEAD'), '2');
    assert.match(git('show', '--name-status', '--format=', 'HEAD'), /D\s+project\/assets\/removed/u);
    assert.deepEqual(execFileSync('git', ['show', 'HEAD:project/assets/new'], {cwd: root}), Buffer.from([0, 1, 255]));
    assert.equal(git('status', '--porcelain'), ' M notes.txt');
    assert.match(result.publicationRef, /^refs\/heads\/tw-plus\/pr-/u);
});

test('blocks changed snapshot bytes, unrelated staged files and a moved branch', async t => {
    const {git, write, makeQueue} = await fixture(t);
    const queue = makeQueue();
    const head = git('rev-parse', 'HEAD');
    await write('project/project.source.json', '{"targets":[1]}\n');
    const job = await queue.enqueue({selection: await queue.capture({scope: 'project'}), message: 'Update project'});
    await write('project/project.source.json', '{"targets":[2]}\n');
    assert.equal((await queue.run(job.id)).status, 'blocked');
    assert.equal(git('status', '--porcelain'), ' M project/project.source.json');
    await write('project/project.source.json', '{"targets":[1]}\n');
    await write('notes.txt', 'outside\n');
    git('add', 'notes.txt');
    assert.equal((await queue.run(job.id)).status, 'blocked');
    assert.equal(git('status', '--porcelain'), 'M  notes.txt\n M project/project.source.json');
    assert.equal(git('rev-parse', 'HEAD'), head);
    git('commit', '-qm', 'Other commit');
    assert.equal((await queue.run(job.id)).status, 'blocked');
    assert.equal(git('log', '-1', '--format=%s'), 'Other commit');
});

test('a project-folder queue refuses an ignored source asset and excludes other files in the folder', async t => {
    const {git, write, makeQueue} = await fixture(t);
    const queue = makeQueue(undefined, 'project');
    const asset = 'project/assets/' + 'a'.repeat(32) + '.svg';
    await write('project/project.source.json', '{"targets":[1]}\n');
    await write('project/notes.txt', 'Outside project source');
    await write(asset, '<svg/>');
    await write('.gitignore', asset + '\n');
    const head = git('rev-parse', 'HEAD');
    await assert.rejects(queue.capture(), {code: 'ignoredProjectFile'});
    assert.equal(git('rev-parse', 'HEAD'), head);
    await write('.gitignore', 'project/notes.txt\n');
    const selection = await queue.capture();
    assert.deepEqual(selection.files.map(file => file.path), [asset, 'project/project.source.json']);
    assert.equal((await queue.run((await queue.enqueue({selection, message: 'Save the project'})).id)).status, 'completed');
    assert.equal(git('show', 'HEAD:' + asset), '<svg/>');
});

test('reconciles a committed ref after the final journal write was interrupted', async t => {
    let interrupted = false;
    const journal = memoryJournal(job => {
        if (interrupted && job.status === 'completed') throw new Error('journal unavailable');
    });
    const {git, write, makeQueue} = await fixture(t, journal);
    const queue = makeQueue();
    await write('project/project.source.json', '{"targets":[1]}\n');
    const {id} = await queue.enqueue({selection: await queue.capture({scope: 'project'}), message: 'Update project'});
    interrupted = true;
    await assert.rejects(queue.run(id), /journal unavailable/u);
    const expected = git('rev-parse', 'HEAD');
    assert.deepEqual((await queue.list()).map(job => [job.status, job.preparedOid]), [['prepared', expected]]);
    interrupted = false;
    const [restored] = await makeQueue().resume();
    assert.equal(restored.status, 'completed');
    assert.equal(restored.commitOid, expected);
    assert.equal(git('rev-list', '--count', 'HEAD'), '2');
});

test('journal preparation precedes every Git write and refuses a job from another checkout', async t => {
    let prepared = false;
    const journal = memoryJournal(job => {
        if (job.status === 'prepared') prepared = true;
    });
    const {git, write, makeQueue} = await fixture(t, journal);
    const queue = makeQueue(() => assert.equal(prepared, true));
    const other = (await fixture(t, journal)).makeQueue();
    await write('project/project.source.json', '{"targets":[1]}\n');
    const {id} = await queue.enqueue({selection: await queue.capture({scope: 'project'}), message: 'Update project'});
    assert.deepEqual(await other.list(), []);
    await assert.rejects(other.run(id), {code: 'invalid'});
    assert.equal((await queue.run(id)).status, 'completed');
    assert.equal(git('log', '-1', '--format=%s'), 'Update project');
});
