import assert from 'node:assert/strict';
import {test} from 'node:test';
import React from 'react';
import ReactDOMServer from 'react-dom/server.js';
import {ProjectComparisonDialog} from '@kubohiroya/turbowarp-plus-editor-git/project-source-diff';

const source = blocks => `${JSON.stringify({targets: [
    {isStage: true, name: 'Stage', blocks: {}},
    {isStage: false, name: 'Cat', blocks}
]}, null, 2)}\n`;
const base = source({flag: {opcode: 'event_whenflagclicked', next: 'move', parent: null, topLevel: true, inputs: {}, fields: {}},
    move: {opcode: 'motion_movesteps', next: null, parent: 'flag', inputs: {STEPS: [1, [4, '10']]}, fields: {}}});
const edited = base.replace('"10"', '"25"');
const disk = base.replace('"10"', '"40"');

test('the comparison dialog shows each section and offers the actions in order', () => {
    const html = ReactDOMServer.renderToStaticMarkup(React.createElement(ProjectComparisonDialog, {
        title: 'External changes and your unsaved edits',
        description: 'Loading from the folder discards your edits.',
        notes: ['Some of your edits cannot be shown here.'],
        sections: [{title: 'Your unsaved edits', before: base, after: edited}, {title: 'Changes in the folder', before: base, after: disk}],
        actions: [{id: 'keep', label: 'Keep My Edits'}, {id: 'discard', label: 'Discard Edits and Load from Folder'}],
        closeLabel: 'Close', renderBlock: async () => {}, onChoose() {}
    }));
    assert.match(html, /role="dialog" aria-modal="true" aria-label="External changes and your unsaved edits"/);
    assert.match(html, /Loading from the folder discards your edits\./);
    assert.match(html, /role="note">Some of your edits cannot be shown here\./);
    const sections = [...html.matchAll(/<section aria-label="([^"]+)" data-twgit-comparison="">/g)].map(match => match[1]);
    assert.deepEqual(sections, ['Your unsaved edits', 'Changes in the folder']);
    const actions = [...html.matchAll(/data-twgit-action="([^"]+)">([^<]+)</g)].map(match => [match[1], match[2]]);
    assert.deepEqual(actions, [['keep', 'Keep My Edits'], ['discard', 'Discard Edits and Load from Folder']]);
    // Both comparisons reach the code view of the changed sprite.
    assert.equal(html.match(/Cat/g)?.length >= 2, true);
});
