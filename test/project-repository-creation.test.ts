import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import {createProjectRepositoryWorkflow, creationError} from '../dist/project-repository-creation.js';
import type {RepositoryCreationInspection, RepositoryCreationJournal} from '../dist/project-repository-creation.js';

const repository = {id: 37, owner: 'octocat', name: 'example', visibility: 'private' as const,
    remote: 'https://github.com/octocat/example.git'};
const directory = {} as FileSystemDirectoryHandle;
const draft = {account: 'octocat', owner: 'octocat', name: 'example', visibility: 'private' as const, title: 'Example',
    topics: [], description: '', license: null};
const interaction = {signal: new AbortController().signal, deviceCode() {}};

function fixture(inspection: RepositoryCreationInspection, firstError = 'unknown') {
    type Task = Parameters<RepositoryCreationJournal['add']>[0];
    const records = new Map<string, Task>();
    const journal: RepositoryCreationJournal = {
        async add(task) {records.set(task.operationId, task);},
        async read(id) {return records.get(id);},
        async list() {return [...records.values()];},
        async write(task) {records.set(task.operationId, task);},
        async remove(id) {records.delete(id);}
    };
    const attempts: string[] = [];
    const released: string[] = [];
    let pushes = 0;
    const workflow = createProjectRepositoryWorkflow({
        journal, exclusive: (_id, run) => run(),
        provider: {
            mode: 'cloudflare',
            async connect() {return {account: {login: 'octocat'}, owners: []};},
            async create(_session, {operationId}) {
                attempts.push(operationId);
                if (attempts.length === 1) throw creationError(firstError);
                return repository;
            },
            async inspect() {return inspection;},
            async topics() {throw new Error('No topics were requested');}
        },
        async prepare({repository: target}) {assert.equal(target.id, repository.id); return {oid: '1'.repeat(40)};},
        async startWrite() {return 'write grant';},
        async releaseWrite(grant) {released.push(grant);},
        async push() {pushes++;},
        async openProject() {return false;},
        async pickDirectory() {return directory;}
    });
    const start = () => workflow.start({directory, draft, signal: interaction.signal,
        files: [{path: 'README.md', bytes: Uint8Array.of(1)}], author: {name: 'octocat', email: 'octocat@example.invalid'}});
    const loseResponse = async () => {
        const progress = await start();
        await assert.rejects(workflow.advance(progress, interaction), {code: 'unknown'});
        const [pending] = await workflow.list();
        assert.equal(pending.phase, 'unknown');
        return pending;
    };
    return {workflow, start, loseResponse, journal, attempts, released, pushes: () => pushes};
}

test('a proven absent operation can retry with the same ID after a lost response', async () => {
    const {workflow, loseResponse, attempts} = fixture({status: 'absent'});
    const pending = await loseResponse();
    const {progress: resume} = await workflow.advance(pending, interaction);
    assert.equal(resume.phase, 'create');
    assert.deepEqual(attempts, [pending.operationId]);
    const {progress} = await workflow.advance(resume, interaction);
    assert.equal(progress.phase, 'push');
    assert.deepEqual(attempts, [pending.operationId, pending.operationId]);
});

test('recovers a recorded receipt without creating again and revokes a stale write grant', async () => {
    const {workflow, loseResponse, attempts, journal, released, pushes} = fixture({status: 'created', repository});
    const pending = await loseResponse();
    const {progress} = await workflow.advance(pending, interaction);
    assert.equal(progress.phase, 'push');
    assert.deepEqual(attempts, [pending.operationId]);
    await journal.write({...await journal.read(progress.operationId), phase: 'open'});
    assert.equal((await workflow.advance(progress, interaction)).progress.phase, 'open');
    await setImmediate();
    assert.deepEqual(released, ['write grant']);
    assert.equal(pushes(), 0);
});

test('a definitive native refusal releases the local record and allows a new confirmation', async () => {
    const {workflow, start, attempts} = fixture({status: 'refused', code: 'denied'}, 'denied');
    const first = await start();
    await assert.rejects(workflow.advance(first, interaction), {code: 'denied'});
    assert.deepEqual(await workflow.list(), []);
    const second = await start();
    assert.notEqual(second.operationId, first.operationId);
    assert.equal((await workflow.advance(second, interaction)).progress.phase, 'push');
    assert.deepEqual(attempts, [first.operationId, second.operationId]);
});
