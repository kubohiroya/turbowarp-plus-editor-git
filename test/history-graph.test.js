import {test} from 'node:test';
import assert from 'node:assert/strict';
import {layoutHistory} from '../dist/index.js';

// `graph('c:b a', 'b:a', 'a:')` lists commits newest first as `oid:parents`.
const graph = (...lines) => lines.map(line => {
    const [oid, parents] = line.split(':');
    return {oid, parents: parents ? parents.split(' ') : []};
});

/**
 * Follows the lines drawn from each commit's dot down to the dot they end in, and returns `child>parent` edges.
 * Checks on the way that each band's lines meet the next band's at the same columns.
 */
function trace(commits, layout) {
    const edges = [];
    for (const [index, row] of layout.rows.entries()) {
        for (const start of row.segments.filter(segment => segment.part === 'bottom' && segment.from === row.column)) {
            let lane = start.to, color = start.color;
            let found = null;
            for (let next = index + 1; next < layout.rows.length && !found; next++) {
                const top = layout.rows[next].segments.find(segment => segment.part === 'top' && segment.from === lane);
                assert.ok(top, `a line leaves ${row.oid} in column ${lane} and must reach row ${commits[next].oid}`);
                assert.equal(top.color, color, 'a lane keeps its color');
                // Only lanes waiting for a commit reach its column: the others pass by in their own.
                if (top.to === layout.rows[next].column) {
                    found = layout.rows[next].oid;
                    break;
                }
                const bottom = layout.rows[next].segments.find(segment => segment.part === 'bottom' && segment.from === lane && segment.to === lane);
                assert.ok(bottom, `column ${lane} continues past ${commits[next].oid}`);
            }
            edges.push(`${row.oid}>${found ?? '…'}`);
        }
    }
    return edges.sort();
}
const parentEdges = commits => commits.flatMap(commit => [...new Set(commit.parents)].map(parent =>
    `${commit.oid}>${commits.some(item => item.oid === parent) ? parent : '…'}`)).sort();
const columns = layout => layout.rows.map(row => row.column);

test('a linear history stays in one lane with one color', () => {
    const commits = graph('c:b', 'b:a', 'a:');
    const layout = layoutHistory(commits);
    assert.deepEqual(columns(layout), [0, 0, 0]);
    assert.equal(layout.width, 1);
    assert.deepEqual(new Set(layout.rows.map(row => row.color)).size, 1);
    assert.deepEqual(trace(commits, layout), parentEdges(commits));
    // The root ends its lane: nothing is drawn below it.
    assert.deepEqual(layout.rows[2].segments.filter(segment => segment.part === 'bottom'), []);
});

test('a branch and its merge use a second lane between them', () => {
    const commits = graph('m:c f', 'f:e', 'c:b', 'e:b', 'b:a', 'a:');
    const layout = layoutHistory(commits);
    assert.deepEqual(columns(layout), [0, 1, 0, 1, 0, 0]);
    assert.deepEqual(trace(commits, layout), parentEdges(commits));
    assert.notEqual(layout.rows[1].color, layout.rows[0].color, 'the merged branch has its own color');
    // Both lanes meet in b; the second lane ends there.
    assert.deepEqual(layout.rows[4].segments.filter(segment => segment.part === 'top').map(segment => [segment.from, segment.to]), [[0, 0], [1, 0]]);
    assert.equal(layout.rows[4].width, 2);
    assert.equal(layout.rows[5].width, 1);
});

test('two branches diverging from one commit keep separate lanes until it', () => {
    const commits = graph('x:b', 'y:b', 'b:a', 'a:');
    const layout = layoutHistory(commits);
    assert.deepEqual(columns(layout), [0, 1, 0, 0]);
    assert.deepEqual(trace(commits, layout), parentEdges(commits));
    assert.notEqual(layout.rows[0].color, layout.rows[1].color);
});

test('an octopus merge draws a line to each of its parents', () => {
    const commits = graph('o:a b c', 'c:r', 'b:r', 'a:r', 'r:');
    const layout = layoutHistory(commits);
    assert.deepEqual(columns(layout), [0, 2, 1, 0, 0]);
    assert.deepEqual(layout.rows[0].segments.filter(segment => segment.part === 'bottom').map(segment => segment.to), [0, 1, 2]);
    assert.equal(layout.width, 3);
    assert.deepEqual(trace(commits, layout), parentEdges(commits));
    assert.equal(new Set(layout.rows.slice(0, 3).map(row => row.color)).size, 3);
});

test('a merge parent already waited for joins the existing lane, and duplicate parents draw once', () => {
    const commits = graph('t:b', 'm:a b b', 'b:a', 'a:');
    const layout = layoutHistory(commits);
    assert.deepEqual(columns(layout), [0, 1, 0, 0]);
    assert.equal(layout.width, 2);
    assert.deepEqual(trace(commits, layout), parentEdges(commits));
});

test('lanes freed when a branch ends are reused by later branches', () => {
    // f ends its lane at b (a merge), so g, a later tip, takes the freed column 1 again.
    const commits = graph('m:b f', 'f:b', 'b:a', 'g:a', 'a:');
    const layout = layoutHistory(commits);
    assert.deepEqual(columns(layout), [0, 1, 0, 1, 0]);
    assert.equal(layout.width, 2);
    assert.deepEqual(trace(commits, layout), parentEdges(commits));
    // A tip after the freed lane gets a new color.
    assert.notEqual(layout.rows[3].color, layout.rows[1].color);
});

test('parents not loaded yet keep their lanes running to the bottom, and a later page lays out the same', () => {
    const all = graph('m:c f', 'f:e', 'c:b', 'e:b', 'b:a', 'a:');
    const first = layoutHistory(all.slice(0, 3));
    assert.deepEqual(trace(all.slice(0, 3), first), parentEdges(all.slice(0, 3)));
    assert.deepEqual(first.rows[2].segments.filter(segment => segment.part === 'bottom').map(segment => segment.from).sort(), [0, 1]);
    // Laying out more commits leaves the earlier rows as they were, so colors and columns do not jump.
    assert.deepEqual(layoutHistory(all).rows.slice(0, 3), first.rows);
});

test('every edge leads down to its parent in a larger mixed history (ordering invariant)', () => {
    const commits = graph('h:g k', 'k:j', 'g:f', 'j:f i', 'i:d', 'f:e d', 'e:c', 'd:c', 'c:b', 'b:a', 'a:');
    const layout = layoutHistory(commits);
    const rowOf = new Map(commits.map((commit, index) => [commit.oid, index]));
    for (const commit of commits) for (const parent of commit.parents) assert.ok(rowOf.get(parent) > rowOf.get(commit.oid));
    assert.deepEqual(trace(commits, layout), parentEdges(commits));
    assert.ok(layout.width <= 3);
});
