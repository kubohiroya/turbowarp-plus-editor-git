/**
 * Lays out a commit graph in lanes, top to bottom, after the approach DoltHub describes in "Drawing a commit graph"
 * (https://www.dolthub.com/blog/2024-08-07-drawing-a-commit-graph/): each lane waits for one commit; a commit takes
 * the leftmost lane that waits for it, or the first free lane; its first parent continues that lane and each further
 * parent gets the lane that already waits for it, or a free one. Lanes whose commit arrived elsewhere end there and
 * are reused by later commits.
 */

/** The parts of a commit the layout needs. Commits come newest first, each child above its parents. */
export interface GraphCommit {
    oid: string;
    parents: readonly string[];
}
/**
 * A line in one row's band, between columns. `top` runs from the row's upper edge to the dot's height; `bottom`
 * from the dot's height to the lower edge. `from` is the upper end's column and `to` the lower end's.
 */
export interface GraphSegment {
    part: 'top' | 'bottom';
    from: number;
    to: number;
    color: number;
}
export interface GraphRow {
    oid: string;
    /** The commit's column. */
    column: number;
    /** The color of the commit's lane, an index into a palette (see `laneColors`). */
    color: number;
    segments: GraphSegment[];
    /** Columns this row's band uses: one more than the rightmost lane drawn in it. */
    width: number;
}
export interface GraphLayout {
    rows: GraphRow[];
    /** The widest row, for drawing every row with the same width. */
    width: number;
}

/** How many lane colors there are. Lanes take them in turn. */
export const laneColorCount = 8;

interface Lane {oid: string; color: number}

/**
 * Lays out commits ordered newest first with every child above its parents. Parents missing from `commits`, such as
 * those on a page not loaded yet or cut off by a shallow clone, keep their lane running to the bottom.
 */
export function layoutHistory(commits: readonly GraphCommit[]): GraphLayout {
    const lanes: (Lane | null)[] = [];
    let nextColor = 0;
    const free = () => {
        const index = lanes.indexOf(null);
        return index === -1 ? lanes.length : index;
    };
    const rows: GraphRow[] = [];
    for (const commit of commits) {
        const segments: GraphSegment[] = [];
        const before = lanes.slice();
        const waiting = before.flatMap((lane, index) => lane?.oid === commit.oid ? [index] : []);
        const column = waiting.length ? waiting[0] : free();
        const color = waiting.length ? before[column]!.color : nextColor++ % laneColorCount;
        for (const [index, lane] of before.entries()) {
            if (!lane) continue;
            // Lanes that waited for this commit end in its dot; the others pass by.
            segments.push({part: 'top', from: index, to: lane.oid === commit.oid ? column : index, color: lane.color});
        }
        for (const index of waiting) lanes[index] = null;
        const parents = [...new Set(commit.parents)];
        lanes[column] = parents.length ? {oid: parents[0], color} : null;
        const joins: {index: number; color: number}[] = parents.length ? [{index: column, color}] : [];
        for (const parent of parents.slice(1)) {
            let index = lanes.findIndex(lane => lane?.oid === parent);
            if (index === -1) {
                index = free();
                lanes[index] = {oid: parent, color: nextColor++ % laneColorCount};
            }
            joins.push({index, color: lanes[index]!.color});
        }
        while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
        for (const [index, lane] of before.entries()) {
            // Lanes waiting for other commits are never reassigned here, so they pass straight by.
            if (lane && lane.oid !== commit.oid) segments.push({part: 'bottom', from: index, to: index, color: lane.color});
        }
        for (const join of joins) segments.push({part: 'bottom', from: column, to: join.index, color: join.color});
        const width = Math.max(column + 1, ...segments.map(segment => Math.max(segment.from, segment.to) + 1));
        rows.push({oid: commit.oid, column, color, segments, width});
    }
    return {rows, width: Math.max(0, ...rows.map(row => row.width))};
}
