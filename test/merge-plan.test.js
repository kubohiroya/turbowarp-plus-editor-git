import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateSourceFiles} from '@kubohiroya/sb3-toolchain/browser';
import {openRepository} from '../dist/repository.js';
import {directoryHandle} from './directory.js';
import {mergePlanFixture} from './merge-plan-fixture.js';

test('plans a merge from committed tips in a nested project, with a dirty index and work tree', async t => {
    const fixture = await mergePlanFixture(t);
    const before = await fixture.snapshot();
    const root = directoryHandle(fixture.root, () => assert.fail('Merge planning attempted to write to the original'));
    const repository = await openRepository(root);
    const branches = await repository.mergePlanBranches('main');
    assert.ok(branches.some(({ref}) => ref === 'refs/heads/incoming'));
    assert.ok(branches.some(({ref}) => ref === 'refs/remotes/origin/main'));
    const plan = await repository.planMerge(fixture.folder, {branch: 'main', head: fixture.head}, 'refs/remotes/origin/main');
    assert.equal(plan.inputs.base, fixture.base);
    assert.equal(plan.inputs.current.oid, fixture.head);
    assert.equal(plan.inputs.incoming.oid, fixture.incoming);
    assert.deepEqual(plan.conflicts, []);
    const preview = plan.previewFiles();
    validateSourceFiles(preview);
    const read = files => JSON.parse(new TextDecoder().decode(files.get('project.source.json')));
    const {move, turn} = read(preview).targets[1].blocks;
    assert.deepEqual(move.inputs.STEPS, [1, [4, '25']]);
    assert.deepEqual(turn.inputs.DEGREES, [1, [4, '30']]);
    assert.ok(!preview.has('README.md'));
    assert.ok(!preview.has('notes.txt'));
    preview.get('project.source.json').fill(0);
    assert.deepEqual(read(plan.previewFiles()).targets[1].blocks.move.inputs.STEPS, [1, [4, '25']]);
    assert.deepEqual(await fixture.snapshot(), before);
});

test('shows a same-block conflict while a provisional candidate still uses the common base value', async t => {
    const fixture = await mergePlanFixture(t);
    await fixture.put(35, 30);
    const head = fixture.commit('Walk 35 steps and turn 30 degrees');
    const before = await fixture.snapshot();
    const repository = await openRepository(directoryHandle(fixture.root));
    await assert.rejects(repository.planMerge(fixture.folder, {branch: 'main', head: fixture.head}, 'refs/heads/incoming'),
        {code: 'changed'});
    const plan = await repository.planMerge(fixture.folder, {branch: 'main', head}, 'refs/heads/incoming');
    assert.ok(plan.conflicts.some(({type}) => type === 'project'));
    const files = plan.previewFiles();
    validateSourceFiles(files);
    const {move, turn} = JSON.parse(new TextDecoder().decode(files.get('project.source.json'))).targets[1].blocks;
    // The merge engine keeps the entire conflicting script at the base until it is resolved.
    assert.deepEqual(move.inputs.STEPS, [1, [4, '10']]);
    assert.deepEqual(turn.inputs.DEGREES, [1, [4, '15']]);
    assert.deepEqual(await fixture.snapshot(), before);
});
