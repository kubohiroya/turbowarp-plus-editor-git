import type {MergePlanJournal, MergePlanScope} from './merge-plan-journal.js';
import type {MergePlan} from './merge-plan.js';
import type {PlaytestObserver, PlaytestReadRequest, ReadPlaytest} from './merge-playtest-observation.js';

type ReadMergePlan = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface MergePlanSharePort {
    start(project: {repository: string; folder: string},
        read: ReadMergePlan):
        Promise<{url: string; token: string} | null>;
    stop(token: string): Promise<void>;
}

const pageSize = (args: Record<string, unknown>, fallback: number, maximum: number) => {
    const {offset = 0, limit = fallback} = args;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
        typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
        throw new Error('Invalid page range.');
    }
    return {offset, limit};
};

const describe = ({id, planId, previousId, copiedFrom, contentId, createdAt, inputs, conflicts, choices, problems, edited}:
    MergePlan, generation: number) =>
    ({generationId: id, planId, previousId, copiedFrom, contentId, generation, createdAt, inputs,
        conflicts, choices, problems, edited: Boolean(edited)});

export function createMergePlanPlaytest() {
    type Session = {sessionId: string; planId: string; generationId: string; contentId: string; startedAt: number};
    let active: {session: Session; read: ReadPlaytest} | null = null;
    const empty = () => ({playtest: null, observedAt: Date.now()});
    return {
        async current(expected: unknown, query: PlaytestReadRequest) {
            const current = active;
            if (expected !== undefined && current?.session.sessionId !== expected) throw new Error('The playtest session has ended.');
            if (!current) return empty();
            const observation = await current.read(query).catch(error => {
                if (active || expected !== undefined) throw error;
            });
            if (!active && expected === undefined) return empty();
            if (active !== current) throw new Error('The playtest session has ended.');
            return {playtest: current.session, observation, observedAt: Date.now()};
        },
        observe(plan: MergePlan): PlaytestObserver {
            const {id: generationId, planId, contentId} = plan;
            const sessionId = crypto.randomUUID();
            return read => {
                if (read) active = {session: {sessionId, planId, generationId, contentId, startedAt: Date.now()}, read};
                else if (active?.session.sessionId === sessionId) active = null;
            };
        }
    };
}

/** Access only immutable journal snapshots for the captured project. File names are keys, never filesystem paths. */
export function createMergePlanReader(journal: MergePlanJournal, scope: MergePlanScope & {guard(): void},
    playtest: ReturnType<typeof createMergePlanPlaytest>): ReadMergePlan {
    const project = {repository: scope.root.name, folder: scope.folder};
    return async (tool: string, args: Record<string, unknown>) => {
        scope.guard();
        if (tool === 'merge_plan_current_playtest') {
            const {sessionId, variables, logLimit} = args;
            const observation = await playtest.current(sessionId, {variables, logLimit} as PlaytestReadRequest);
            scope.guard();
            return {project, ...observation};
        }
        const plans = await journal.list(scope);
        scope.guard();
        const counts = new Map<string, number>();
        const generations = plans.map(plan => {
            const generation = (counts.get(plan.planId) ?? 0) + 1;
            counts.set(plan.planId, generation);
            return describe(plan, generation);
        });
        if (tool === 'merge_plan_list_generations') {
            const {offset, limit} = pageSize(args, 50, 100);
            return {project, generations: generations.slice(offset, offset + limit),
                nextOffset: offset + limit < generations.length ? offset + limit : null};
        }
        const index = plans.findIndex(plan => plan.id === args.generationId);
        if (index < 0) throw new Error('Generation is unavailable in this project.');
        const files = await journal.files(plans[index]);
        scope.guard();
        if (tool === 'merge_plan_get_generation') {
            const {offset, limit} = pageSize(args, 100, 200);
            const paths = [...files.keys()].sort();
            return {project, generation: generations[index],
                files: paths.slice(offset, offset + limit).map(path => ({path, size: files.get(path)!.byteLength})),
                nextOffset: offset + limit < paths.length ? offset + limit : null};
        }
        if (tool !== 'merge_plan_read_file' || typeof args.path !== 'string') throw new Error('Unknown read request.');
        const bytes = files.get(args.path);
        if (!bytes) throw new Error('File is unavailable in this generation.');
        const {offset, limit} = pageSize(args, 24_576, 32_768);
        if (offset > bytes.byteLength) throw new Error('Offset is past the end of the file.');
        const chunk = bytes.subarray(offset, offset + limit);
        let encoding = 'utf8';
        let data: string;
        try {
            data = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(chunk);
            if (data.includes('\0')) throw new Error('Binary contents');
        } catch {
            encoding = 'base64';
            data = btoa(Array.from(chunk, byte => String.fromCharCode(byte)).join(''));
        }
        return {project, generationId: plans[index].id, contentId: plans[index].contentId, path: args.path,
            offset, nextOffset: offset + chunk.length < bytes.byteLength ? offset + chunk.length : null, encoding, data};
    };
}
