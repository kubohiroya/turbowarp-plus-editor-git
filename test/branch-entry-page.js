// Mounts the Git panel with the branch button beside it, on a directory dropped by the test.
import {Buffer} from 'buffer';
import React from 'react';
import {render} from 'react-dom';
import {mountGitPanel, renderBranchButton} from '../dist/index.js';
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

globalThis.mountEntry = ({locale, writable, panelFirst}) => {
    document.head.append(Object.assign(document.createElement('style'), {textContent: style}));
    document.body.style.cssText = 'margin: 0; background: Canvas; font: 12px/1.5 system-ui, sans-serif';
    const bar = Object.assign(document.createElement('div'), {id: 'menu-bar'});
    bar.style.cssText = 'display: flex; justify-content: flex-end; height: 3rem; padding: 0 12px; color: #fff; background: hsl(215, 100%, 65%)';
    (document.getElementById('workspace') ?? document.body.firstElementChild).replaceWith(bar);
    const vm = {};
    globalThis.host = {dirty: false};
    const mount = () => mountGitPanel({vm, document, host: {
        openProject: async () => 'cancelled', isProjectDirty: () => host.dirty, isProjectRunning: () => false,
        ...writable ? {localWrite: {}} : {}}});
    // The button may be rendered before or after the panel is mounted.
    if (panelFirst) globalThis.panel = mount();
    render(renderBranchButton(React.createElement, {vm, locale}), bar);
    if (!panelFirst) globalThis.panel = mount();
};
