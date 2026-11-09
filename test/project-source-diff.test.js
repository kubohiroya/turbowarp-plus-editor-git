import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import React from 'react';
import ReactDOMServer from 'react-dom/server.js';
import {createTwoFilesPatch} from 'diff';
import {createProjectSourceDiff, ProjectSourceBlockDiff, createScratchBlocksDiffLocator, ProjectSourceComparison, ProjectSourceReview,
    createPreviewSync, currentCostume} from '@kubohiroya/turbowarp-plus-editor-git/project-source-diff';
import {createEditorBlockLocator} from '../dist/index.js';

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

test('the Editor locator opens the matching sprite, waits for its block and outlines it until cancelled', async () => {
    const root = {classList: new Set()};
    root.classList.remove = name => root.classList.delete(name);
    const blocks = new Map();
    const centered = [], opened = [];
    const workspace = {getBlockById: id => blocks.get(id) ?? null, centerOnBlock: id => centered.push(id)};
    const sprite = (id, name, isOriginal) => ({id, isStage: false, isOriginal, getName: () => name});
    const vm = {
        runtime: {targets: [{id: 'stage', isStage: true, getName: () => 'Stage'}, sprite('clone', 'Cat', false), sprite('cat', 'Cat')]},
        editingTarget: {id: 'stage'}
    };
    let reads = 0, appearAfter = 0;
    const locate = createEditorBlockLocator({
        vm,
        openTargetCode: id => {opened.push(id); vm.editingTarget = {id};},
        // Like the Editor, the sprite's blocks appear some frames after its code is opened.
        getWorkspace: () => {
            if (++reads >= appearAfter) blocks.set('move', {type: 'motion_movesteps', getSvgRoot: () => root});
            return workspace;
        }
    });
    const location = {target: updated.targets[1], id: 'move', version: 'after', parts: []};

    const first = new AbortController();
    assert.equal(await locate({...location, signal: first.signal}), true);
    assert.deepEqual(opened, ['cat']);
    assert.deepEqual(centered, ['move']);
    assert.ok(root.classList.has('twgit-changed-block'));
    first.abort();
    assert.equal(root.classList.size, 0);

    blocks.clear();
    reads = 0;
    appearAfter = 4;
    assert.equal(await locate({...location, signal: new AbortController().signal}), true);
    assert.equal(reads, 4);
    assert.deepEqual(centered, ['move', 'move']);

    assert.equal(await locate({...location, target: {...updated.targets[1], name: 'Dog'}, signal: new AbortController().signal}), false);
    assert.deepEqual(opened, ['cat', 'cat']);

    // Cancelled while the Editor is still opening the code: no outline is left.
    root.classList.clear();
    blocks.clear();
    reads = 0;
    appearAfter = Infinity;
    const waiting = new AbortController();
    const pending = locate({...location, signal: waiting.signal});
    setTimeout(() => {
        blocks.set('move', {type: 'motion_movesteps', getSvgRoot: () => root});
        waiting.abort();
    }, 40);
    assert.equal(await pending, false);
    assert.equal(root.classList.size, 0);
    assert.deepEqual(centered, ['move', 'move']);
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
    assert.match(html, /Code changes<\/dt><dd>1<\/dd>/);
    assert.match(html, /Reviewed<\/dt><dd>0 \/ 1<\/dd>/);
    assert.equal((html.match(/class="twgit-review-script"/g) ?? []).length, 1);
    assert.match(html, /When green flag clicked/);
    assert.doesNotMatch(html, /Rendering code/);
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

test('linked previews share the zoom and height that fit both versions, and follow each other until unlinked', () => {
    const view = (scale, height) => {
        const calls = [];
        let current = {scale, x: 0, y: 0};
        const listeners = new Set();
        return {calls, fit: {scale, height},
            layout(fit) {calls.push(['layout', fit.scale, fit.height]); current = {scale: fit.scale, x: 16, y: 16};},
            viewport: () => current,
            setViewport(next) {calls.push(['viewport', next.scale, next.x, next.y]); current = next;},
            onChange(listener) {listeners.add(listener); return () => listeners.delete(listener);},
            move(next) {current = next; for (const listener of listeners) listener();}};
    };
    const sync = createPreviewSync();
    const before = view(0.675, 160), after = view(0.4, 300);
    sync.add(before);
    const leave = sync.add(after);
    assert.deepEqual(before.calls.at(-1), ['layout', 0.4, 300]);
    assert.deepEqual(after.calls.at(-1), ['layout', 0.4, 300]);
    after.move({scale: 0.8, x: -40, y: -90});
    assert.deepEqual(before.calls.at(-1), ['viewport', 0.8, -40, -90]);
    assert.equal(after.calls.filter(([kind]) => kind === 'viewport').length, 0);
    sync.setLinked(false);
    before.move({scale: 1, x: 0, y: 0});
    assert.deepEqual(after.calls.at(-1), ['layout', 0.4, 300]);
    sync.setLinked(true);
    assert.deepEqual(after.calls.at(-1), ['layout', 0.4, 300]);
    leave();
    before.move({scale: 0.5, x: 1, y: 2});
    assert.equal(after.calls.filter(([kind]) => kind === 'viewport').length, 0);
});

const comparison = (before, after, extra = {}) => ReactDOMServer.renderToStaticMarkup(React.createElement(ProjectSourceComparison, {
    before, after, renderBlock: async () => {}, ...extra
}));

test('a local comparison groups changed scripts by stage and sprite, as the review does', () => {
    const base = structuredClone(project);
    base.targets[1].blocks.move.parent = 'flag';
    const head = structuredClone(base);
    head.targets[1].blocks.move.inputs.STEPS[1][1] = '25';
    const html = comparison(JSON.stringify(base, null, 2), JSON.stringify(head));
    assert.match(html, /aria-label="Project changes"/);
    assert.match(html, /Affected stages and sprites<\/dt><dd>1<\/dd>/);
    assert.match(html, /Code changes<\/dt><dd>1<\/dd>/);
    assert.match(html, /<h5>Cat<small>Code changes · 1<\/small><\/h5>/);
    assert.equal((html.match(/class="twgit-review-script"/g) ?? []).length, 1);
    assert.match(html, /twgit-review-status">Changed<\/span><strong>When green flag clicked/);
    assert.doesNotMatch(html, /Reviewed/);
    assert.match(comparison(JSON.stringify(base), JSON.stringify(head), {locale: 'ja'}), /影響するステージ・スプライト/);
});

test('a comparison offers no "Highlight in Editor" without a locator', () => {
    const head = structuredClone(project);
    head.targets[1].blocks.move.inputs.STEPS[1][1] = '25';
    assert.doesNotMatch(comparison(JSON.stringify(project), JSON.stringify(head)), /Highlight in Editor/);
    assert.doesNotMatch(comparison(JSON.stringify(project), JSON.stringify(head), {locale: 'ja'}), /編集画面で強調/);
});

test('a project file added or removed as a whole lists every script on one side', () => {
    const source = JSON.stringify(project);
    const added = comparison(null, source);
    assert.equal((added.match(/twgit-review-status">Added</g) ?? []).length, 3);
    assert.doesNotMatch(added, /Removed/);
    const removed = comparison(source, null);
    assert.equal((removed.match(/twgit-review-status">Removed</g) ?? []).length, 3);
    assert.match(comparison(null, null), /No changes to the project contents/);
});

test('unreadable project data explains why and shows the fallback instead', () => {
    const fallback = React.createElement('pre', null, 'raw text diff');
    const html = comparison('{"targets": [', JSON.stringify(project), {fallback});
    assert.match(html, /role="alert"[^>]*>This file could not be read as project data/);
    assert.match(html, /<pre>raw text diff<\/pre>/);
    assert.doesNotMatch(html, /twgit-review-script/);
    assert.match(comparison('{}', JSON.stringify(project)), /role="alert">This project diff could not be read/);
});

// Visible text only: class names such as twgit-review-script are not part of the wording.
const visibleText = html => html.replace(/<[^>]*>/g, ' ');

test('the diff and review call blocks code, in Japanese and English', () => {
    const base = structuredClone(project);
    base.targets[1].blocks.move.parent = 'flag';
    const head = structuredClone(base);
    head.targets[1].blocks.move.inputs.STEPS[1][1] = '25';
    const source = value => JSON.stringify(value, null, 2);
    const patch = createProjectSourceDiff(source(base), source(head));
    const reviewOf = locale => ReactDOMServer.renderToStaticMarkup(React.createElement(ProjectSourceReview, {
        title: 'Move further', files: [{path: 'game/project.source.json', patch}], renderBlock: async () => {}, locale
    }));
    const ja = reviewOf('ja');
    assert.match(ja, /<h5>Cat<small>コードの変更 · 1 か所<\/small><\/h5>/);
    assert.match(ja, /コードの変更<\/dt><dd>1<\/dd>/);
    assert.match(ja, /確認済み<\/dt><dd>0 \/ 1<\/dd>/);
    assert.match(comparison(source(base), source(head), {locale: 'ja'}), /<h5>Cat<small>コードの変更 · 1 か所<\/small><\/h5>/);
    for (const html of [ja, reviewOf('en'), comparison(source(base), source(head), {locale: 'ja'}), comparison(source(base), source(head)),
        ReactDOMServer.renderToStaticMarkup(React.createElement(ProjectSourceBlockDiff, {patch, renderBlock: async () => {}, locale: 'ja'})),
        view(patch)]) {
        assert.doesNotMatch(visibleText(html), /スクリプト|script/i);
    }
    assert.match(view(patch), /Highlight in the surrounding code/);
    assert.match(ReactDOMServer.renderToStaticMarkup(React.createElement(ProjectSourceBlockDiff, {patch, renderBlock: async () => {}, locale: 'ja'})),
        /元のコード内で強調/);
});

test('stage and sprite headings show their names until a costume image is read', () => {
    const withCostumes = structuredClone(project);
    withCostumes.targets[0].costumes = [{name: 'backdrop1', assetId: 'a'.repeat(32), dataFormat: 'svg'}];
    withCostumes.targets[1].costumes = [{name: 'costume1', md5ext: 'b'.repeat(32) + '.svg'}, {name: 'costume2', md5ext: 'c'.repeat(32) + '.png'}];
    withCostumes.targets[1].blocks.move.parent = 'flag';
    const head = structuredClone(withCostumes);
    head.targets[1].blocks.move.inputs.STEPS[1][1] = '25';
    head.targets[1].currentCostume = 1;
    const requests = [];
    const loadAsset = async request => {requests.push(request); return new Blob(['<svg/>']);};
    // Server rendering runs no effects, so no asset is read and the heading is the name alone, as without a loader.
    const html = comparison(JSON.stringify(withCostumes), JSON.stringify(head), {loadAsset});
    assert.match(html, /<h5>Cat<small>Code changes · 1<\/small><\/h5>/);
    assert.doesNotMatch(html, /<img|twgit-review-thumbnails/);
    assert.deepEqual(requests, []);
    assert.equal(html, comparison(JSON.stringify(withCostumes), JSON.stringify(head)));
    // The thumbnails use the selected costume, and the stage's backdrop by its asset ID.
    assert.equal(currentCostume(withCostumes.targets[0]).md5ext, 'a'.repeat(32) + '.svg');
    assert.equal(currentCostume(withCostumes.targets[1]).md5ext, 'b'.repeat(32) + '.svg');
    assert.equal(currentCostume(head.targets[1]).md5ext, 'c'.repeat(32) + '.png');
    assert.equal(currentCostume({...head.targets[1], costumes: [{name: 'x', md5ext: '../x.svg'}], currentCostume: 0}), null);
});
