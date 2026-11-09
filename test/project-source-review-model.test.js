import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compareProjectForReview} from '@kubohiroya/turbowarp-plus-editor-git/project-source-diff';

const stage = {isStage: true, name: 'Stage', blocks: {}};
const sprite = (blocks, name = 'Cat') => ({isStage: false, name, blocks});
const project = (...targets) => ({targets: [stage, ...targets]});
const review = (before, after) => compareProjectForReview(before, after);
const onlyScript = result => {
    assert.equal(result.targets.length, 1);
    assert.equal(result.targets[0].scripts.length, 1);
    return result.targets[0].scripts[0];
};
const allMarks = script => [...script.before, ...script.after].flatMap(side => side.marks);

// when flag clicked → move 10 → say hello
const base = () => ({
    flag: {opcode: 'event_whenflagclicked', next: 'move', parent: null, topLevel: true, x: 0, y: 0},
    move: {opcode: 'motion_movesteps', next: 'say', parent: 'flag', inputs: {STEPS: [1, [4, '10']]}, topLevel: false},
    say: {opcode: 'looks_say', next: null, parent: 'move', inputs: {MESSAGE: [1, 'text']}, topLevel: false},
    text: {opcode: 'text', shadow: true, parent: 'say', fields: {TEXT: ['hello', null]}, topLevel: false}
});

test('a script whose blocks only moved has no marks and is moved', () => {
    const blocks = base();
    blocks.flag = {...blocks.flag, x: 120, y: 80};
    const script = onlyScript(review(project(sprite(base())), project(sprite(blocks))));
    assert.equal(script.kind, 'moved');
    assert.deepEqual(script.summary, [{kind: 'moved'}]);
    assert.deepEqual(allMarks(script), []);
});

test('a script whose blocks were only reconnected is reordered', () => {
    const blocks = base();
    blocks.flag = {...blocks.flag, next: 'say'};
    blocks.say = {...blocks.say, parent: 'flag', next: 'move'};
    blocks.move = {...blocks.move, parent: 'say', next: null};
    const script = onlyScript(review(project(sprite(base())), project(sprite(blocks))));
    assert.equal(script.kind, 'reordered');
    assert.deepEqual(script.summary, [{kind: 'reordered'}]);
    assert.deepEqual(allMarks(script), []);
});

test('replacing the hat, wrapping existing blocks in a repeat, changing a value and adding blocks are all summarized', () => {
    const old = base();
    const blocks = {
        clicked: {opcode: 'event_whenthisspriteclicked', next: 'repeat', parent: null, topLevel: true, x: 0, y: 0},
        repeat: {opcode: 'control_repeat', next: 'wait', parent: 'clicked', inputs: {TIMES: [1, 'times'], SUBSTACK: [2, 'move']}, topLevel: false},
        times: {opcode: 'math_whole_number', shadow: true, parent: 'repeat', fields: {NUM: ['10', null]}, topLevel: false},
        move: {...old.move, parent: 'repeat', inputs: {STEPS: [1, [4, '25']]}},
        say: old.say,
        text: old.text,
        wait: {opcode: 'control_wait', next: null, parent: 'repeat', inputs: {DURATION: [1, [5, '1']]}, topLevel: false}
    };
    const script = onlyScript(review(project(sprite(old)), project(sprite(blocks))));
    assert.equal(script.kind, 'updated');
    assert.deepEqual(script.summary, [
        {kind: 'hatReplaced', before: 'event_whenflagclicked', after: 'event_whenthisspriteclicked'},
        {kind: 'wrapped', opcode: 'control_repeat'},
        {kind: 'valueChanged', opcode: 'motion_movesteps', name: 'STEPS'},
        {kind: 'blocksAdded', count: 1}
    ]);
    const marks = allMarks(script);
    assert.ok(marks.some(mark => mark.id === 'move' && mark.kind === 'updated'));
    assert.ok(marks.some(mark => mark.id === 'repeat' && mark.kind === 'added'));
    assert.ok(!marks.some(mark => mark.id === 'say'), 'a block that only changed connections is not marked');
});

test('an added if block is a branch, not a block count', () => {
    const old = base();
    const blocks = {
        ...old,
        say: {...old.say, next: 'if'},
        if: {opcode: 'control_if', next: null, parent: 'say', inputs: {CONDITION: [2, 'touching'], SUBSTACK: [2, 'stop']}, topLevel: false},
        touching: {opcode: 'sensing_touchingobject', parent: 'if', inputs: {TOUCHINGOBJECTMENU: [1, 'menu']}, topLevel: false},
        menu: {opcode: 'sensing_touchingobjectmenu', shadow: true, parent: 'touching', fields: {TOUCHINGOBJECTMENU: ['_edge_', null]}, topLevel: false},
        stop: {opcode: 'control_stop', parent: 'if', fields: {STOP_OPTION: ['all', null]}, topLevel: false}
    };
    const script = onlyScript(review(project(sprite(old)), project(sprite(blocks))));
    assert.equal(script.kind, 'updated');
    assert.deepEqual(script.summary, [{kind: 'branchAdded', opcode: 'control_if'}, {kind: 'blocksAdded', count: 2}]);
    assert.ok(!allMarks(script).some(mark => mark.id === 'say'));
});

test('added and removed scripts count their non-shadow blocks', () => {
    const added = onlyScript(review(project(sprite({})), project(sprite(base()))));
    assert.equal(added.kind, 'added');
    assert.deepEqual(added.summary, [{kind: 'blocksAdded', count: 3}]);
    const removed = onlyScript(review(project(sprite(base())), project(sprite({}))));
    assert.equal(removed.kind, 'removed');
    assert.deepEqual(removed.summary, [{kind: 'blocksRemoved', count: 3}]);
    assert.equal(allMarks(removed).length, 4);
});

test('a script split in two is reorganized', () => {
    const blocks = base();
    blocks.move = {...blocks.move, next: null};
    blocks.say = {...blocks.say, parent: null, topLevel: true, x: 0, y: 200};
    const script = onlyScript(review(project(sprite(base())), project(sprite(blocks))));
    assert.equal(script.kind, 'reorganized');
    assert.equal(script.before.length, 1);
    assert.equal(script.after.length, 2);
    assert.deepEqual(allMarks(script), []);
});

test('added and removed targets carry their status without listing their properties', () => {
    const star = {...sprite(base(), 'ほし'), volume: 100, draggable: false, costumes: []};
    const addedResult = review(project(), project(star));
    assert.equal(addedResult.targets.length, 1);
    assert.equal(addedResult.targets[0].status, 'added');
    assert.equal(addedResult.targets[0].name, 'ほし');
    assert.deepEqual(addedResult.targets[0].properties, []);
    assert.equal(addedResult.targets[0].scripts[0].kind, 'added');

    const empty = {...sprite({}, 'ほし'), volume: 100};
    const removedResult = review(project(empty), project());
    assert.equal(removedResult.targets.length, 1);
    assert.equal(removedResult.targets[0].status, 'removed');
    assert.deepEqual(removedResult.targets[0].properties, []);

    const changed = review(project(empty), project({...empty, volume: 50}));
    assert.equal(changed.targets[0].status, 'updated');
    assert.deepEqual(changed.targets[0].properties, ['volume']);
});
