// A pull request review with comment fields and the review composer, drawn with the real Scratch Blocks. Reviews go to
// the stand-in proxy of github-review-fixture.js, so no GitHub or network is involved.
import React from 'react';
import {render} from 'react-dom';
import {createScratchBlocksDiffRenderer} from '../dist/index.js';
import {createGitHubReviewApi, createProjectSourceDiff, ProjectSourceReview, PullRequestReviewComposer} from '../dist/project-source-diff.js';
import style from '../dist/style.css';
import {createReviewFixture, reviewRemote, reviewSession} from './github-review-fixture.js';

globalThis.mountReviewComposer = async ({files, locale, head}) => {
    const runtime = await EditorRuntime.start(document.getElementById('workspace'), {locale});
    document.head.append(Object.assign(document.createElement('style'), {textContent: style}));
    document.body.style.cssText = 'margin: 0; background: Canvas; font: 13px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif';
    const renderBlock = createScratchBlocksDiffRenderer({getBlockly: runtime.getBlockly, deserializeBlocks: runtime.deserializeBlocks,
        createBlockContainer: runtime.createBlockContainer, showUnregisteredBlocks: true, locale});
    const fixture = createReviewFixture({head, number: 7, delay: 20});
    globalThis.reviewFixture = fixture;
    const api = createGitHubReviewApi({remote: reviewRemote, fetch: fixture.fetch, getSession: async () => reviewSession()});
    const name = 'fixture/work#7';
    const host = Object.assign(document.createElement('div'), {className: 'twgit-panel'});
    host.style.cssText = 'max-width: 900px; padding: 16px';
    document.body.replaceChildren(host);
    const reviewFiles = files.map(({path, before, after}) => ({path, patch: createProjectSourceDiff(before, after)}));
    render(React.createElement(React.Fragment, null,
        React.createElement(ProjectSourceReview, {title: 'Ask before moving', files: reviewFiles, renderBlock, locale, rememberAs: name,
            commentAs: name}),
        React.createElement(PullRequestReviewComposer, {api, name, number: 7, head, changedFiles: files.map(file => file.path),
            url: 'https://github.com/fixture/work/pull/7', locale})), host);
};
