import type {PlaytestStop} from './merge-playtest.js';

export interface PlaytestReadRequest {
    variables?: {id: string; targetId?: string; offset?: number}[];
    logLimit?: number;
}

export type ReadPlaytest = (request: PlaytestReadRequest) => Promise<unknown>;
export type PlaytestObserver = (read: ReadPlaytest | null) => void;

export interface ObservationTarget {
    id: string;
    isOriginal: boolean;
    getName(): string;
    variables: Record<string, {name: string; type: string; value: unknown}>;
}

interface ObservationThread {
    topBlock: string;
    target: ObservationTarget;
    peekStack(): string | null | undefined;
    updateMonitor?: boolean;
    status?: number;
}

interface ObservationVM {
    runtime: {targets: ObservationTarget[]; threads: ObservationThread[]};
}

export interface PlaytestDebugger {
    paused(): boolean;
    thread(): ObservationThread | null | undefined;
    logs(limit: number): readonly {
        text: unknown; type: string; count: number; internal?: boolean; blockId?: string; targetId?: string;
    }[] | undefined;
}

const debuggers = new WeakMap<object, PlaytestDebugger>();
const threadDone = 4; // Scratch VM Thread.STATUS_DONE.
export const registerPlaytestDebugger = (vm: object, port: PlaytestDebugger) => {debuggers.set(vm, port);};

function scalar(value: unknown): {value: boolean | number | string | null; truncated?: boolean; unavailable?: boolean} {
    if (typeof value === 'string') {
        return {value: value.slice(0, 1024), ...(value.length > 1024 && {truncated: true})};
    }
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return {value};
    if (typeof value === 'number') return {value: String(value)};
    return {value: null, unavailable: true};
}

function readValue(targets: readonly ObservationTarget[],
    query: NonNullable<PlaytestReadRequest['variables']>[number]) {
    const {id, targetId, offset = 0} = query;
    const candidates = targetId === undefined ? targets.filter(target => target.isOriginal) :
        targets.filter(target => target.id === targetId);
    const matches = candidates.filter(target => Object.hasOwn(target.variables, id));
    if (matches.length !== 1) return {id, targetId, status: matches.length ? 'ambiguous' : 'missing'};
    const target = matches[0];
    const {name, type, value} = target.variables[id];
    const metadata = {id, name, target: target.getName(), targetId: target.id};
    if (type === '' && offset === 0) return {...metadata, status: 'available', type: 'variable', ...scalar(value)};
    if (type !== 'list' || !Array.isArray(value)) return {...metadata, status: 'unavailable'};
    const items = value.slice(offset, offset + 32).map(scalar);
    return {...metadata, status: 'available', type: 'list', items, length: value.length,
        offset, nextOffset: offset + items.length < value.length ? offset + items.length : null};
}

/** Build one plain-data sample, without advancing the VM, taking a save snapshot or changing debugger state. */
export function readPlaytestObservation(vm: ObservationVM, request: PlaytestReadRequest,
    conflict?: {stop: PlaytestStop; thread: ObservationThread}, modifiedInPlayer = false) {
    const {targets, threads} = vm.runtime;
    const port = debuggers.get(vm);
    const live = (thread: ObservationThread | null | undefined): thread is ObservationThread =>
        Boolean(thread && threads.includes(thread) && !thread.updateMonitor && thread.status !== threadDone);
    const conflictThread = live(conflict?.thread) ? conflict.thread : undefined;
    const paused = port?.paused();
    const stepThread = paused ? port?.thread() : undefined;
    const thread = conflictThread ?? (live(stepThread) ? stepThread : undefined);
    const blockId = conflictThread ? conflict!.stop.next : thread?.peekStack();
    const running = threads.some(live);
    const limit = request.logLimit ?? 20;
    const rows = limit ? port?.logs(limit) : undefined;
    return {
        observedAt: Date.now(),
        state: running ? (conflictThread || paused ? 'paused' : 'running') : 'idle',
        modifiedInPlayer,
        stop: thread && blockId ? {
            reason: conflictThread ? 'merge-conflict' : 'breakpoint',
            target: thread.target.getName(), targetId: thread.target.id,
            threadIndex: threads.indexOf(thread), topBlockId: thread.topBlock, blockId,
            ...(conflictThread && {focusBlockId: conflict!.stop.focus, lastExecutedBlockId: conflict!.stop.previous,
                ...(conflict!.stop.conflictId && {conflictId: conflict!.stop.conflictId})})
        } : null,
        values: (request.variables ?? []).map(query => readValue(targets, query)),
        logs: {
            status: !limit ? 'omitted' : rows ? 'available' : 'unavailable',
            entries: rows?.map(({text, type, count, internal, blockId, targetId}) => {
                const {value, truncated, unavailable} = scalar(text);
                return {type, count, internal: Boolean(internal), blockId, targetId, message: value, truncated, unavailable};
            }) ?? []
        }
    };
}
