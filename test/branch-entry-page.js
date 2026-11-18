// Mounts the Git panel with the branch button beside it and the history view at the side, on a directory dropped by the test.
import {Buffer} from 'buffer';
import React from 'react';
import {render} from 'react-dom';
import {mountGitPanel, renderBranchButton, renderHistoryView} from '../dist/index.js';
import style from '../dist/style.css';

// isomorphic-git expects the Buffer the Editor provides.
globalThis.Buffer ??= Buffer;
let directory;
for (const type of ['dragenter', 'dragover', 'drop']) window.addEventListener(type, async event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (type === 'drop') {
        directory = await event.dataTransfer.items[0].getAsFileSystemHandle();
        window.directoryReady = directory?.kind === 'directory';
    }
}, {capture: true});
window.showDirectoryPicker = async () => directory;

globalThis.mountEntry = ({locale, writable, panelFirst, connection, folders}) => {
    document.head.append(Object.assign(document.createElement('style'), {textContent: style}));
    document.body.style.cssText = 'margin: 0; background: Canvas; font: 12px/1.5 system-ui, sans-serif';
    const bar = Object.assign(document.createElement('div'), {id: 'menu-bar'});
    bar.style.cssText = 'display: flex; justify-content: flex-end; height: 3rem; padding: 0 12px; color: #fff; background: hsl(215, 100%, 65%)';
    (document.getElementById('workspace') ?? document.body.firstElementChild).replaceWith(bar);
    const side = Object.assign(document.createElement('aside'), {id: 'side'});
    side.style.cssText = 'width: 280px';
    bar.after(side);
    const vm = {};
    globalThis.host = {dirty: false, opened: null, browserFolder: 0};
    let notify;
    const mount = () => mountGitPanel({vm, document, host: {
        openProject: async () => 'cancelled', isProjectDirty: () => host.dirty, isProjectRunning: () => false,
        subscribe(listener) {
            notify = listener;
            return () => {notify = undefined;};
        },
        ...writable ? {localWrite: {}} : {},
        // A host with its own folder commands: opening the dropped directory binds the panel to its repository.
        ...folders ? {
            projectDirectory: () => host.opened,
            openFolder() {
                host.opened = directory;
                notify?.('folder');
                void globalThis.panel.selectRepository(directory, directory);
            },
            openBrowserFolder() {host.browserFolder++;}
        } : {},
        // A GitHub connection that never connects, enough to show where Git is set up.
        ...connection ? {connectionSettings: {modes: ['cloudflare'], getView: () => ({mode: 'cloudflare', state: {status: 'disconnected'}}),
            async select() {}, async connect() {}, async refresh() {}, async disconnect() {}}} : {}}});
    host.setDirty = dirty => {host.dirty = dirty; notify?.('changed');};
    // The button may be rendered before or after the panel is mounted.
    if (panelFirst) globalThis.panel = mount();
    render(renderBranchButton(React.createElement, {vm, locale}), bar);
    render(renderHistoryView(React.createElement, {vm, locale}), side);
    if (!panelFirst) globalThis.panel = mount();
};
