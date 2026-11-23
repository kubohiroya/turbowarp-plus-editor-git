import {equal, isRecord} from './project-source-patch.js';

/** A path into a JSON document. A string step into an array names the element whose key is that string. */
export type JsonPath = readonly (string | number)[];

/** One place where both sides changed the same value differently. `undefined` stands for a missing value. */
export interface JsonConflict {
    path: JsonPath;
    base: unknown;
    current: unknown;
    incoming: unknown;
}

export interface JsonMergeOptions {
    /** Returns how to identify the elements of the array at `path`, or `undefined` to treat it as one value. */
    arrayKey?(path: JsonPath): ((item: unknown) => string | undefined) | undefined;
    /** Whether the array at `path` is a fixed-length tuple whose positions merge separately. */
    tuple?(path: JsonPath): boolean;
}

export interface JsonMergeResult {
    /** The merged value. Conflicting places keep the base value (missing if the base has none). */
    value: unknown;
    conflicts: JsonConflict[];
}

const missing = (value: unknown) => value === undefined;

/**
 * Three-way merge of JSON values. Objects merge key by key, keyed arrays element by element, tuples position by
 * position; anything else is one value. Key and element order follows the current side, with the incoming side's
 * additions placed after the element that precedes them there.
 */
export function mergeJson(base: unknown, current: unknown, incoming: unknown, options: JsonMergeOptions = {},
    path: JsonPath = []): JsonMergeResult {
    if (equal(current, incoming)) return {value: current, conflicts: []};
    if (equal(base, current)) return {value: incoming, conflicts: []};
    if (equal(base, incoming)) return {value: current, conflicts: []};
    const conflict = (): JsonMergeResult => ({value: base, conflicts: [{path, base, current, incoming}]});
    if (missing(current) || missing(incoming)) return conflict();
    if (isRecord(current) && isRecord(incoming) && (missing(base) || isRecord(base))) {
        return mergeObjects((base ?? {}) as Record<string, unknown>, current, incoming, options, path);
    }
    if (Array.isArray(current) && Array.isArray(incoming) && (missing(base) || Array.isArray(base))) {
        const baseArray = (base ?? []) as unknown[];
        const key = options.arrayKey?.(path);
        if (key && [baseArray, current, incoming].every(items => uniqueKeys(items, key))) {
            return mergeKeyedArrays(baseArray, current, incoming, key, options, path);
        }
        if (options.tuple?.(path) && baseArray.length === current.length && current.length === incoming.length) {
            const conflicts: JsonConflict[] = [];
            const value = current.map((_, index) => {
                const merged = mergeJson(baseArray[index], current[index], incoming[index], options, [...path, index]);
                conflicts.push(...merged.conflicts);
                return merged.value;
            });
            return {value, conflicts};
        }
    }
    return conflict();
}

function mergeObjects(base: Record<string, unknown>, current: Record<string, unknown>, incoming: Record<string, unknown>,
    options: JsonMergeOptions, path: JsonPath): JsonMergeResult {
    const keys = orderKeys(Object.keys(base), Object.keys(current), Object.keys(incoming));
    const value: Record<string, unknown> = {};
    const conflicts: JsonConflict[] = [];
    for (const key of keys) {
        const merged = mergeJson(own(base, key), own(current, key), own(incoming, key), options, [...path, key]);
        conflicts.push(...merged.conflicts);
        if (!missing(merged.value)) value[key] = merged.value;
    }
    return {value, conflicts};
}

function mergeKeyedArrays(base: unknown[], current: unknown[], incoming: unknown[], key: (item: unknown) => string | undefined,
    options: JsonMergeOptions, path: JsonPath): JsonMergeResult {
    const index = (items: unknown[]) => new Map(items.map(item => [key(item)!, item]));
    const [baseItems, currentItems, incomingItems] = [index(base), index(current), index(incoming)];
    const keys = orderKeys([...baseItems.keys()], [...currentItems.keys()], [...incomingItems.keys()]);
    const value: unknown[] = [];
    const conflicts: JsonConflict[] = [];
    for (const name of keys) {
        const merged = mergeJson(baseItems.get(name), currentItems.get(name), incomingItems.get(name), options, [...path, name]);
        conflicts.push(...merged.conflicts);
        if (!missing(merged.value)) value.push(merged.value);
    }
    return {value, conflicts};
}

function uniqueKeys(items: unknown[], key: (item: unknown) => string | undefined) {
    const seen = new Set<string>();
    for (const item of items) {
        const name = key(item);
        if (name === undefined || seen.has(name)) return false;
        seen.add(name);
    }
    return true;
}

const own = (record: Record<string, unknown>, key: string) => Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * The current side's order, then each incoming addition after its predecessor on the incoming side, then base-only
 * keys (which survive only as conflicts) after their predecessor on the base side.
 */
export function orderKeys(base: readonly string[], current: readonly string[], incoming: readonly string[]): string[] {
    const order = [...current];
    const place = (keys: readonly string[]) => {
        keys.forEach((key, position) => {
            if (order.includes(key)) return;
            let before = position - 1;
            while (before >= 0 && !order.includes(keys[before])) before--;
            order.splice(before < 0 ? 0 : order.indexOf(keys[before]) + 1, 0, key);
        });
    };
    place(incoming);
    place(base);
    return order;
}

/** Reads the value at `path`. A string step into an array selects the element whose key is that string. */
export function readJsonPath(root: unknown, path: JsonPath, key: (item: unknown) => string | undefined = defaultKey): unknown {
    let value = root;
    for (const step of path) {
        if (Array.isArray(value)) value = typeof step === 'number' ? value[step] : value.find(item => key(item) === step);
        else if (isRecord(value) && typeof step === 'string') value = own(value, step);
        else return undefined;
    }
    return value;
}

/**
 * Sets (or, for `undefined`, removes) the value at `path`, creating missing objects on the way. A keyed array element
 * that does not exist yet is appended.
 */
export function writeJsonPath(root: unknown, path: JsonPath, next: unknown,
    key: (item: unknown) => string | undefined = defaultKey): void {
    if (!path.length) throw new Error('Cannot replace the root of a JSON document.');
    let container = root;
    for (const step of path.slice(0, -1)) {
        let child = readJsonPath(container, [step], key);
        if (child === undefined) {
            child = {};
            if (isRecord(container) && typeof step === 'string') container[step] = child;
            else throw new Error(`Missing JSON path step ${String(step)}.`);
        }
        container = child;
    }
    const last = path[path.length - 1];
    if (Array.isArray(container)) {
        const position = typeof last === 'number' ? last : container.findIndex(item => key(item) === last);
        if (next === undefined) {
            if (position >= 0 && position < container.length) container.splice(position, 1);
        } else if (position >= 0 && position < container.length) container[position] = next;
        else container.push(next);
    } else if (isRecord(container) && typeof last === 'string') {
        if (next === undefined) delete container[last];
        else container[last] = next;
    } else {
        throw new Error(`Cannot write JSON path step ${String(last)}.`);
    }
}

/** Elements of keyed arrays are named by `id`, or by `name` when they have no `id`. */
export function defaultKey(item: unknown): string | undefined {
    if (!isRecord(item)) return undefined;
    if (typeof item.id === 'string') return item.id;
    return typeof item.name === 'string' ? item.name : undefined;
}
