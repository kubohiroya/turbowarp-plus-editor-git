import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readPlaytestObservation, registerPlaytestDebugger} from '../src/merge-playtest-observation.ts';
import {createMergePlanPlaytest} from '../src/merge-plan-sharing.ts';
import type {MergePlan} from '../src/merge-plan.ts';

test('reads only selected values, pages lists and uses the stopped clone when requested', () => {
    const original = {id: 'sprite', isOriginal: true, getName: () => 'Walker', variables: {
        score: {name: 'Score', type: '', value: 5},
        trail: {name: 'Trail', type: 'list', value: Array.from({length: 33}, (_, index) => index)}
    }};
    const clone = {...original, id: 'clone', isOriginal: false, variables: {...original.variables,
        score: {...original.variables.score, value: 42}}};
    const thread = {target: clone, topBlock: 'hat', peekStack: () => 'next'};
    const vm = {runtime: {targets: [original, clone], threads: [thread]}};
    let paused = true;
    registerPlaytestDebugger(vm, {
        paused: () => paused, thread: () => thread,
        logs: () => [{type: 'warn', text: 'notice', count: 2, blockId: 'previous', targetId: clone.id}]
    });
    const sample = readPlaytestObservation(vm, {variables: [
        {id: 'score'}, {id: 'score', targetId: clone.id}, {id: 'trail', offset: 32}, {id: 'missing'}
    ]});
    assert.equal(sample.state, 'paused');
    assert.deepEqual(sample.stop, {reason: 'breakpoint', target: 'Walker', targetId: 'clone', threadIndex: 0,
        topBlockId: 'hat', blockId: 'next'});
    assert.deepEqual(sample.values.map(value => [value.status, value.value]), [
        ['available', 5], ['available', 42], ['available', undefined], ['missing', undefined]
    ]);
    assert.deepEqual(sample.values[2].items, [{value: 32}]);
    assert.equal(sample.values[2].nextOffset, null);
    assert.deepEqual(sample.logs.entries.map(({message, count}) => [message, count]), [['notice', 2]]);
    assert.equal(clone.variables.score.value, 42);
    paused = false;
    const running = readPlaytestObservation(vm, {logLimit: 0});
    assert.equal(running.state, 'running');
    assert.equal(running.stop, null);
    assert.deepEqual(running.values, []);
    assert.equal(running.logs.status, 'omitted');
    vm.runtime.threads = [];
    assert.equal(readPlaytestObservation(vm, {}).state, 'idle');
});

test('links a merge conflict to its saved block and ignores an ended thread', () => {
    const target = {id: 'sprite', isOriginal: true, getName: () => 'Walker', variables: {}};
    const thread = {target, topBlock: 'hat', peekStack: () => 'reporter', status: 0};
    const vm = {runtime: {targets: [target], threads: [thread]}};
    const conflict = {thread, stop: {id: 'choice', target: 'Walker', script: 'hat', next: 'command',
        focus: 'reporter', previous: 'previous'}};
    const sample = readPlaytestObservation(vm, {}, conflict, true);
    assert.equal(sample.state, 'paused');
    assert.equal(sample.modifiedInPlayer, true);
    assert.deepEqual(sample.stop, {reason: 'merge-conflict', target: 'Walker', targetId: 'sprite', threadIndex: 0,
        topBlockId: 'hat', blockId: 'command', focusBlockId: 'reporter', lastExecutedBlockId: 'previous'});
    assert.equal(sample.logs.status, 'unavailable');
    thread.status = 4;
    assert.equal(readPlaytestObservation(vm, {}, conflict).stop, null);
});

test('a sample requested as the player closes returns no live data', async () => {
    const playtest = createMergePlanPlaytest();
    const {observe} = playtest.bind({id: 'generation', planId: 'plan', contentId: 'content'} as MergePlan);
    let close!: () => void;
    observe(() => new Promise((_, reject) => {
        close = () => {observe(null); reject(new Error('Player closed'));};
    }));
    const pending = playtest.current(undefined, {});
    close();
    assert.equal((await pending).playtest, null);
    await assert.rejects(playtest.current('ended', {}), /session has ended/);
});

test('records bind to the same session as MCP and cannot read a replacement player', async () => {
    const playtest = createMergePlanPlaytest();
    const first = playtest.bind({id: 'generation', planId: 'plan', contentId: 'content'} as MergePlan);
    const next = playtest.bind({id: 'new-generation', planId: 'plan', contentId: 'new-content'} as MergePlan);
    first.observe(async () => ({state: 'paused'}));
    const record = await first.capture({});
    const live = await playtest.current(undefined, {});
    assert.deepEqual(record.playtest, live.playtest);
    assert.deepEqual(record.observation, {state: 'paused'});
    next.observe(async () => ({state: 'running'}));
    await assert.rejects(first.capture({}), /session has ended/);
    first.observe(null);
    assert.equal((await next.capture({})).playtest?.generationId, 'new-generation');
});
