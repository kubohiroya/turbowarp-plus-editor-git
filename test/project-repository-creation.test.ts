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

function fixture(inspection: RepositoryCreationInspection, firstError = 'unknown', options?: {
    cloned?: boolean;
    openProject?: (directory: FileSystemDirectoryHandle, root: FileSystemDirectoryHandle, id?: string | null) => Promise<boolean>;
    openLegacyProject?: () => Promise<boolean>;
}) {
    type Task = Parameters<RepositoryCreationJournal['add']>[0];
    const records = new Map<string, Task>();
    const journal: RepositoryCreationJournal = {
        async add(task) {records.set(task.operationId, task);},
        async read(id) {return options?.cloned ? structuredClone(records.get(id)) : records.get(id);},
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
        openProject: options?.openProject ?? (async () => false),
        openLegacyProject: options?.openLegacyProject,
        async pickDirectory() {return directory;}
    });
    const start = (browserProjectId?: string | null) => workflow.start({directory, draft, signal: interaction.signal, browserProjectId,
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

test('passes the managed project ID from a reread journal without re-pushing after a failed open', async () => {
    const opened: (string | null | undefined)[] = [];
    const {workflow, start, journal, attempts, pushes} = fixture({status: 'absent'}, 'unknown', {cloned: true,
        async openProject(reopened, root, id) {
            assert.notEqual(reopened, directory, 'the journal returned a different handle object');
            assert.equal(reopened, root, 'the repository is at the project root');
            opened.push(id);
            return false; // A browser tab that fails to open must not replay creation or initial push.
        }
    });
    const pending = await start('managed-2026');
    const record = (await journal.read(pending.operationId))!;
    assert.equal(record.browserProjectId, 'managed-2026');
    await journal.write({...record, phase: 'open'});
    assert.equal(await workflow.open(pending), false);
    assert.deepEqual(opened, ['managed-2026']);
    assert.deepEqual(attempts, []);
    assert.equal(pushes(), 0);
    assert.equal((await journal.read(pending.operationId))!.phase, 'open');
});

test('preserves device and old journal opens but refuses a malformed managed ID', async () => {
    const opened: (string | null | undefined)[] = [];
    const {workflow, start, journal} = fixture({status: 'absent'}, 'unknown',
        {async openProject(_directory, _root, id) {opened.push(id); return true;}});
    await assert.rejects(start('../wrong'), {code: 'invalidRequest'});
    assert.deepEqual(await workflow.list(), []);
    for (const id of [null, undefined]) {
        const pending = await start(id);
        const record = (await journal.read(pending.operationId))!;
        await journal.write({...record, phase: 'open'});
        assert.equal(await workflow.open(pending), true);
    }
    const stale = await start('managed-folder');
    await journal.write({...await journal.read(stale.operationId), phase: 'open', browserProjectId: 'injected/invalid'});
    assert.equal(await workflow.open(stale), false);
    assert.deepEqual(opened, [null, undefined]);
});

test('offers explicit legacy recovery without dereferencing or removing the old journal handle', async () => {
    let recoveries = 0;
    const {workflow, start, journal, attempts, pushes} = fixture({status: 'absent'}, 'unknown', {
        async openProject() {assert.fail('legacy handle must not be reopened');},
        async openLegacyProject() {recoveries++; return false;}
    });
    const pending = await start();
    await journal.write({...await journal.read(pending.operationId), phase: 'open',
        directory: {async queryPermission() {assert.fail('legacy handle must not be consulted');}} as unknown as FileSystemDirectoryHandle});
    assert.equal(await workflow.open(pending), false);
    assert.equal(recoveries, 1);
    assert.deepEqual(attempts, []);
    assert.equal(pushes(), 0);
    assert.equal((await journal.read(pending.operationId))!.phase, 'open');
});
