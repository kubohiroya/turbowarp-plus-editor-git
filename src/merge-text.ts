import {diffArrays} from 'diff';

/** A run of lines, each with its own line ending. */
export type TextChunk =
    | {type: 'stable'; lines: string[]}
    | {type: 'conflict'; base: string[]; current: string[]; incoming: string[]};

export interface TextMergeResult {
    chunks: TextChunk[];
    /** The merged text. Conflicting chunks keep the base lines, without conflict markers. */
    text: string;
    conflicts: number;
}

export type TextSide = 'base' | 'current' | 'incoming';

/** Splits text into lines that keep their line endings, so joining them gives the text back. */
export function splitLines(text: string): string[] {
    return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Maps each base line index to the matching line index on the other side, along a longest common subsequence. */
function matches(base: string[], other: string[]): Map<number, number> {
    const result = new Map<number, number>();
    let b = 0, o = 0;
    for (const part of diffArrays(base, other)) {
        const count = part.count ?? part.value.length;
        if (part.added) o += count;
        else if (part.removed) b += count;
        else for (let i = 0; i < count; i++) result.set(b++, o++);
    }
    return result;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * Line-based three-way merge (diff3). A chunk that only one side changed takes that side; a chunk that both sides
 * changed in the same way takes it once; otherwise it is a conflict.
 */
export function mergeText(base: string, current: string, incoming: string): TextMergeResult {
    const [b, c, i] = [splitLines(base), splitLines(current), splitLines(incoming)];
    const toCurrent = matches(b, c), toIncoming = matches(b, i);
    const chunks: TextChunk[] = [];
    const stable = (line: string) => {
        const last = chunks[chunks.length - 1];
        if (last?.type === 'stable') last.lines.push(line);
        else chunks.push({type: 'stable', lines: [line]});
    };
    const unstable = (baseLines: string[], currentLines: string[], incomingLines: string[]) => {
        if (!baseLines.length && !currentLines.length && !incomingLines.length) return;
        if (same(currentLines, incomingLines) || same(baseLines, incomingLines)) currentLines.forEach(stable);
        else if (same(baseLines, currentLines)) incomingLines.forEach(stable);
        else chunks.push({type: 'conflict', base: baseLines, current: currentLines, incoming: incomingLines});
    };
    let bi = 0, ci = 0, ii = 0;
    while (bi < b.length) {
        if (toCurrent.get(bi) === ci && toIncoming.get(bi) === ii) {
            stable(b[bi]);
            bi++; ci++; ii++;
            continue;
        }
        let next = bi;
        while (next < b.length && !(toCurrent.has(next) && toIncoming.has(next) &&
            toCurrent.get(next)! >= ci && toIncoming.get(next)! >= ii)) next++;
        const nextCurrent = next < b.length ? toCurrent.get(next)! : c.length;
        const nextIncoming = next < b.length ? toIncoming.get(next)! : i.length;
        unstable(b.slice(bi, next), c.slice(ci, nextCurrent), i.slice(ii, nextIncoming));
        bi = next; ci = nextCurrent; ii = nextIncoming;
    }
    unstable([], c.slice(ci), i.slice(ii));
    return {chunks, text: renderText(chunks, []), conflicts: chunks.filter(chunk => chunk.type === 'conflict').length};
}

/** Joins the chunks, taking the given side for each conflict in order (the base for conflicts without a choice). */
export function renderText(chunks: readonly TextChunk[], choices: readonly (TextSide | undefined)[]): string {
    let conflict = 0;
    return chunks.map(chunk => chunk.type === 'stable' ? chunk.lines.join('') : chunk[choices[conflict++] ?? 'base'].join(''))
        .join('');
}
