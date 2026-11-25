import type {MergePlanJournal, MergePlanScope} from './merge-plan-journal.js';
import {summarizeMergePlanTest, type MergePlaytestCapture} from './merge-plan-sharing.js';
import type {MergePlan, MergePlanFiles} from './merge-plan.js';
import {isRecord} from './project-source-patch.js';
import {parseSourceProject} from './project-source-merge.js';

export const playtestRecordVariableLimit = 16;
export const playtestRecordNoteLimit = 2000;

type Variable = {id: string; name: string; target: string; kind: 'variable' | 'list'};
type DirectoryPicker = () => Promise<FileSystemDirectoryHandle>;

export interface PlaytestRecordPort {
    variables: readonly Variable[];
    save(input: {variableIds: readonly string[]; includeLogs: boolean; note: string}):
        Promise<{filename: string; folder: string} | undefined>;
}

export class PlaytestRecordError extends Error {
    constructor(readonly code: 'insideWorktree' | 'captureUnavailable') {
        super(code);
    }
}

export function playtestRecordPicker(document: Document): DirectoryPicker | undefined {
    const view = document.defaultView as (Window & {
        showDirectoryPicker?(options: {id: string; mode: 'readwrite'}): Promise<FileSystemDirectoryHandle>;
    }) | null;
    if (!view?.showDirectoryPicker) return undefined;
    return () => view.showDirectoryPicker!({id: 'turbowarp-plus-playtest-records', mode: 'readwrite'});
}

function candidateVariables(files: MergePlanFiles) {
    const source = files.get('project.source.json');
    const project = source && parseSourceProject(new TextDecoder('utf-8', {fatal: true}).decode(source));
    const variables: Variable[] = [];
    for (const {variables: values, lists, name: target} of project?.targets ?? []) {
        for (const [kind, entries] of [['variable', values], ['list', lists]] as const) {
            if (!isRecord(entries)) continue;
            for (const [id, value] of Object.entries(entries)) {
                if (Array.isArray(value) && typeof value[0] === 'string') variables.push({id, name: value[0], target, kind});
            }
        }
    }
    return variables;
}

async function writeRecord(folder: FileSystemDirectoryHandle, filename: string, contents: string) {
    try {
        await folder.getFileHandle(filename);
        throw new Error('A record already exists at this path.');
    } catch (error) {
        if ((error as DOMException).name !== 'NotFoundError') throw error;
    }
    const file = await folder.getFileHandle(filename, {create: true});
    let stream: FileSystemWritableFileStream | undefined;
    try {
        stream = await file.createWritable();
        await stream.write(contents);
        await stream.close();
    } catch (error) {
        await stream?.abort().catch(() => {});
        await folder.getFileHandle(filename).then(async current => {
            if (await current.isSameEntry(file)) await folder.removeEntry(filename);
        }).catch(() => {});
        throw error;
    }
}

export function createPlaytestRecordPort(scope: MergePlanScope & {guard(): void}, plan: MergePlan, files: MergePlanFiles,
    journal: MergePlanJournal, capture: MergePlaytestCapture, pick: DirectoryPicker): PlaytestRecordPort {
    const variables = candidateVariables(files);
    const allowed = new Set(variables.map(({id}) => id));
    return {
        variables,
        async save({variableIds, includeLogs, note}) {
            scope.guard();
            const directory = await pick().catch(error => {
                if ((error as DOMException).name !== 'AbortError') throw error;
            });
            if (!directory) return undefined;
            // Check on the handles, including the repository root itself and projects nested under it.
            const paths = await Promise.all([scope.root.resolve(directory), directory.resolve(scope.root)]);
            if (paths.some(path => path !== null)) throw new PlaytestRecordError('insideWorktree');
            scope.guard();
            const ids = [...new Set(variableIds)];
            if (ids.length > playtestRecordVariableLimit || ids.some(id => !allowed.has(id))) {
                throw new PlaytestRecordError('captureUnavailable');
            }
            const snapshot = await capture({
                variables: ids.map(id => ({id})), logLimit: includeLogs ? 20 : 0
            }).catch(() => {throw new PlaytestRecordError('captureUnavailable');});
            if (snapshot.playtest?.generationId !== plan.id || snapshot.playtest.contentId !== plan.contentId ||
                !('observation' in snapshot) || !isRecord(snapshot.observation)) {
                throw new PlaytestRecordError('captureUnavailable');
            }
            const latestTest = await journal.testResult(plan).then(
                result => ({status: 'available', result: summarizeMergePlanTest(result)}),
                () => ({status: 'unavailable'}));
            scope.guard();
            const recordId = crypto.randomUUID();
            const filename = `merge-playtest-${recordId}.json`;
            await writeRecord(directory, filename, JSON.stringify({
                formatVersion: 1, kind: 'merge-plan-playtest-observation', recordId,
                project: {repository: scope.root.name, folder: scope.folder},
                ...snapshot, requested: {variables: ids, logLimit: includeLogs ? 20 : 0},
                note: note.trim().slice(0, playtestRecordNoteLimit), latestTest
            }, null, 2) + '\n');
            return {filename, folder: directory.name};
        }
    };
}
