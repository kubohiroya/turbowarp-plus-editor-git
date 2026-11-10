// Renders the branch button in a menu bar like the Editor's, and records what it asks the panel to do.
import React from 'react';
import {render} from 'react-dom';
import {BranchButton} from '../dist/index.js';
import style from '../dist/style.css';

globalThis.mountBranchButton = ({state, locale}) => {
    if (!document.getElementById('twgit-style')) document.head.append(Object.assign(document.createElement('style'), {id: 'twgit-style', textContent: style}));
    document.body.style.cssText = 'margin: 0; background: Canvas; font: 12px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif';
    let bar = document.getElementById('menu-bar');
    if (!bar) {
        bar = Object.assign(document.createElement('div'), {id: 'menu-bar'});
        bar.style.cssText = 'display: flex; align-items: center; justify-content: flex-end; gap: 8px; height: 3rem; padding: 0 12px; ' +
            'color: #fff; background: hsla(215, 100%, 65%, 1)';
        (document.getElementById('workspace') ?? document.body.firstElementChild ?? document.body).replaceWith(bar);
        bar.append(Object.assign(document.createElement('div'), {id: 'branch'}),
            Object.assign(document.createElement('span'), {textContent: locale === 'ja' ? 'ステージを開く ▾' : 'Open stage ▾'}));
    }
    globalThis.calls = [];
    // The test settles each branch operation with `finish(result)`.
    const operation = (...call) => {
        calls.push(call);
        return new Promise(resolve => {globalThis.finish = resolve;});
    };
    render(React.createElement(BranchButton, {state, locale,
        open: () => calls.push(['open']), choose: () => calls.push(['choose']),
        switchBranch: name => operation('switchBranch', name),
        createBranch: (name, checkout) => operation('createBranch', name, checkout),
        createFromRemote: name => operation('createFromRemote', name)}), document.getElementById('branch'));
};
