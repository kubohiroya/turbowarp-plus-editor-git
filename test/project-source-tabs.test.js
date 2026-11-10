import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openProjectSourceTabs} from '@kubohiroya/turbowarp-plus-editor-git/project-source-diff';

const cat = (blocks, extra = {}) => ({isStage: false, name: 'Cat', blocks, ...extra});
const before = {targets: [
    {isStage: true, name: 'Stage', blocks: {}, costumes: [{name: 'blue sky', md5ext: 'a.svg'}]},
    cat({
        flag: {opcode: 'event_whenflagclicked', next: 'move', topLevel: true},
        move: {opcode: 'motion_movesteps', parent: 'flag', inputs: {STEPS: [1, [4, '10']]}},
        key: {opcode: 'event_whenkeypressed', topLevel: true, next: 'say'},
        say: {opcode: 'looks_say', parent: 'key', inputs: {MESSAGE: [1, [10, 'hello']]}}
    })
]};
const after = structuredClone(before);
after.targets[0].costumes = [{name: 'night', md5ext: 'b.svg'}];
after.targets[1].blocks.move.inputs.STEPS[1][1] = '25';
after.targets[1].blocks.say.inputs.MESSAGE[1][1] = 'bye';
after.targets.push({isStage: false, name: 'Dog', blocks: {}});

test('a comparison opens as a tab group per stage or sprite, with a tab per changed script', () => {
    const requests = [];
    const count = openProjectSourceTabs(request => { requests.push(request); return true; }, {
        key: 'main:project.source.json', locale: 'ja', renderBlock: async () => {},
        files: [{path: 'project.source.json', before, after}]
    });
    assert.equal(count, requests.length);
    const groups = new Map();
    for (const request of requests) {
        assert.equal(request.transient, true);
        assert.equal(request.area, 'turbowarp-plus-git:diff:main:project.source.json');
        assert.equal(request.reference.providerId, 'turbowarp-plus-git');
        if (!request.tabGroup) continue;
        const titles = groups.get(request.tabGroup.id)?.titles ?? [];
        groups.set(request.tabGroup.id, {label: request.tabGroup.label, color: request.tabGroup.color, titles: [...titles, request.title]});
    }
    assert.deepEqual([...groups.values()].map(({label, color}) => [label, color]),
        [['ステージ', 'blue'], ['Cat', 'blue'], ['Dog', 'green']]);
    const catTitles = [...groups.values()][1].titles;
    assert.equal(catTitles.length, 2, 'one tab for each changed script of the cat');
    assert.ok(catTitles.some(title => title.startsWith('緑の旗が押されたとき')), catTitles.join());
    // Only the first tab comes forward, so opening many tabs does not flash through them.
    assert.deepEqual(requests.map(request => request.inactive), requests.map((_, index) => index > 0));
    assert.equal(new Set(requests.map(request => request.reference.documentId)).size, requests.length);
});

test('without a workspace nothing opens, and a refused tab stops the rest', () => {
    const options = {key: 'k', renderBlock: async () => {}, files: [{path: 'project.source.json', before, after}]};
    assert.equal(openProjectSourceTabs(undefined, options), 0);
    let asked = 0;
    assert.equal(openProjectSourceTabs(() => { asked++; return false; }, options), 0);
    assert.equal(asked, 1);
});
