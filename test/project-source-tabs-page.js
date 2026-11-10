// Shows a pull request's review beside the tabs of the same comparison, each tab in a box of its own.
import React from 'react';
import {render} from 'react-dom';
import {createProjectSourceDiff, openProjectSourceTabs, ProjectSourceReview} from '../dist/project-source-diff.js';
import style from '../dist/style.css';

globalThis.mountReview = ({before, after, rememberAs}) => {
    document.head.append(Object.assign(document.createElement('style'), {textContent: style}));
    const panel = document.createElement('div');
    const tabs = document.createElement('div');
    panel.dataset.panel = '';
    tabs.style.cssText = 'display: grid; gap: 8px';
    const host = document.createElement('div');
    host.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font: 14px system-ui';
    host.append(panel, tabs);
    document.getElementById('workspace').replaceWith(host);
    const path = 'game/project.source.json';
    const renderBlock = async () => {};
    if (rememberAs) {
        render(React.createElement(ProjectSourceReview, {title: 'Review', locale: 'ja', renderBlock, rememberAs,
            files: [{path, patch: createProjectSourceDiff(JSON.stringify(before), JSON.stringify(after))}]}), panel);
    }
    return openProjectSourceTabs(request => {
        const box = Object.assign(document.createElement('section'), {title: request.title});
        box.dataset.tab = request.title;
        tabs.append(box);
        request.mount(box, () => {});
        return true;
    }, {key: 'pr', files: [{path, before, after}], renderBlock, locale: 'ja', rememberAs});
};
