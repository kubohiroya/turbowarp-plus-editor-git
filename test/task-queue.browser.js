import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chromium} from '@playwright/test';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';

test('a new tab resumes an IndexedDB job for the same directory', async t => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'twgit-queue-browser-'));
    t.after(() => fs.rm(fixture, {recursive: true, force: true}));
    const git = (...args) => execFileSync('git', args, {cwd: fixture});
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Browser fixture');
    git('config', 'user.email', 'queue@example.invalid');
    await fs.writeFile(path.join(fixture, 'project.source.json'), '{"targets":[]}\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    const entries = await fs.readdir(fixture, {recursive: true, withFileTypes: true});
    const files = await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
        const filename = path.join(entry.parentPath, entry.name);
        return [path.relative(fixture, filename).split(path.sep), [...await fs.readFile(filename)]];
    }));
    const dist = fileURLToPath(new URL('../dist/', import.meta.url));
    const chunks = await Promise.all((await fs.readdir(dist)).filter(name => name.endsWith('.js'))
        .map(async name => [name, await fs.readFile(path.join(dist, name))]));
    const server = await serveEditorRuntime({files: {
        ...Object.fromEntries(chunks), 'index.html': '<!doctype html><title>Save and commit queue</title>'
    }});
    t.after(() => server.close());
    const browser = await chromium.launch({headless: true});
    t.after(() => browser.close());
    const context = await browser.newContext();
    const first = await context.newPage();
    await first.goto(server.url);
    const id = await first.evaluate(async contents => {
        const {createSaveCommitQueue, createIndexedDbSaveCommitJournal} = await import('/task-queue.js');
        const root = await navigator.storage.getDirectory();
        const write = async (directory, name, bytes) => {
            const handle = await directory.getFileHandle(name, {create: true});
            const stream = await handle.createWritable();
            await stream.write(bytes);
            await stream.close();
        };
        for (const [parts, bytes] of contents) {
            let directory = root;
            for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, {create: true});
            await write(directory, parts.at(-1), Uint8Array.from(bytes));
        }
        await write(root, 'project.source.json', '{"targets":[1]}\n');
        const queue = createSaveCommitQueue({root, journal: createIndexedDbSaveCommitJournal(indexedDB)});
        return (await queue.enqueue({selection: await queue.capture(), message: 'Resume from Chromium'})).id;
    }, files);
    await first.close();
    const second = await context.newPage();
    await second.goto(server.url);
    const result = await second.evaluate(async () => {
        const {createSaveCommitQueue, createIndexedDbSaveCommitJournal} = await import('/task-queue.js');
        const root = await navigator.storage.getDirectory();
        const queue = createSaveCommitQueue({root, journal: createIndexedDbSaveCommitJournal(indexedDB)});
        const [job] = await queue.resume();
        return job;
    });
    assert.equal(result?.id, id);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.match(result.commitOid, /^[0-9a-f]{40}$/u);
});
