// Acceptance checks for kubohiroya/turbowarp-plus-editor#773 that the browser tests do not cover:
// edits that cannot resume, conflicts that must be settled before a playtest, reusing an adopted edit,
// and refusing to commit a generation with broken references.
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import path from 'node:path';
import {test} from 'node:test';
import {validateSourceFiles} from '@kubohiroya/sb3-toolchain/browser';
import ts from 'typescript';
import type {MergePlan, MergePlanFiles} from '../src/merge-plan.ts';
import type {PlaytestStop} from '../src/merge-playtest.ts';
import type {SourceProject} from '../src/project-source-merge.ts';
import {openRepository} from '../dist/repository.js';
import {directoryHandle} from './directory.js';
import {mergePlanFixture} from './merge-plan-fixture.js';

// These functions are internal to the package, so load them from the sources. The sources import the built `.js`
// names and use TypeScript syntax that Node cannot strip, so transpile them with the project's TypeScript.
const sources = new URL('../src/', import.meta.url).href;
registerHooks({
    resolve(specifier, context, next) {
        if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(sources)) {
            for (const extension of ['.ts', '.tsx']) {
                const url = new URL(specifier.slice(0, -3) + extension, context.parentURL);
                if (existsSync(url)) return {url: url.href, shortCircuit: true};
            }
        }
        return next(specifier, context);
    },
    load(url, context, next) {
        if (!url.startsWith(sources) || !/\.tsx?$/.test(url)) return next(url, context);
        const {outputText} = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {fileName: url, compilerOptions: {
            module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, verbatimModuleSyntax: true
        }});
        return {format: 'module', source: outputText, shortCircuit: true};
    }
});
const {createMergePlan, saveMergePlanProject} = await import('../src/merge-plan.ts');
const {mergePlaytestRequest, observePlaytest, resumeScriptEdit} = await import('../src/merge-playtest.ts');
const {formatProjectSource, parseSourceProject} = await import('../src/project-source-merge.ts');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Blocks = Record<string, Record<string, unknown>>;
const block = (opcode: string, next: string | null, parent: string | null, inputs: Record<string, unknown> = {}) => ({
    opcode, next, parent, inputs, fields: {}, shadow: false, topLevel: parent === null,
    ...(parent === null ? {x: 10, y: 10} : {})
});

/** Green flag → move 5 → move STEPS → turn, and space → move STEPS: two scripts that can conflict separately. */
function project(steps: number, options: {centerX?: number} = {}): SourceProject {
    const costume = (centerX = 12) => ({name: 'Circle', assetId: 'circle', dataFormat: 'svg', md5ext: 'circle.svg',
        rotationCenterX: centerX, rotationCenterY: 12});
    const state = {variables: {}, lists: {}, broadcasts: {}, comments: {}, sounds: [], currentCostume: 0, volume: 100};
    return {
        targets: [{...state, costumes: [costume()], isStage: true, name: 'Stage', blocks: {}}, {
            ...state, costumes: [costume(options.centerX)], isStage: false, name: 'Walker', x: 0, y: 0, visible: true,
            size: 100, direction: 90,
            rotationStyle: 'all around',
            blocks: {
                flag: block('event_whenflagclicked', 'advance', null),
                advance: block('motion_movesteps', 'move', 'flag', {STEPS: [1, [4, '5']]}),
                move: block('motion_movesteps', 'turn', 'advance', {STEPS: [1, [4, String(steps)]]}),
                turn: block('motion_turnright', null, 'move', {DEGREES: [1, [4, '15']]}),
                key: {...block('event_whenkeypressed', 'unvisited', null), y: 250, fields: {KEY_OPTION: ['space', null]}},
                unvisited: block('motion_movesteps', null, 'key', {STEPS: [1, [4, String(steps)]]})
            }
        }],
        monitors: [], extensions: [], meta: {semver: '3.0.0'}
    } as SourceProject;
}

const bytes = (value: string | SourceProject) => encoder.encode(typeof value === 'string' ? value : formatProjectSource(value));
const tip = (name: string, oid: string) => ({name, ref: 'refs/heads/' + name, oid});
const manifest = (note = 'base') => JSON.stringify({formatVersion: 1, project: 'project.source.json',
    embeddedExtensions: 'embedded-extensions.json', assetsDirectory: 'assets', archiveEntries: ['project.json'], note});

async function candidate(base: Record<string, string | SourceProject>, current: Record<string, string | SourceProject>,
    incoming: Record<string, string | SourceProject>) {
    // A candidate needs a manifest; give every side the same one unless the test changes it.
    for (const side of [base, current, incoming]) side['sb3-source.json'] ??= manifest();
    const paths = new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(incoming)]);
    const versions = new Map([...paths].map(file => [file, {
        base: file in base ? bytes(base[file]) : null,
        current: file in current ? bytes(current[file]) : null,
        incoming: file in incoming ? bytes(incoming[file]) : null
    }]));
    return createMergePlan('', {base: 'b'.repeat(40), current: tip('main', 'c'.repeat(40)),
        incoming: tip('incoming', 'd'.repeat(40))}, versions);
}

const thread = (topBlock: string) => ({topBlock, target: {getName: () => 'Walker'}});

test('a playtest pauses only at the conflicts it reaches, and reuses an adopted edit until it ends', async () => {
    const {plan, files, seed} = await candidate({'project.source.json': project(10)},
        {'project.source.json': project(35)}, {'project.source.json': project(30)});
    const request = mergePlaytestRequest(plan, files, seed);
    assert.deepEqual(request.blocking, []);
    assert.deepEqual(request.conflicts.map(({script, next, focus, input}) => ({script, next, focus, input})), [
        {script: 'flag', next: 'move', focus: 'move', input: 'STEPS'},
        {script: 'key', next: 'unvisited', focus: 'unvisited', input: 'STEPS'}
    ]);

    const stops: PlaytestStop[] = [];
    const playtest = observePlaytest(request.conflicts, stop => stops.push(stop));
    const flag = thread('flag');
    // The green flag script runs until the command whose input conflicts, and stops before it.
    assert.equal(playtest.before(flag, 'flag'), true);
    playtest.after(flag, 'flag');
    assert.equal(playtest.before(flag, 'advance'), true);
    playtest.after(flag, 'advance');
    assert.equal(playtest.before(flag, 'move'), false);
    assert.equal(playtest.paused, true);
    assert.deepEqual([stops[0].next, stops[0].previous], ['move', 'advance']);

    playtest.resume();
    assert.equal(playtest.paused, false);
    // Reaching the same conflict again in this playtest uses the adopted edit instead of pausing.
    assert.equal(playtest.before(flag, 'move'), true);
    assert.equal(playtest.before(thread('flag'), 'move'), true);
    // A conflict that was not reached yet still pauses.
    assert.equal(playtest.before(thread('key'), 'unvisited'), false);
    assert.equal(stops.length, 2);

    // A new playtest does not carry the adopted edit over.
    const replay = observePlaytest(request.conflicts, () => {});
    assert.equal(replay.before(thread('flag'), 'move'), false);
});

test('an edit made while paused resumes only when it keeps the paused point and the rest of the project', async () => {
    const {plan, files, seed} = await candidate({'project.source.json': project(10)},
        {'project.source.json': project(35)}, {'project.source.json': project(30)});
    const [stop] = mergePlaytestRequest(plan, files, seed).conflicts;
    const before = decoder.decode(files.get('project.source.json'));
    const edit = (change: (blocks: Blocks, target: Record<string, unknown>) => void) => {
        const edited = parseSourceProject(before)!;
        const walker = edited.targets[1] as Record<string, unknown>;
        change(walker.blocks as Blocks, walker);
        return formatProjectSource(edited);
    };

    // A value neither side had, at the paused block, can resume.
    const accepted = resumeScriptEdit(before, edit(blocks => {
        blocks.move.inputs = {STEPS: [1, [4, '42']]};
    }), stop);
    assert.ok(accepted);
    assert.deepEqual([...accepted.changedIds], ['move']);

    const rejected: Array<[string, (blocks: Blocks, target: Record<string, unknown>) => void]> = [
        ['removing the paused block', blocks => {
            delete blocks.move;
            blocks.advance.next = 'turn';
            blocks.turn.parent = 'advance';
        }],
        ['changing a block that already ran', blocks => {
            blocks.advance.inputs = {STEPS: [1, [4, '6']]};
        }],
        ['changing another script', blocks => {
            blocks.unvisited.inputs = {STEPS: [1, [4, '99']]};
        }],
        ['changing the variables', (_blocks, target) => {
            target.variables = {extra: ['Extra', 0]};
        }],
        ['using a variable that does not exist', blocks => {
            blocks.move.inputs = {STEPS: [3, [12, 'Ghost', 'ghost'], [4, '10']]};
        }]
    ];
    for (const [reason, change] of rejected) assert.equal(resumeScriptEdit(before, edit(change), stop), undefined, reason);
});

test('conflicts that a playtest cannot pause at are listed before it starts', async () => {
    const {plan, files, seed} = await candidate(
        {'notes.txt': 'notes\n', 'project.source.json': project(10)},
        {'notes.txt': 'current\n', 'project.source.json': project(35, {centerX: 1}), 'sb3-source.json': manifest('current')},
        {'notes.txt': 'incoming\n', 'project.source.json': project(30, {centerX: 2}), 'sb3-source.json': manifest('incoming')});
    const request = mergePlaytestRequest(plan, files, seed);
    // The costume and the manifest must be settled first; a text file outside the project data does not block.
    assert.deepEqual(request.blocking.sort(), ['Walker · costumes.Circle.rotationCenterX', 'sb3-source.json']);
    // The script conflicts can still be met during the playtest.
    assert.deepEqual(request.conflicts.map(({next}) => next), ['move', 'unvisited']);
    assert.ok(seed.conflicts.some(conflict => conflict.path === 'notes.txt'));
});

test('a generation whose saved project has a broken reference is not committed', async t => {
    const fixture = await mergePlanFixture(t);
    fixture.git('reset', '--hard');
    await rm(path.join(fixture.project, 'notes.txt'));
    const repository = await openRepository(directoryHandle(fixture.root,
        () => assert.fail('A generation with broken references attempted to write')));
    const built: {plan: MergePlan; files: MergePlanFiles} = await repository.planMerge(fixture.folder,
        {branch: 'main', head: fixture.head}, 'refs/remotes/origin/main');
    const broken = parseSourceProject(decoder.decode(built.files.get('project.source.json')))!;
    const blocks = broken.targets[1].blocks as Blocks;
    blocks.move.inputs = {STEPS: [3, [12, 'Ghost', 'ghost'], [4, '10']]};
    const saved = await saveMergePlanProject(built.plan, built.files, broken);
    assert.equal(saved.plan.problems, 1);
    const before = await fixture.snapshot();
    await assert.rejects(repository.prepareMergeCommit(saved.plan, saved.files, validateSourceFiles), {code: 'mergeCommitInvalid'});
    await assert.rejects(repository.localOperation({kind: 'finalizeMergePlan', plan: saved.plan, files: saved.files,
        message: 'Merge a broken generation', validate: validateSourceFiles}, () => {}), {code: 'mergeCommitInvalid'});
    assert.deepEqual(await fixture.snapshot(), before);
});
