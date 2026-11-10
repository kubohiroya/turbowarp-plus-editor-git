// Renders the history graph with commits read by the test, and records what it asks the host to do.
import React from 'react';
import {render} from 'react-dom';
import {HistoryGraph} from '../dist/index.js';
import style from '../dist/style.css';

globalThis.mountGraph = ({commits, locale, localBranches}) => {
    document.head.append(Object.assign(document.createElement('style'), {textContent: style}));
    document.body.style.background = 'Canvas';
    const host = Object.assign(document.createElement('div'), {className: 'twgit-panel twgit-panel-tab'});
    host.style.cssText = 'position: absolute; inset: 0; width: 460px; height: auto; font: 14px/1.5 system-ui, sans-serif; padding: 8px 12px';
    document.getElementById('workspace').replaceWith(host);
    globalThis.calls = [];
    const draw = selected => render(React.createElement(HistoryGraph, {commits, locale, localBranches, selected,
        hasMore: true, onShowMore: () => calls.push(['showMore']),
        onSelect: oid => {calls.push(['select', oid]); draw(oid);},
        onCreateBranch: (oid, name, checkout) => {calls.push(['createBranch', oid, name, checkout]);},
        onSwitchBranch: name => {calls.push(['switchBranch', name]);},
        onCreateFromRemote: name => {calls.push(['createFromRemote', name]);}}), host);
    draw(null);
};
