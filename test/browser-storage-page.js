// Mounts the Git panel without the folder picker, on a repository kept in the browser's origin private file system.
import {Buffer} from 'buffer';
import React from 'react';
import {render} from 'react-dom';
import {mountGitPanel, renderBranchButton, renderHistoryView} from '../dist/index.js';
import {prepareInitialRepository} from '../dist/initial-commit.js';
import style from '../dist/style.css';

// isomorphic-git expects the Buffer the Editor provides.
globalThis.Buffer ??= Buffer;
const encode = text => new TextEncoder().encode(text);

globalThis.mountBrowserStorage = async () => {
    delete window.showDirectoryPicker;
    document.head.append(Object.assign(document.createElement('style'), {textContent: style}));
    const top = await navigator.storage.getDirectory();
    await top.removeEntry('twgit-test', {recursive: true}).catch(() => {});
    const root = await top.getDirectoryHandle('twgit-test', {create: true});
    await prepareInitialRepository({directory: root, operationId: crypto.randomUUID(),
        remote: 'https://github.com/example/browser-storage.git', repositoryId: 1, timestamp: 1_700_000_000,
        author: {name: 'Fixture', email: 'fixture@example.invalid'},
        files: [{path: 'notes.txt', bytes: encode('first\n')}]});
    globalThis.chosen = 0;
    const vm = {};
    const bar = Object.assign(document.createElement('div'), {id: 'menu-bar'});
    (document.getElementById('workspace') ?? document.body.firstElementChild).replaceWith(bar);
    // Git is set up from the side panel; the menu bar shows Git once a repository is chosen.
    const side = Object.assign(document.createElement('aside'), {id: 'side'});
    bar.after(side);
    render(renderBranchButton(React.createElement, {vm, locale: 'en'}), bar);
    render(renderHistoryView(React.createElement, {vm, locale: 'en'}), side);
    globalThis.panel = mountGitPanel({vm, document, host: {
        openProject: async () => 'cancelled', isProjectDirty: () => false, isProjectRunning: () => false,
        localWrite: {},
        async chooseRoot() {
            globalThis.chosen++;
            return root;
        }
    }});
    globalThis.writeNotes = async text => {
        const writable = await (await root.getFileHandle('notes.txt')).createWritable();
        await writable.write(encode(text));
        await writable.close();
    };
    return !!globalThis.panel;
};
