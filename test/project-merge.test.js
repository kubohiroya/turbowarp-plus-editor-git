import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {
    checkProject, formatProjectSource, mergeJson, mergeProjectFolder, mergeProjectSource, mergeText, renderText,
    resolveProjectFolder, resolveProjectSource
} from '@kubohiroya/turbowarp-plus-editor-git/project-merge';

const block = (opcode, fields = {}) => ({opcode, next: null, parent: null, inputs: {}, fields, shadow: false, topLevel: false});
const costume = (name, assetId) => ({name, bitmapResolution: 1, dataFormat: 'svg', assetId, md5ext: `${assetId}.svg`,
    rotationCenterX: 0, rotationCenterY: 0});

/** Green flag → move 10 → say "hi", and key press → turn 15, with IDs prefixed by `p`. */
function scripts(p) {
    return {
        [`${p}flag`]: {...block('event_whenflagclicked'), next: `${p}move`, topLevel: true, x: 0, y: 0},
        [`${p}move`]: {...block('motion_movesteps'), parent: `${p}flag`, next: `${p}say`, inputs: {STEPS: [1, [4, '10']]}},
        [`${p}say`]: {...block('looks_say'), parent: `${p}move`, inputs: {MESSAGE: [1, [10, 'hi']]}},
        [`${p}key`]: {...block('event_whenkeypressed'), next: `${p}turn`, topLevel: true, x: 0, y: 200,
            fields: {KEY_OPTION: ['space', null]}},
        [`${p}turn`]: {...block('motion_turnright'), parent: `${p}key`, inputs: {DEGREES: [1, [4, '15']]}}
    };
}

function sprite(name, prefix, layerOrder) {
    return {isStage: false, name, variables: {}, lists: {}, broadcasts: {}, blocks: scripts(prefix), comments: {},
        currentCostume: 0, costumes: [costume('look1', `${prefix}a1`)], sounds: [], volume: 100, layerOrder,
        visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around'};
}

function project() {
    return {
        targets: [
            {isStage: true, name: 'Stage', variables: {score: ['score', 0]}, lists: {items: ['items', []]}, broadcasts: {},
                blocks: {}, comments: {}, currentCostume: 0, costumes: [costume('backdrop1', 'bg1')], sounds: [], volume: 100,
                layerOrder: 0, tempo: 60},
            sprite('Cat', 'c', 1),
            sprite('Dog', 'd', 2)
        ],
        monitors: [],
        extensions: [],
        meta: {semver: '3.0.0', vm: '0.2.0', agent: ''}
    };
}

const cat = p => p.targets.find(target => target.name === 'Cat');
const dog = p => p.targets.find(target => target.name === 'Dog');
const variants = edit => {
    const value = structuredClone(project());
    edit(value);
    return value;
};

test('edits to different sprites and to different scripts of one sprite merge without conflicts', () => {
    const base = project();
    const current = variants(p => {
        cat(p).blocks.cmove.inputs.STEPS = [1, [4, '25']];
    });
    const incoming = variants(p => {
        dog(p).blocks.dsay.inputs.MESSAGE = [1, [10, 'woof']];
        cat(p).blocks.cturn.inputs.DEGREES = [1, [4, '90']];
    });
    const result = mergeProjectSource(base, current, incoming);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(cat(result.project).blocks.cmove.inputs.STEPS, [1, [4, '25']]);
    assert.deepEqual(cat(result.project).blocks.cturn.inputs.DEGREES, [1, [4, '90']]);
    assert.deepEqual(dog(result.project).blocks.dsay.inputs.MESSAGE, [1, [10, 'woof']]);
});

test('different inputs of one script merge block by block, and new blocks on both sides join the result', () => {
    const current = variants(p => {
        cat(p).blocks.cmove.inputs.STEPS = [1, [4, '25']];
    });
    const incoming = variants(p => {
        cat(p).blocks.csay.inputs.MESSAGE = [1, [10, 'meow']];
        // A new script on the incoming side.
        cat(p).blocks.cnew = {...block('event_whenthisspriteclicked'), topLevel: true, x: 300, y: 0};
    });
    const result = mergeProjectSource(project(), current, incoming);
    assert.deepEqual(result.conflicts, []);
    const blocks = cat(result.project).blocks;
    assert.deepEqual([blocks.cmove.inputs.STEPS, blocks.csay.inputs.MESSAGE], [[1, [4, '25']], [1, [10, 'meow']]]);
    assert.ok(blocks.cnew);
    assert.deepEqual(checkProject(result.project), []);
});

test('the same input changed differently is a script conflict that keeps the base until a side is chosen', () => {
    const current = variants(p => {
        cat(p).blocks.cmove.inputs.STEPS = [1, [4, '25']];
    });
    const incoming = variants(p => {
        cat(p).blocks.cmove.inputs.STEPS = [1, [4, '50']];
    });
    const result = mergeProjectSource(project(), current, incoming);
    assert.equal(result.conflicts.length, 1);
    const [conflict] = result.conflicts;
    assert.equal(conflict.kind, 'scripts');
    assert.deepEqual(conflict.location, {type: 'scripts', target: 'Cat', blockIds: ['cflag', 'cmove', 'csay']});
    assert.deepEqual(cat(result.project).blocks.cmove.inputs.STEPS, [1, [4, '10']]);
    for (const [side, steps] of [['current', '25'], ['incoming', '50'], ['base', '10']]) {
        const resolved = resolveProjectSource(result, {[conflict.id]: side});
        assert.deepEqual(cat(resolved.project).blocks.cmove.inputs.STEPS, [1, [4, steps]]);
        assert.deepEqual(resolved.problems, []);
    }
});

test('both sides appending different blocks after the same block conflict, and either choice is a consistent script', () => {
    const append = (id, opcode) => p => {
        const blocks = cat(p).blocks;
        blocks.csay.next = id;
        blocks[id] = {...block(opcode), parent: 'csay'};
    };
    const result = mergeProjectSource(project(), variants(append('cx', 'looks_show')), variants(append('cy', 'looks_hide')));
    assert.equal(result.conflicts.length, 1);
    assert.deepEqual(result.conflicts[0].location.blockIds, ['cflag', 'cmove', 'csay', 'cx', 'cy']);
    for (const side of ['current', 'incoming']) {
        const resolved = resolveProjectSource(result, {[result.conflicts[0].id]: side});
        assert.deepEqual(resolved.problems, []);
        assert.equal(Object.keys(cat(resolved.project).blocks).filter(id => id === 'cx' || id === 'cy').length, 1);
    }
});

test('a script removed on one side and changed on the other is a conflict', () => {
    const current = variants(p => {
        delete cat(p).blocks.ckey;
        delete cat(p).blocks.cturn;
    });
    const incoming = variants(p => {
        cat(p).blocks.cturn.inputs.DEGREES = [1, [4, '45']];
    });
    const result = mergeProjectSource(project(), current, incoming);
    assert.equal(result.conflicts.length, 1);
    assert.deepEqual(Object.keys(result.conflicts[0].current), []);
    assert.ok(cat(result.project).blocks.ckey, 'the base script stays until a side is chosen');
    const removed = resolveProjectSource(result, {[result.conflicts[0].id]: 'current'});
    assert.equal(cat(removed.project).blocks.ckey, undefined);
    assert.deepEqual(removed.problems, []);
});

test('a variable removed on one side but used by a new block on the other is kept and reported', () => {
    const current = variants(p => {
        delete p.targets[0].variables.score;
    });
    const incoming = variants(p => {
        const blocks = cat(p).blocks;
        blocks.csay.next = 'cset';
        blocks.cset = {...block('data_setvariableto'), parent: 'csay', inputs: {VALUE: [1, [10, '1']]},
            fields: {VARIABLE: ['score', 'score']}};
    });
    const result = mergeProjectSource(project(), current, incoming);
    assert.deepEqual(result.conflicts.map(conflict => [conflict.kind, conflict.location]),
        [['reference', {type: 'property', target: 'Stage', path: ['variables', 'score']}]]);
    assert.deepEqual(result.project.targets[0].variables.score, ['score', 0]);
    assert.deepEqual(result.problems, []);
    const removed = resolveProjectSource(result, {[result.conflicts[0].id]: 'current'});
    assert.deepEqual(removed.problems, [{target: 'Cat', kind: 'missing-variable', id: 'score'}]);
});

test('a rename and a new value of one variable merge separately', () => {
    const current = variants(p => {
        p.targets[0].variables.score = ['points', 0];
    });
    const incoming = variants(p => {
        p.targets[0].variables.score = ['score', 42];
    });
    const result = mergeProjectSource(project(), current, incoming);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.project.targets[0].variables.score, ['points', 42]);
});

test('costumes added on both sides join, and the costume shown follows its name', () => {
    const current = variants(p => {
        cat(p).costumes.unshift(costume('look0', 'new0'));
        // Still look1, now at index 1.
        cat(p).currentCostume = 1;
    });
    const incoming = variants(p => {
        cat(p).costumes.push(costume('look2', 'new2'));
        cat(p).currentCostume = 1;
    });
    const result = mergeProjectSource(project(), current, incoming);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(cat(result.project).costumes.map(item => item.name), ['look0', 'look1', 'look2']);
    assert.equal(cat(result.project).currentCostume, 2, 'look2, chosen on the incoming side');

    const switched = variants(p => {
        cat(p).costumes.unshift(costume('look0', 'new0'));
        cat(p).currentCostume = 0;
    });
    const both = mergeProjectSource(project(), switched, incoming);
    assert.deepEqual(both.conflicts.map(conflict => [conflict.base, conflict.current, conflict.incoming]),
        [['look1', 'look0', 'look2']]);
    assert.equal(cat(both.project).currentCostume, 1, 'the base costume look1');
    assert.equal(cat(resolveProjectSource(both, {[both.conflicts[0].id]: 'incoming'}).project).currentCostume, 2);
    assert.equal(cat(resolveProjectSource(both, {[both.conflicts[0].id]: 'current'}).project).currentCostume, 0);
});

test('a sprite renamed on one side and edited on the other keeps both changes', () => {
    const current = variants(p => {
        cat(p).name = 'Kitten';
    });
    const incoming = variants(p => {
        cat(p).blocks.cmove.inputs.STEPS = [1, [4, '25']];
    });
    const result = mergeProjectSource(project(), current, incoming);
    assert.deepEqual(result.conflicts, []);
    const kitten = result.project.targets.find(target => target.name === 'Kitten');
    assert.deepEqual(kitten.blocks.cmove.inputs.STEPS, [1, [4, '25']]);
    assert.equal(result.project.targets.length, 3);
});

test('a sprite removed on one side and changed on the other is a conflict; sprites added on both sides join', () => {
    const current = variants(p => {
        p.targets = p.targets.filter(target => target.name !== 'Dog');
        p.targets.push(sprite('Bird', 'b', 2));
    });
    const incoming = variants(p => {
        dog(p).x = 50;
        p.targets.push(sprite('Fish', 'f', 3));
    });
    const result = mergeProjectSource(project(), current, incoming);
    assert.deepEqual(result.conflicts.map(conflict => [conflict.kind, conflict.location]),
        [['removed-changed', {type: 'target', target: 'Dog'}]]);
    // Incoming additions follow their predecessor on the incoming side.
    assert.deepEqual(result.project.targets.map(target => target.name), ['Stage', 'Cat', 'Dog', 'Fish', 'Bird']);
    const layers = result.project.targets.map(target => target.layerOrder);
    assert.equal(new Set(layers).size, layers.length, 'layers stay distinct');
    const removed = resolveProjectSource(result, {[result.conflicts[0].id]: 'current'});
    assert.deepEqual(removed.project.targets.map(target => target.name), ['Stage', 'Cat', 'Fish', 'Bird']);
});

test('the merge is deterministic and formats like the toolchain', () => {
    const current = variants(p => {
        cat(p).blocks.cmove.inputs.STEPS = [1, [4, '25']];
    });
    const incoming = variants(p => {
        dog(p).blocks.dsay.inputs.MESSAGE = [1, [10, 'woof']];
    });
    const first = formatProjectSource(mergeProjectSource(project(), current, incoming).project);
    const second = formatProjectSource(mergeProjectSource(project(), current, incoming).project);
    assert.equal(first, second);
    assert.ok(first.endsWith('}\n') && first.includes('\n  "targets": ['));
    // Key order follows the current side.
    assert.deepEqual(Object.keys(JSON.parse(first)), Object.keys(current));
});

test('JSON merges key by key and conflicts keep the base', () => {
    const merged = mergeJson({a: 1, b: {c: 1, d: 1}}, {a: 2, b: {c: 2, d: 1}}, {a: 1, b: {c: 3, d: 4}, e: 5});
    assert.deepEqual(merged.value, {a: 2, b: {c: 1, d: 4}, e: 5});
    assert.deepEqual(merged.conflicts, [{path: ['b', 'c'], base: 1, current: 2, incoming: 3}]);
});

function mergeFileWithGit(t, base, current, incoming) {
    const directory = mkdtempSync(path.join(tmpdir(), 'tw-merge-file-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const files = ['current', 'base', 'incoming'].map(name => path.join(directory, name));
    writeFileSync(files[0], current);
    writeFileSync(files[1], base);
    writeFileSync(files[2], incoming);
    const run = spawnSync('git', ['merge-file', '-p', ...files], {encoding: 'utf8'});
    return {text: run.stdout, conflicts: run.status};
}

test('text merges like git merge-file', t => {
    const base = 'one\ntwo\nthree\nfour\nfive\n';
    const cases = [
        ['ONE\ntwo\nthree\nfour\nfive\n', 'one\ntwo\nthree\nfour\nFIVE\n'],
        ['one\ntwo\nthree\nfour\nfive\nsix\n', 'zero\none\ntwo\nthree\nfour\nfive\n'],
        ['one\nthree\nfour\nfive\n', 'one\ntwo\nthree\nfour\nfive\n'],
        ['one\ntwo\nTHREE\nfour\nfive\n', 'one\ntwo\nTHREE\nfour\nfive\n'],
        ['one\ntwo\nthree\nfour\nfive', 'one\nTWO\nthree\nfour\nfive\n']
    ];
    for (const [current, incoming] of cases) {
        const git = mergeFileWithGit(t, base, current, incoming);
        const merged = mergeText(base, current, incoming);
        assert.equal(git.conflicts, 0);
        assert.equal(merged.conflicts, 0);
        assert.equal(merged.text, git.text);
    }
    const git = mergeFileWithGit(t, base, 'one\n2\nthree\nfour\nfive\n', 'one\nTWO\nthree\nfour\nfive\n');
    const merged = mergeText(base, 'one\n2\nthree\nfour\nfive\n', 'one\nTWO\nthree\nfour\nfive\n');
    assert.equal(git.conflicts, 1);
    assert.equal(merged.conflicts, 1);
    assert.equal(merged.text, base, 'the conflict keeps the base lines and no markers');
    assert.equal(renderText(merged.chunks, ['incoming']), 'one\nTWO\nthree\nfour\nfive\n');
});

const encode = value => new TextEncoder().encode(typeof value === 'string' ? value : formatProjectSource(value));
const decode = bytes => bytes === null ? null : new TextDecoder().decode(bytes);
const manifest = assets => `${JSON.stringify({formatVersion: 1, project: 'project.source.json',
    embeddedExtensions: 'embedded-extensions.json', assetsDirectory: 'assets', archiveEntries: ['project.json', ...assets]},
null, 2)}\n`;

function folder(projectValue, extra = {}) {
    const files = {'project.source.json': projectValue,
        'embedded-extensions.json': '{\n  "formatVersion": 1,\n  "extensions": []\n}\n', ...extra};
    for (const name of projectAssets(projectValue)) files[`assets/${name}`] ??= `<svg id="${name}"/>`;
    files['sb3-source.json'] = manifest(Object.keys(files).filter(file => file.startsWith('assets/'))
        .map(file => file.slice('assets/'.length)));
    return files;
}

function projectAssets(value) {
    return value.targets.flatMap(target => [...target.costumes, ...target.sounds].map(asset => asset.md5ext));
}

function versions(base, current, incoming) {
    const paths = new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(incoming)]);
    return new Map([...paths].map(file => [file, {
        base: file in base ? encode(base[file]) : null,
        current: file in current ? encode(current[file]) : null,
        incoming: file in incoming ? encode(incoming[file]) : null
    }]));
}

test('assets follow the merged project, and a removed costume takes its file away only when unused', () => {
    const base = folder(project());
    const current = folder(variants(p => {
        cat(p).costumes.push(costume('look2', 'new2'));
    }));
    const incoming = folder(variants(p => {
        dog(p).costumes = [costume('bark', 'bark')];
    }));
    const result = mergeProjectFolder(versions(base, current, incoming));
    assert.deepEqual(result.conflicts, []);
    const resolved = resolveProjectFolder(result, {});
    const assets = [...resolved.files].filter(([file, bytes]) => file.startsWith('assets/') && bytes).map(([file]) => file).sort();
    assert.deepEqual(assets, ['assets/bark.svg', 'assets/bg1.svg', 'assets/ca1.svg', 'assets/new2.svg']);
    assert.equal(resolved.files.get('assets/da1.svg'), null);
    assert.deepEqual(resolved.problems, []);
    const entries = JSON.parse(decode(resolved.files.get('sb3-source.json'))).archiveEntries;
    assert.deepEqual(entries, ['project.json', 'bg1.svg', 'ca1.svg', 'bark.svg', 'new2.svg'],
        'archiveEntries lists exactly the final assets, in the sides\' order');
});

test('a project folder merges like git merge for the files other than the project', t => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tw-merge-folder-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const git = (...args) => execFileSync('git', args, {cwd: directory, encoding: 'utf8', env: {...process.env,
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.test'}});
    const write = files => {
        for (const file of git('ls-files').split('\n').filter(Boolean)) rmSync(path.join(directory, file));
        for (const [file, content] of Object.entries(files)) {
            mkdirSync(path.dirname(path.join(directory, file)), {recursive: true});
            writeFileSync(path.join(directory, file), encode(content));
        }
        git('add', '-A');
    };
    const extension = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
    const base = folder(project(), {'extensions/tool.js': extension, 'notes.txt': 'notes\n'});
    const current = folder(variants(p => {
        cat(p).blocks.cmove.inputs.STEPS = [1, [4, '25']];
    }), {'extensions/tool.js': extension.replace('line 1', 'LINE 1'), 'notes.txt': 'notes\n', 'added-current.txt': 'c\n'});
    const incoming = folder(variants(p => {
        dog(p).blocks.dsay.inputs.MESSAGE = [1, [10, 'woof']];
    }), {'extensions/tool.js': extension.replace('line 5', 'LINE 5'), 'added-incoming.txt': 'i\n'});
    git('init', '-q', '-b', 'main');
    write(base); git('commit', '-qm', 'base');
    git('switch', '-qc', 'incoming');
    write(incoming); git('commit', '-qm', 'incoming');
    git('switch', '-q', 'main');
    write(current); git('commit', '-qm', 'current');
    // Git merges project.source.json line by line too here, since the edits are far apart.
    git('merge', '-q', '--no-edit', 'incoming');
    const result = mergeProjectFolder(versions(base, current, incoming));
    assert.deepEqual(result.conflicts, []);
    const resolved = resolveProjectFolder(result, {});
    const gitFiles = git('ls-files').split('\n').filter(Boolean).sort();
    const ours = [...resolved.files].filter(([, bytes]) => bytes !== null).map(([file]) => file).sort();
    assert.deepEqual(ours, gitFiles);
    for (const file of gitFiles) {
        const expected = readFileSync(path.join(directory, file), 'utf8');
        if (file === 'project.source.json') assert.deepEqual(JSON.parse(decode(resolved.files.get(file))), JSON.parse(expected));
        else assert.equal(decode(resolved.files.get(file)), expected, file);
    }
});

test('a file removed on one side and changed on the other is a whole-file conflict', () => {
    const base = folder(project(), {'notes.txt': 'a\n'});
    const current = folder(project(), {});
    const incoming = folder(project(), {'notes.txt': 'b\n'});
    const result = mergeProjectFolder(versions(base, current, incoming));
    assert.deepEqual(result.conflicts.map(conflict => [conflict.id, conflict.type]), [['notes.txt#file', 'file']]);
    assert.equal(decode(resolveProjectFolder(result, {}).files.get('notes.txt')), 'a\n');
    assert.equal(resolveProjectFolder(result, {'notes.txt#file': 'current'}).files.get('notes.txt'), null);
    assert.deepEqual(resolveProjectFolder(result, {'notes.txt#file': 'current'}).unresolved, []);
});

test('the merged folder builds into an SB3 with sb3-toolchain', async t => {
    const {buildSb3} = await import('@kubohiroya/sb3-toolchain');
    const {validateSourceFiles} = await import('@kubohiroya/sb3-toolchain/browser');
    const {createHash} = await import('node:crypto');
    const svg = name => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" id="${name}"/>`;
    const real = name => {
        const assetId = createHash('md5').update(svg(name)).digest('hex');
        return {item: costume(name, assetId), file: [`assets/${assetId}.svg`, svg(name)]};
    };
    const withRealAssets = edit => {
        const value = variants(edit);
        const files = {};
        for (const target of value.targets) {
            target.costumes = target.costumes.map(item => {
                const asset = real(item.name + target.name);
                files[asset.file[0]] = asset.file[1];
                return {...asset.item, name: item.name};
            });
        }
        return folder(value, files);
    };
    const base = withRealAssets(() => {});
    const current = withRealAssets(p => {
        cat(p).blocks.cmove.inputs.STEPS = [1, [4, '25']];
        cat(p).costumes.push({name: 'extra'});
    });
    const incoming = withRealAssets(p => {
        cat(p).blocks.cmove.inputs.STEPS = [1, [4, '50']];
        dog(p).blocks.dsay.inputs.MESSAGE = [1, [10, 'woof']];
    });
    const result = mergeProjectFolder(versions(base, current, incoming));
    assert.equal(result.conflicts.length, 1);
    const resolved = resolveProjectFolder(result, {[result.conflicts[0].id]: 'incoming'});
    assert.deepEqual(resolved.problems, []);
    const files = new Map([...resolved.files].filter(([, bytes]) => bytes !== null));
    validateSourceFiles(files);
    const directory = mkdtempSync(path.join(tmpdir(), 'tw-merge-build-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    for (const [file, bytes] of files) {
        mkdirSync(path.dirname(path.join(directory, 'source', file)), {recursive: true});
        writeFileSync(path.join(directory, 'source', file), bytes);
    }
    const built = await buildSb3({sourceDirectory: path.join(directory, 'source'), outputPath: path.join(directory, 'out.sb3'),
        yes: true});
    assert.ok(readFileSync(path.join(directory, 'out.sb3')).length > 0);
    void built;
});
