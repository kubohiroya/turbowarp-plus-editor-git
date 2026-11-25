import assert from 'node:assert/strict';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'node:test';
import {validateSourceFiles} from '@kubohiroya/sb3-toolchain/browser';
import {openRepository} from '../dist/repository.js';
import {directoryHandle} from './directory.js';
import {mergePlanFixture} from './merge-plan-fixture.js';

async function clean(fixture) {
    fixture.git('reset', '--hard');
    await rm(path.join(fixture.project, 'notes.txt'));
}

const sourceRef = 'refs/remotes/origin/main';
const build = (repository, fixture) => repository.planMerge(fixture.folder, {branch: 'main', head: fixture.head}, sourceRef);
const finalize = (repository, {plan, files}, guard = () => {}) => repository.localOperation(
    {kind: 'finalizeMergePlan', plan, files, message: 'Merge the tested generation', validate: validateSourceFiles}, guard);

test('plans a merge from committed tips in a nested project, with a dirty index and work tree', async t => {
    const fixture = await mergePlanFixture(t);
    const before = await fixture.snapshot();
    const root = directoryHandle(fixture.root, () => assert.fail('Merge planning attempted to write to the original'));
    const repository = await openRepository(root);
    const branches = await repository.mergePlanBranches('main');
    assert.ok(branches.some(({ref}) => ref === 'refs/heads/incoming'));
    assert.ok(branches.some(({ref}) => ref === 'refs/remotes/origin/main'));
    const {plan, files} = await repository.planMerge(fixture.folder, {branch: 'main', head: fixture.head}, 'refs/remotes/origin/main');
    assert.equal(plan.inputs.base, fixture.base);
    assert.equal(plan.inputs.current.oid, fixture.head);
    assert.equal(plan.inputs.incoming.oid, fixture.incoming);
    assert.deepEqual(plan.conflicts, []);
    const preview = new Map([...files].filter(([path]) => !path.endsWith('.md')));
    validateSourceFiles(preview);
    const read = files => JSON.parse(new TextDecoder().decode(files.get('project.source.json')));
    const {move, turn} = read(preview).targets[1].blocks;
    assert.deepEqual(move.inputs.STEPS, [1, [4, '25']]);
    assert.deepEqual(turn.inputs.DEGREES, [1, [4, '30']]);
    assert.equal(new TextDecoder().decode(files.get('README.md')), 'A local project\n');
    assert.ok(!files.has('notes.txt'));
    assert.match(plan.contentId, /^[a-f0-9]{64}$/);
    assert.deepEqual(await fixture.snapshot(), before);
});

test('finalizes only the selected tree with two ordered parents and leaves the checkout clean', async t => {
    const fixture = await mergePlanFixture(t);
    const repository = await openRepository(directoryHandle(fixture.root));
    const generation = await build(repository, fixture);
    const dirty = await fixture.snapshot();
    await assert.rejects(finalize(repository, generation), {code: 'mergeCommitDirty'});
    assert.deepEqual(await fixture.snapshot(), dirty);
    await clean(fixture);
    const cleanBefore = await fixture.snapshot();
    const preview = await repository.prepareMergeCommit(generation.plan, generation.files, validateSourceFiles);
    assert.ok(preview.some(change => change.relative === 'project.source.json'));
    assert.deepEqual(await fixture.snapshot(), cleanBefore);
    const oid = await finalize(repository, generation);
    assert.equal(fixture.git('rev-parse', 'HEAD'), oid);
    assert.equal(fixture.git('show', '-s', '--format=%P', oid), fixture.head + ' ' + fixture.incoming);
    assert.equal(fixture.git('rev-parse', sourceRef), fixture.incoming);
    assert.equal(fixture.git('status', '--porcelain'), '');
    const names = fixture.git('ls-tree', '-r', '--name-only', oid, '--', fixture.folder).split('\n');
    assert.deepEqual(names, [...generation.files.keys()].sort().map(relative => fixture.folder + '/' + relative));
    for (const [relative, bytes] of generation.files) {
        const file = fixture.folder + '/' + relative;
        const text = fixture.git('show', oid + ':' + file);
        assert.equal(text, new TextDecoder().decode(bytes).trimEnd(), file);
    }
    await assert.rejects(finalize(repository, generation), {code: 'mergeCommitTipsChanged'});
});

test('rejects changed tips, changed snapshot bytes and active Git operations before writing', async t => {
    const fixture = await mergePlanFixture(t);
    await clean(fixture);
    const repository = await openRepository(directoryHandle(fixture.root, () => assert.fail('Unsafe merge attempted to write')));
    const generation = await build(repository, fixture);
    const wrongFiles = new Map(generation.files);
    wrongFiles.set('README.md', new TextEncoder().encode('Unexpected revision'));
    await assert.rejects(finalize(repository, {...generation, files: wrongFiles}), {code: 'mergeCommitInvalid'});
    await writeFile(path.join(fixture.root, '.git/MERGE_HEAD'), fixture.incoming);
    await assert.rejects(finalize(repository, generation), {code: 'locked'});
    await rm(path.join(fixture.root, '.git/MERGE_HEAD'));
    await repository.prepareMergeCommit(generation.plan, generation.files, validateSourceFiles);
    fixture.git('update-ref', sourceRef, fixture.base);
    const before = await fixture.snapshot();
    await assert.rejects(finalize(repository, generation), {code: 'mergeCommitTipsChanged'});
    assert.deepEqual(await fixture.snapshot(), before);
});

test('refuses an incoming change outside the project and preserves unrelated current-side files', async t => {
    const fixture = await mergePlanFixture(t);
    await clean(fixture);
    fixture.git('switch', 'incoming');
    await writeFile(path.join(fixture.root, 'outside.txt'), 'incoming only\n');
    const incoming = fixture.commit('Change outside the project');
    fixture.git('switch', 'main');
    const repository = await openRepository(directoryHandle(fixture.root));
    const rejected = await repository.planMerge(fixture.folder, {branch: 'main', head: fixture.head}, 'refs/heads/incoming');
    await assert.rejects(finalize(repository, rejected), {code: 'mergeCommitOutsideProject'});
    await writeFile(path.join(fixture.root, 'outside.txt'), 'incoming only\n');
    const head = fixture.commit('Keep the same change, already on current');
    const accepted = await repository.planMerge(fixture.folder, {branch: 'main', head}, 'refs/heads/incoming');
    const oid = await finalize(repository, accepted);
    assert.equal(fixture.git('show', '-s', '--format=%P', oid), head + ' ' + incoming);
    assert.equal(fixture.git('show', oid + ':outside.txt'), 'incoming only');
});

test('rolls back the index and worktree when the source ref changes during application', async t => {
    const fixture = await mergePlanFixture(t, '');
    await clean(fixture);
    const before = await fixture.snapshot();
    let advanced = false;
    const repository = await openRepository(directoryHandle(fixture.root, file => {
        if (advanced || file !== path.join(fixture.root, 'project.source.json')) return;
        advanced = true;
        fixture.git('update-ref', sourceRef, fixture.base);
    }));
    const generation = await build(repository, fixture);
    await assert.rejects(finalize(repository, generation), {code: 'mergeCommitTipsChanged'});
    assert.equal(advanced, true);
    fixture.git('update-ref', sourceRef, fixture.incoming);
    assert.deepEqual(await fixture.snapshot(), before);
});

test('finalizes additions and deletions and refuses an ignored collision before review', async t => {
    const fixture = await mergePlanFixture(t, '');
    await clean(fixture);
    fixture.git('switch', 'incoming');
    await mkdir(path.join(fixture.root, 'new'));
    await writeFile(path.join(fixture.root, 'new/file.txt'), 'new file\n');
    await rm(path.join(fixture.root, 'README.md'));
    const incoming = fixture.commit('Add and remove files');
    fixture.git('switch', 'main');
    fixture.git('update-ref', sourceRef, incoming);
    const repository = await openRepository(directoryHandle(fixture.root));
    const generation = await build(repository, fixture);
    await writeFile(path.join(fixture.root, '.git/info/exclude'), 'new/\n');
    await mkdir(path.join(fixture.root, 'new'));
    await writeFile(path.join(fixture.root, 'new/file.txt'), 'existing ignored contents\n');
    await assert.rejects(repository.prepareMergeCommit(generation.plan, generation.files, validateSourceFiles),
        {code: 'mergeCommitDirty'});
    await rm(path.join(fixture.root, 'new'), {recursive: true});
    const oid = await finalize(repository, generation);
    assert.equal(fixture.git('show', oid + ':new/file.txt'), 'new file');
    assert.equal(fixture.git('ls-files', 'README.md'), '');
    assert.equal(fixture.git('status', '--porcelain'), '');
});

test('shows a same-block conflict while a provisional candidate still uses the common base value', async t => {
    const fixture = await mergePlanFixture(t);
    await fixture.put(35, 30);
    const head = fixture.commit('Walk 35 steps and turn 30 degrees');
    const before = await fixture.snapshot();
    const repository = await openRepository(directoryHandle(fixture.root));
    await assert.rejects(repository.planMerge(fixture.folder, {branch: 'main', head: fixture.head}, 'refs/heads/incoming'),
        {code: 'changed'});
    const {plan, files} = await repository.planMerge(fixture.folder, {branch: 'main', head}, 'refs/heads/incoming');
    assert.ok(plan.conflicts.some(({type}) => type === 'project'));
    validateSourceFiles(new Map([...files].filter(([path]) => !path.endsWith('.md') && path !== 'notes.txt')));
    const {move, turn} = JSON.parse(new TextDecoder().decode(files.get('project.source.json'))).targets[1].blocks;
    // The merge engine keeps the entire conflicting script at the base until it is resolved.
    assert.deepEqual(move.inputs.STEPS, [1, [4, '10']]);
    assert.deepEqual(turn.inputs.DEGREES, [1, [4, '15']]);
    assert.deepEqual(await fixture.snapshot(), before);
});
