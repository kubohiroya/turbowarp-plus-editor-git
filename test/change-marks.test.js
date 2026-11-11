import {test} from 'node:test';
import assert from 'node:assert/strict';
import {changeMarks} from '../dist/index.js';

const change = (path, group, before, after) => ({path, group, before, after, worktree: group !== 'staged', oldMode: null, newMode: null});

test('marks the working tree changes by path, as the working tree stands', () => {
    const marks = changeMarks([
        change('a.txt', 'unstaged', 'x', 'y'),
        change('b.txt', 'staged', null, 'y'),
        change('c.txt', 'unstaged', 'x', null),
        change('d.txt', 'untracked', null, 'y'),
        // Staged as added, then edited again: the working tree's change wins.
        change('e.txt', 'unstaged', 'x', 'z'),
        change('e.txt', 'staged', null, 'x')
    ], '');
    assert.deepEqual(Object.fromEntries(marks), {
        'a.txt': 'modified', 'b.txt': 'added', 'c.txt': 'deleted', 'd.txt': 'untracked', 'e.txt': 'modified'
    });
});

test('keeps only the changes under the folder, relative to it', () => {
    const marks = changeMarks([
        change('games/cat/project.source.json', 'unstaged', 'x', 'y'),
        change('games/cat/assets/1.svg', 'untracked', null, 'y'),
        change('games/catalog/notes.md', 'unstaged', 'x', 'y'),
        change('README.md', 'unstaged', 'x', 'y')
    ], '/games/cat/');
    assert.deepEqual(Object.fromEntries(marks), {'project.source.json': 'modified', 'assets/1.svg': 'untracked'});
});
