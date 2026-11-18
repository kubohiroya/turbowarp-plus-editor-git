// Opens the remote repository dialog with a stand-in GitHub connection whose sessions reach the local Smart HTTP
// fixture, and folders kept in the origin private file system.
import {Buffer} from 'buffer';
import {openRemoteRepositoryDialog} from '../dist/remote-repository.js';
import style from '../dist/style.css';

// isomorphic-git expects the Buffer the Editor provides.
globalThis.Buffer ??= Buffer;

let state = {status: 'disconnected'};
let authorization;
let connectedRemote = null;

globalThis.openDialog = async ({locale, deviceFolders, browserFolders, proxyOrigin}) => {
    if (!document.getElementById('twgit-style'))
        document.head.append(Object.assign(document.createElement('style'), {id: 'twgit-style', textContent: style}));
    const top = await navigator.storage.getDirectory();
    globalThis.calls = [];
    const settings = {
        modes: ['desktop'],
        getView: () => ({mode: 'desktop', state, authorization}),
        async select() {},
        async connect(remote, write) {
            calls.push(['connect', remote, write]);
            connectedRemote = remote;
            state = {status: 'connecting'};
            authorization = {url: 'https://github.com/login/device', userCode: 'ABCD-1234'};
        },
        async refresh() {
            if (state.status !== 'connecting') return;
            state = {status: 'connected', account: {login: 'octocat'}, expiresAt: Date.now() + 600_000};
            authorization = undefined;
        },
        async disconnect() {
            calls.push(['disconnect']);
            state = {status: 'disconnected'};
        },
        async getSession(target, write) {
            if (state.status !== 'connected' || target !== connectedRemote || write) return null;
            return {connection: {mode: 'desktop', proxyOrigin}, bearer: 'fixture-read', expiresAt: Date.now() + 600_000};
        }
    };
    globalThis.result = openRemoteRepositoryDialog({document, locale, connectionSettings: settings, deviceFolders,
        async pickDeviceFolder() {
            calls.push(['pickDeviceFolder']);
            return top.getDirectoryHandle('device', {create: true});
        },
        createBrowserFolder: browserFolders ? async name => {
            calls.push(['createBrowserFolder', name]);
            return top.getDirectoryHandle('browser-' + name, {create: true});
        } : undefined,
        async removeBrowserFolder(folder) {
            calls.push(['removeBrowserFolder', folder.name]);
            await top.removeEntry(folder.name, {recursive: true});
        },
        async openProject(root) {
            calls.push(['openProject', root.name]);
        }
    }).then(opened => {
        calls.push(['closed', opened]);
        return opened;
    });
};

// The names at the root of a folder in the origin private file system, or null when there is no such folder, and HEAD.
globalThis.readFolder = async name => {
    const top = await navigator.storage.getDirectory();
    let folder;
    try {folder = await top.getDirectoryHandle(name);} catch {return null;}
    const names = [];
    for await (const key of folder.keys()) names.push(key);
    let head = null;
    try {head = await (await (await folder.getDirectoryHandle('.git')).getFileHandle('HEAD')).getFile().then(file => file.text());}
    catch {}
    return {names: names.sort(), head};
};
