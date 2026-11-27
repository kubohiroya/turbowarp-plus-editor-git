import test from 'node:test';
import assert from 'node:assert/strict';
import {createSaveCommitWorkflows} from '../dist/save-commit-workflows.js';
function fixture() {
    const calls: string[] = [];
    let current = true;
    const directory = {};
    const selection = {branch: 'main', files: [{path: 'project.json'}]};
    const job = {id: 'job'};
    const folder = {directory, save: async () => {calls.push('save');}};
    const queue = {capture: async () => {calls.push('capture'); return selection;}, list: async () => [job],
        enqueue: async input => {assert.equal(input.selection, selection); calls.push(input.message); return job;}, run: async () => job};
    const options = {view: {indexedDB: {}}, folder, getRepository: () => ({root: directory, current: () => current}),
        isCurrent: () => current, createCommitJournal: () => {calls.push('journal'); return {};},
        createCommitQueue: () => {calls.push('queue'); return queue;},
        saveWithLock: async operation => {calls.push('lock'); return operation();},
        flushEdits: async () => {calls.push('flush');}, readAuthor: async () => undefined, refresh: () => {calls.push('refresh');}};
    return {calls, options, folder, stale: () => {current = false;}, workflows: () => createSaveCommitWorkflows(options as never)};
}
test('collects edits and saves under the lock before capturing the commit; reuses its queue', async () => {
    const f = fixture(); const get = f.workflows(); const commit = get().commit!;
    const prepared = await commit.prepare(() => true);
    assert.deepEqual(f.calls, ['journal','queue','lock','flush','save','capture']);
    assert.deepEqual(prepared?.paths, ['project.json']);
    await prepared!.enqueue('message'); await commit.jobs(); await commit.run('job');
    assert.deepEqual(f.calls.slice(-2), ['message','refresh']);
    assert.equal(f.calls.filter(x => x === 'queue').length, 1);
    await get().commit!.jobs();
    assert.equal(f.calls.filter(x => x === 'journal').length, 1);
});
test('a changed VM/repository refuses commit work and a cancelled request never saves', async () => {
    const f = fixture(); const commit = f.workflows()().commit!;
    assert.equal(await commit.prepare(() => false), null);
    assert.ok(!f.calls.includes('save'));
    f.stale(); await assert.rejects(commit.prepare(() => true), {code: 'changed'});
});
test('changing folders while collecting edits prevents saving the replacement project', async () => {
    const f = fixture(); f.options.flushEdits = async () => {f.folder.directory = {};};
    await assert.rejects(f.workflows()().commit!.prepare(() => true), {code: 'changed'});
    assert.ok(!f.calls.includes('save'));
});
test('missing services leave commit unavailable, and a folder outside the repository is rejected', async () => {
    const f = fixture();
    assert.deepEqual(createSaveCommitWorkflows({...f.options, createCommitQueue: undefined} as never)(), {});
    f.options.getRepository = () => ({root: {resolve: async () => null}, current: () => true}) as never;
    await assert.rejects(f.workflows()().commit!.jobs(), {code: 'outsideRepository'});
});

test('a solo account supplies the confirmed author without creating a pair timeline record', async () => {
    const f=fixture();let captured: unknown,recorded=false;
    const author={name:'Chosen account',email:'chosen@example.test'};
    const create=f.options.createCommitQueue;
    f.options.createCommitQueue=()=>({...create(),enqueue:async input=>{captured=input;return {id:'solo'};},
        run:async()=>({id:'solo',status:'completed',commitOid:'a'.repeat(40)})}) as never;
    Object.assign(f.options,{collaboration:{async prepareCommit(){return {message:'Solo change',author,explicitAuthor:true};},
        async committed(){recorded=true;}}});
    const commit=f.workflows()().commit!,prepared=await commit.prepare(()=>true);
    await prepared!.enqueue('Original');await commit.run('solo');
    assert.deepEqual((captured as {author:unknown}).author,author);
    assert.equal((captured as {collaboration?:unknown}).collaboration,undefined);assert.equal(recorded,false);
});
