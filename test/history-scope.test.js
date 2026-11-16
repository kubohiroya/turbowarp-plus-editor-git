import assert from 'node:assert/strict';
import {test} from 'node:test';
import React from 'react';
import ReactDOMServer from 'react-dom/server.js';
import {HistoryScope} from '../dist/index.js';

const render = props => ReactDOMServer.renderToStaticMarkup(React.createElement(HistoryScope, props));

test('the history says it covers every branch and names the branch being worked on', () => {
    const html = render({branch: 'feature-x', head: 'a'.repeat(40), locale: 'ja'});
    assert.match(html, /ローカルと origin\/\* のすべてのブランチ/u);
    assert.match(html, /作業中のブランチは feature-x です。/u);
    assert.match(render({branch: 'main', head: 'a'.repeat(40)}), /You are working on main\./u);
});

test('the history names HEAD when it is not on a branch, and only the scope when there is no commit', () => {
    assert.match(render({branch: undefined, head: '0123456789abcdef', locale: 'ja'}), /ブランチに入っていません（HEAD 01234567）/u);
    const empty = render({branch: undefined, head: null});
    assert.match(empty, /Every local branch/u);
    assert.doesNotMatch(empty, /HEAD|working on/u);
});
