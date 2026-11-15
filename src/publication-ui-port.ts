import type {PreparedPublication} from './project-publication.js';
import type {MergeCondition, PullRequestObservation} from './pull-request-queue.js';

// The port the Editor's publication flow implements; the panel reads only part of it.
export type {PreparedPublication} from './project-publication.js';

export interface PullRequestMergePort {
    pullRequestChecks?(remote: string, number: number, signal?: AbortSignal):
        Promise<{head: string; base: string; checks: PullRequestObservation['checks']}>;
    mergeStatus?(remote: string, number: number, signal?: AbortSignal): Promise<PullRequestObservation>;
    mergePullRequest?(remote: string, expected: MergeCondition): Promise<{state: 'accepted' | 'merged' | 'rejected'}>;
}

export interface PullRequestPublication extends PullRequestMergePort {
    prepare(options: {root: FileSystemDirectoryHandle; guard(): void;
        commit: {id: string; message: string; commitOid: string}}): Promise<PreparedPublication>;
}
