import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import React from 'react';
import ReactDOMServer from 'react-dom/server.js';
import {createTwoFilesPatch} from 'diff';
import {createProjectSourceDiff, ProjectSourceBlockDiff, createScratchBlocksDiffLocator, ProjectSourceReview} from '@kubohiroya/turbowarp-plus-editor-git/project-source-diff';

const project = {
    targets: [
        {isStage: true, name: 'Stage', blocks: {}},
        {isStage: false, name: 'Cat', blocks: {
            flag: {opcode: 'event_whenflagclicked', next: 'move'},
            move: {opcode: 'motion_movesteps', inputs: {STEPS: [1, [4, '10']]}},
            say: {opcode: 'looks_say', inputs: {MESSAGE: [1, [10, 'hello']]}}
        }}
    ],
    padding: Array.from({length: 20}, (_, index) => index)
};
const updated = structuredClone(project);
updated.targets[1].blocks.move.inputs.STEPS[1][1] = '25';
delete updated.targets[1].blocks.say;
updated.targets[1].blocks.turn = {opcode: 'motion_turnright', inputs: {DEGREES: [1, [4, '15']]}};

const before = JSON.stringify(project, null, 2).replace(/\n/g, '\r\n') + '\r\n';
const after = JSON.stringify(updated, null, 2).replace(/\n/g, '\r\n');
const view = (patch, beforeSource) => ReactDOMServer.renderToStaticMarkup(React.createElement(ProjectSourceBlockDiff, {
    patch, beforeSource, renderBlock: async () => {}
}));

test('the generated full-context patch is applicable by Git and the React view recovers both projects', t => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tw-source-diff-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const source = path.join(directory, 'project.source.json');
    const patch = createProjectSourceDiff(before, after);
    writeFileSync(source, before);
    execFileSync('git', ['apply', '--whitespace=nowarn', '-'], {cwd: directory, input: patch});
    assert.equal(readFileSync(source, 'utf8'), after);
    const html = view(patch);
    assert.match(html, /Block changes · 3/);
    assert.match(html, /1 unchanged blocks omitted/);
    assert.match(html, /twgit-block-diff-updated/);
    assert.match(html, /twgit-block-diff-removed/);
    assert.match(html, /twgit-block-diff-added/);
    assert.match(html, /Inputs/);
});

test('a compact patch needs its original source and invalid input receives an accessible error', () => {
    const compact = createTwoFilesPatch('a/project.source.json', 'b/project.source.json', before, after,
        undefined, undefined, {context: 1});
    assert.match(view(compact), /role="alert"/);
    assert.match(view(compact, before), /Block changes · 3/);
    assert.match(view(compact, '{}'), /role="alert"/);
    assert.match(view('invalid diff'), /role="alert"/);
    assert.throws(() => createProjectSourceDiff('{}', after), /project.source.json/);
});

test('JSON formatting and object key order do not create visual block changes', () => {
    const reordered = structuredClone(project);
    reordered.targets[1].blocks.move = {inputs: {STEPS: [1, [4, '10']]}, opcode: 'motion_movesteps'};
    assert.match(view(createProjectSourceDiff(before, JSON.stringify(reordered))), /No block changes/);
    assert.match(view(createProjectSourceDiff(before, before)), /No block changes/);
});

test('the input outline legend only appears for fields visible in the block', () => {
    const withReporter = structuredClone(project);
    withReporter.targets[1].blocks.move.inputs.STEPS = [3, 'reporter', [4, '10']];
    const changedShadow = structuredClone(withReporter);
    changedShadow.targets[1].blocks.move.inputs.STEPS[2][1] = '25';
    const source = value => JSON.stringify(value, null, 2);
    assert.doesNotMatch(view(createProjectSourceDiff(source(withReporter), source(changedShadow))), /Orange outlines/);
    assert.match(view(createProjectSourceDiff(before, after)), /Orange outlines/);
});

test('the locator centers a matching block and releases its markers when the request is cancelled', async () => {
    const root = {classList: new Set()}, input = {classList: new Set()};
    for (const node of [root, input]) node.classList.remove = name => node.classList.delete(name);
    const block = {
        type: 'motion_movesteps',
        getSvgRoot: () => root,
        getInputTargetBlock: name => name === 'STEPS' ? {getSvgRoot: () => input} : null
    };
    const centered = [];
    const locate = createScratchBlocksDiffLocator(async () => ({
        getBlockById: id => id === 'move' ? block : null,
        centerOnBlock: id => centered.push(id)
    }));
    const controller = new AbortController();
    const location = {
        target: updated.targets[1], id: 'move', version: 'after',
        parts: [{kind: 'input', name: 'STEPS'}], signal: controller.signal
    };
    assert.equal(await locate(location), true);
    assert.deepEqual(centered, ['move']);
    assert.ok(root.classList.has('twgit-changed-block'));
    assert.ok(input.classList.has('twgit-changed-block-part'));
    controller.abort();
    assert.equal(root.classList.size, 0);
    assert.equal(input.classList.size, 0);
    assert.equal(await locate(location), false);
    assert.equal(await locate({...location, signal: new AbortController().signal, id: 'say'}), false);
    assert.deepEqual(centered, ['move']);
});

const review = (base, head) => ReactDOMServer.renderToStaticMarkup(React.createElement(ProjectSourceReview, {
    title: 'Start the round together',
    description: 'Use one start signal for the stage and sprites.',
    verification: ['Check the start signal.'],
    files: [
        {path: 'game/project.source.json', patch: createProjectSourceDiff(JSON.stringify(base), JSON.stringify(head))},
        {path: 'game/assets/start.svg', status: 'updated'}
    ],
    renderBlock: async () => {}
}));

test('a review groups all edits to one script and includes related files and non-code changes', () => {
    const base = structuredClone(project);
    base.targets[1].blocks.move.parent = 'flag';
    const head = structuredClone(base);
    head.targets[1].blocks.move.inputs.STEPS[1][1] = '25';
    head.targets[1].blocks.move.next = 'wait';
    head.targets[1].blocks.wait = {opcode: 'control_wait', parent: 'move', inputs: {DURATION: [1, [5, '1']]}};
    head.targets[0].broadcasts = {start: 'Start'};
    const html = review(base, head);
    assert.match(html, /Start the round together/);
    assert.match(html, /Check the start signal/);
    assert.match(html, /game\/assets\/start.svg/);
    assert.match(html, /Changes outside the code · Broadcast messages/);
    assert.match(html, /Affected stages and sprites<\/dt><dd>2<\/dd>/);
    assert.match(html, /Script comparisons<\/dt><dd>1<\/dd>/);
    assert.equal((html.match(/class="twgit-review-script"/g) ?? []).length, 1);
    assert.match(html, /When green flag clicked/);
    assert.doesNotMatch(html, /Rendering script/);
});

test('a script split remains one review item spanning both versions', () => {
    const base = structuredClone(project);
    base.targets[1].blocks.move.parent = 'flag';
    const head = structuredClone(base);
    head.targets[1].blocks.flag.next = null;
    head.targets[1].blocks.move.parent = null;
    const html = review(base, head);
    assert.equal((html.match(/class="twgit-review-script"/g) ?? []).length, 1);
    assert.match(html, /Reorganized/);
    assert.match(html, /1 → 2/);
});
