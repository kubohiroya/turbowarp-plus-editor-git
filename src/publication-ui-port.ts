import type {PublicationRepository} from './publish-ref.js';
import type {MergeCondition, PublicationIntent, PublicationJob, PullRequestObservation} from './pull-request-queue.js';

export interface PreparedPublication extends PublicationRepository {
    capabilities: readonly string[];
    progress(): {job: PublicationJob | null; running: boolean; approvalIntent?: PublicationIntent; error?: unknown};
    subscribe(listener: () => void): () => void;
    submit(draft: Pick<PublicationIntent, 'base' | 'title' | 'body' | 'goal'>, current: () => boolean): Promise<boolean>;
    approvePending?(current: () => boolean): Promise<boolean>;
    resume(): void;
}

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
