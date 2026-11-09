import assert from 'node:assert/strict';
import {test} from 'node:test';
import {organizeProjectChanges, projectPropertyLabel} from '@kubohiroya/turbowarp-plus-editor-git/project-source-diff';

const costume = (name, md5) => ({name, assetId: md5, md5ext: md5 + '.svg', dataFormat: 'svg', rotationCenterX: 0, rotationCenterY: 0});
const sound = (name, md5) => ({name, assetId: md5, md5ext: md5 + '.wav', dataFormat: 'wav', rate: 48000, sampleCount: 10});
const base = () => ({
    targets: [
        {isStage: true, name: 'Stage', blocks: {}, variables: {}, lists: {}, broadcasts: {}, costumes: [costume('backdrop1', 'bd')],
            sounds: [], tempo: 60},
        {isStage: false, name: 'Cat', blocks: {}, variables: {}, lists: {}, broadcasts: {}, costumes: [costume('cat-a', 'aa'),
            costume('cat-b', 'bb')], sounds: [sound('Meow', 'mm')], x: 0, y: 0, size: 100, visible: true},
        {isStage: false, name: 'Dog', blocks: {}, costumes: [costume('dog', 'dd')], sounds: [], x: 10}
    ],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0'}
});
const organize = (before, after, files, folder = 'game', assetsDirectory = {before: 'assets', after: 'assets'}) =>
    organizeProjectChanges({folder, before, after, assetsDirectory, files});
const target = (list, name) => list.targets.find(entry => entry.name === name);

test('a new costume joins the project file and its untracked asset in one row under the sprite', () => {
    const after = base();
    after.targets[1].costumes.push(costume('cat-c', 'cc'));
    const files = [{path: 'game/project.source.json', group: 'unstaged'}, {path: 'game/sb3-source.json', group: 'unstaged'},
        {path: 'game/assets/cc.svg', group: 'untracked'}];
    const list = organize(base(), after, files);
    assert.deepEqual(list.targets.map(entry => entry.name), ['Cat']);
    const [row] = target(list, 'Cat').elements;
    assert.equal(target(list, 'Cat').elements.length, 1);
    assert.equal(row.kind, 'costumes');
    assert.equal(row.status, 'added');
    assert.equal(row.name, 'cat-c');
    assert.deepEqual(row.md5ext, {before: undefined, after: 'cc.svg'});
    assert.deepEqual(row.files, [files[0], files[2]]);
    assert.deepEqual(list.other, [files[1]]);
    assert.deepEqual(list.project, []);
});

test('an asset shared by costumes of two sprites appears under each owner, with every Git group kept', () => {
    const before = base();
    before.targets[2].costumes.push(costume('shared', 'aa'));
    const files = [{path: 'game/assets/aa.svg', group: 'staged'}, {path: 'game/assets/aa.svg', group: 'unstaged'}];
    const list = organize(before, structuredClone(before), files);
    for (const [name, costumeName] of [['Cat', 'cat-a'], ['Dog', 'shared']]) {
        const rows = target(list, name).elements;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].name, costumeName);
        assert.equal(rows[0].status, 'updated');
        assert.deepEqual(rows[0].files, files);
    }
    assert.deepEqual(list.other, []);
});

test('unreferenced assets, the format file, extensions and README go to other', () => {
    const files = [{path: 'game/assets/zz.png', group: 'untracked'}, {path: 'game/sb3-source.json', group: 'staged'},
        {path: 'game/README.md', group: 'unstaged'}, {path: 'game/embedded-extensions.json', group: 'unstaged'},
        {path: 'game/extensions/foo.js', group: 'untracked'}];
    const list = organize(base(), base(), files);
    assert.deepEqual(list.targets, []);
    assert.deepEqual(list.other, files);
});

test('added and removed sprites; the stage first, then sprites in project order, then removed ones', () => {
    const before = base();
    const after = base();
    after.targets.splice(2, 1);
    after.targets.splice(1, 0, {isStage: false, name: 'Bird', blocks: {go: {opcode: 'event_whenflagclicked', topLevel: true}},
        costumes: [costume('bird', 'ee')], sounds: [sound('tweet', 'tt')], x: 1, y: 2});
    after.targets[0].tempo = 90;
    after.targets[2].x = 5;
    const files = [{path: 'game/project.source.json', group: 'unstaged'}, {path: 'game/assets/ee.svg', group: 'untracked'},
        {path: 'game/assets/dd.svg', group: 'unstaged'}];
    const list = organize(before, after, files);
    assert.deepEqual(list.targets.map(entry => [entry.name, entry.status]),
        [['Stage', 'updated'], ['Bird', 'added'], ['Cat', 'updated'], ['Dog', 'removed']]);
    assert.equal(list.targets[0].isStage, true);
    const bird = target(list, 'Bird');
    assert.deepEqual(bird.elements.map(row => [row.kind, row.status, row.name]),
        [['code', 'added', undefined], ['costumes', 'added', 'bird'], ['sounds', 'added', 'tweet']]);
    assert.equal(bird.elements[0].scripts, 1);
    assert.deepEqual(bird.elements[1].files, [files[0], files[1]]);
    const dog = target(list, 'Dog');
    assert.deepEqual(dog.elements.map(row => [row.kind, row.status, row.name]), [['costumes', 'removed', 'dog']]);
    assert.deepEqual(dog.elements[0].files, [files[0], files[2]]);
    assert.deepEqual(dog.elements[0].md5ext, {before: 'dd.svg', after: undefined});
    assert.deepEqual(list.other, []);
    assert.equal(new Set(list.targets.flatMap(entry => entry.elements.map(row => row.key))).size,
        list.targets.flatMap(entry => entry.elements).length);
});

test('elements follow code, costumes, sounds, data, settings; costumes keep their order with removed ones last', () => {
    const after = base();
    const cat = after.targets[1];
    cat.blocks = {say: {opcode: 'looks_say', topLevel: true}};
    cat.costumes = [costume('cat-new', 'nn'), costume('cat-b', 'b2')];
    cat.sounds[0].rate = 44100;
    cat.variables = {v: ['score', 0]};
    cat.broadcasts = {b: 'go'};
    cat.x = 40;
    cat.visible = false;
    cat.layerOrder = 2;
    const files = [{path: 'game/project.source.json', group: 'staged'}];
    const list = organize(base(), after, files);
    const rows = target(list, 'Cat').elements;
    assert.deepEqual(rows.map(row => [row.kind, row.status, row.name ?? '']), [
        ['code', 'updated', ''], ['costumes', 'added', 'cat-new'], ['costumes', 'updated', 'cat-b'], ['costumes', 'removed', 'cat-a'],
        ['sounds', 'updated', 'Meow'], ['data', 'updated', ''], ['settings', 'updated', '']
    ]);
    assert.deepEqual(rows[5].properties, ['variables', 'broadcasts']);
    assert.deepEqual(rows[6].properties, ['x', 'visible', 'layerOrder']);
    assert.deepEqual(rows[6].files, files);
    assert.deepEqual(list.other, []);
});

test('project-level keys become their own rows', () => {
    const after = base();
    after.monitors = [{id: 'm', visible: true}];
    after.extensions = ['pen'];
    after.extra = 1;
    const list = organize(base(), after, [{path: 'project.source.json', group: 'commit'}], '');
    assert.deepEqual(list.targets, []);
    assert.deepEqual(list.project.map(row => [row.kind, row.status, row.properties]),
        [['settings', 'updated', ['monitors']], ['settings', 'updated', ['extensions']], ['settings', 'added', ['extra']]]);
    assert.deepEqual(list.project[0].files, [{path: 'project.source.json', group: 'commit'}]);
    assert.deepEqual(list.other, []);
});

test('a project file whose data did not change (key order, formatting) goes to other', () => {
    const after = base();
    after.targets[1] = Object.fromEntries(Object.entries(after.targets[1]).reverse());
    const files = [{path: 'game/project.source.json', group: 'unstaged'}];
    const list = organize(base(), after, files);
    assert.deepEqual(list.targets, []);
    assert.deepEqual(list.project, []);
    assert.deepEqual(list.other, files);
});

test('a new project lists every target as added, with assets under a custom directory', () => {
    const files = [{path: 'game/project.source.json', group: 'untracked'}, {path: 'game/media/bd.svg', group: 'untracked'},
        {path: 'game/media/aa.svg', group: 'untracked'}, {path: 'game/sb3-source.json', group: 'untracked'}];
    const list = organize(null, base(), files, 'game', {before: 'assets', after: 'media'});
    assert.deepEqual(list.targets.map(entry => [entry.name, entry.status]), [['Stage', 'added'], ['Cat', 'added'], ['Dog', 'added']]);
    assert.ok(list.targets.every(entry => entry.elements.every(row => row.status === 'added' && row.kind !== 'settings' && row.kind !== 'data')));
    assert.deepEqual(target(list, 'Stage').elements[0].files, [files[0], files[1]]);
    assert.deepEqual(list.project.map(row => [row.status, row.properties[0]]), [['added', 'monitors'], ['added', 'extensions'], ['added', 'meta']]);
    assert.deepEqual(list.other, [files[3]]);
});

test('commit-group files and a costume addressed by assetId and dataFormat', () => {
    const before = base();
    delete before.targets[1].costumes[1].md5ext;
    const after = structuredClone(before);
    after.targets[1].costumes[1].assetId = 'b3';
    const files = [{path: 'game/project.source.json', group: 'commit'}, {path: 'game/assets/b3.svg', group: 'commit'},
        {path: 'game/assets/bb.svg', group: 'commit'}];
    const [row] = target(organize(before, after, files), 'Cat').elements;
    assert.equal(row.name, 'cat-b');
    assert.deepEqual(row.md5ext, {before: 'bb.svg', after: 'b3.svg'});
    assert.deepEqual(row.files, [files[0], files[1], files[2]]);
});

test('property labels in Japanese and English', () => {
    assert.equal(projectPropertyLabel('variables', 'ja'), '変数');
    assert.equal(projectPropertyLabel('rotationStyle', 'en'), 'Rotation style');
    assert.equal(projectPropertyLabel('monitors', 'ja-JP'), 'モニター');
    assert.equal(projectPropertyLabel('custom', 'ja'), 'custom');
});
