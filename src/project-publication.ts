import type {PublicationIntent, PublicationJob as QueuePublicationJob, PublicationStackParent} from './pull-request-queue.js';
import type {PublicationRepository} from './pull-request-queue.js';
import type {PullRequestMergePort} from './publication-ui-port.js';

export type PublicationTarget = Pick<PublicationIntent, 'id' | 'remote' | 'repositoryId'>;
export type PublicationDraft = Pick<PublicationIntent, 'base' | 'title' | 'body' | 'goal' | 'issue' | 'stackParent'>;
export type PublicationIssue = NonNullable<PublicationIntent['issue']>;
export type PublicationJob = QueuePublicationJob & {awaitingPush?: boolean; pushAccount?: string; pushSessionId?: string};
export type {PublicationIntent, PublicationRepository, PublicationStackParent} from './pull-request-queue.js';

export interface PublicationPushSession {
    connection: {mode: string; proxyOrigin: string};
    account: {login: string};
    bearer: string;
    expiresAt: number;
    repositoryId?: number;
}

export type ReadPublicationPushSession<Session extends PublicationPushSession> =
    (remote?: string, write?: boolean) => Promise<Session | null>;

/** Every Git HTTP request must use the session which authorized this particular push. */
export function pinPublicationPushSession<Session extends PublicationPushSession>(
    getSession: ReadPublicationPushSession<Session>, remote: string, expected: Session
): ReadPublicationPushSession<Session> {
    return async (target, write) => {
        if (target !== remote || write !== true || expected.expiresAt <= Date.now()) return null;
        const active = await getSession(remote, true);
        return active && active.bearer === expected.bearer && active.connection.mode === expected.connection.mode &&
            active.connection.proxyOrigin === expected.connection.proxyOrigin &&
            active.account.login.toLowerCase() === expected.account.login.toLowerCase() &&
            active.repositoryId === expected.repositoryId && active.expiresAt > Date.now() && expected.expiresAt > Date.now() ?
            expected : null;
    };
}

export async function bindDesktopPublicationPushSession<Session extends PublicationPushSession>(
    getSession: ReadPublicationPushSession<Session>, remote: string, job: PublicationJob
) {
    if (!job.pushAccount || !/^[a-f0-9]{64}$/u.test(job.pushSessionId ?? '')) throw new Error('SESSION_REQUIRED');
    const expected = await getSession(remote, true);
    if (!expected || expected.connection.mode !== 'desktop' || expected.expiresAt <= Date.now() ||
        expected.account.login.toLowerCase() !== job.pushAccount.toLowerCase()) throw new Error('SESSION_REQUIRED');
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expected.bearer));
    const id = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    if (id !== job.pushSessionId) throw new Error('SESSION_REQUIRED');
    return pinPublicationPushSession(getSession, remote, expected);
}

/** What the host provides; merging is the same port the Git panel's pull request views use. */
export interface PublicationBridge extends PullRequestMergePort {
    capabilities?(): Promise<readonly string[]>;
    repository(remote: string): Promise<{repositoryId: number; capabilities?: readonly string[]}>;
    stackParent?(remote: string, number: number, repositoryId: number): Promise<PublicationStackParent | null>;
    enqueue(intent: PublicationIntent, current?: () => boolean): Promise<PublicationJob | null>;
    get(target: PublicationTarget): Promise<PublicationJob | {
        job: PublicationJob | null; approvalIntent?: PublicationIntent;
    } | null>;
    advance(target: PublicationTarget & {retryRejectedMerge?: boolean}): Promise<PublicationJob>;
    approval?: 'browser';
}

export type DesktopPublicationBridge = PublicationBridge;

export interface PublicationCommit {
    id: string;
    message: string;
    commitOid: string;
}

export interface PublicationProgress {
    job: PublicationJob | null;
    running: boolean;
    approvalIntent?: PublicationIntent;
    error?: unknown;
}

export interface PreparedPublication extends PublicationRepository {
    capabilities: readonly string[];
    head: string;
    stackParent?(number: number): Promise<PublicationStackParent | null>;
    approval?: PublicationBridge['approval'];
    progress(): PublicationProgress;
    subscribe(listener: () => void): () => void;
    submit(draft: PublicationDraft, current: () => boolean): Promise<boolean>;
    approvePending?(current: () => boolean): Promise<boolean>;
    resume(retryRejectedMerge?: boolean): void;
}

export interface ProjectPublicationPort {
    prepare(commit: PublicationCommit): Promise<PreparedPublication>;
}

const canonicalRemote = (value: string) => value.toLowerCase().replace(/(?:\.git)?$/u, '.git');
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const sameIssue = (left: PublicationIssue | undefined, right: PublicationIssue | undefined) => {
    if (!left || !right) return left === right;
    if (left.closeAfterMerge !== right.closeAfterMerge) return false;
    if ('number' in left) return 'number' in right && left.number === right.number;
    return !('number' in right) && left.title === right.title && left.body === right.body;
};

/** Drive host checkpoints independently of the dialog; a reopened dialog reads the host's durable job. */
export function createProjectPublication({bridge, inspect, push, guard, delay = wait}: {
    bridge: PublicationBridge;
    inspect(): Promise<PublicationRepository>;
    push(options: {remote: string; oid: string; ref: string}, job: PublicationJob): Promise<void>;
    guard(): void;
    delay?(milliseconds: number): Promise<void>;
}): ProjectPublicationPort {
    type Entry = {state: PublicationProgress; listeners: Set<() => void>};
    const entries = new Map<string, Entry>();
    return {
        async prepare(commit) {
            guard();
            const repository = await inspect();
            const {repositoryId, capabilities: available} = await bridge.repository(repository.remote);
            const capabilities = available ?? await bridge.capabilities?.() ?? [];
            guard();
            const target = {id: commit.id, remote: repository.remote, repositoryId};
            const head = 'tw-plus/pr-' + commit.id;
            const key = repositoryId + ':' + commit.id;
            const entry = entries.get(key) ?? {state: {job: null, running: false}, listeners: new Set<() => void>()};
            entries.set(key, entry);
            const update = (state: PublicationProgress) => {
                entry.state = state;
                for (const listener of entry.listeners) listener();
            };
            const checkIntent = (intent: PublicationIntent) => {
                guard();
                if (intent.id !== target.id || intent.repositoryId !== target.repositoryId ||
                    canonicalRemote(intent.remote) !== canonicalRemote(target.remote) ||
                    intent.head !== head || intent.commitOid !== commit.commitOid) {
                    throw new Error('PUBLICATION_CHANGED');
                }
                return intent;
            };
            const check = (job: PublicationJob) => {
                checkIntent(job.intent);
                return job;
            };
            async function readProgress(): Promise<PublicationProgress> {
                const saved = await bridge.get(target);
                guard();
                if (!saved) return {job: null, running: false};
                if ('intent' in saved) return {job: check(saved), running: false};
                return {job: saved.job ? check(saved.job) : null, running: false,
                    approvalIntent: saved.approvalIntent ? checkIntent(saved.approvalIntent) : undefined};
            }
            if (!entry.state.running) {
                const before = entry.state;
                const saved = await readProgress();
                if (entry.state === before) update(saved);
            }

            async function drive(retryRejectedMerge: boolean) {
                let pollInterval = 30_000;
                let pushed = false;
                let retry = retryRejectedMerge;
                for (;;) {
                    guard();
                    let job = check(await bridge.advance({...target, retryRejectedMerge: retry}));
                    retry = false;
                    update({job, running: true});
                    if (job.awaitingPush) {
                        if (pushed) throw new Error('PUSH_UNCONFIRMED');
                        pushed = true;
                        try {
                            await push({remote: target.remote, oid: job.intent.commitOid, ref: 'refs/heads/' + job.intent.head}, job);
                            continue;
                        } catch (error) {
                            guard();
                            if (error instanceof Error && ['SESSION_REQUIRED', 'session'].includes(error.message)) throw error;
                            // A lost push response may still leave the expected ref on GitHub.
                            job = check(await bridge.advance(target));
                            if (job.awaitingPush) throw error;
                            update({job, running: true});
                        }
                    }
                    if (job.status === 'done' || job.pause) return;
                    if (job.status === 'waiting' || job.status === 'waitingForParent' || job.status === 'merging') {
                        await delay(pollInterval);
                        pollInterval = Math.min(300_000, pollInterval * 2);
                    } else pollInterval = 30_000;
                }
            }

            function resume(retryRejectedMerge = false) {
                if (entry.state.running || !entry.state.job || entry.state.job.status === 'done') return;
                update({job: entry.state.job, running: true});
                void drive(retryRejectedMerge).then(
                    () => update({job: entry.state.job, running: false}),
                    async error => {
                        if (bridge.approval === 'browser' && error instanceof Error && error.message === 'APPROVAL_REQUIRED') {
                            const saved = await readProgress().catch(() => null);
                            if (saved?.approvalIntent) {update(saved); return;}
                        }
                        update({job: entry.state.job, running: false, error});
                    }
                );
            }

            const parents = new Map<number, PublicationStackParent>();
            const findStackParent = bridge.stackParent;
            const stackParent = findStackParent && capabilities.includes('stacks') ? async (number: number) => {
                guard();
                if (!Number.isSafeInteger(number) || number < 1) return null;
                const parent = await findStackParent(repository.remote, number, repositoryId);
                guard();
                const advertised = parent && repository.branches.find(branch => branch.name === parent.head);
                if (!parent || parent.number !== number || !advertised || advertised.oid !== parent.headOid ||
                    parent.head === head || parent.headOid === commit.commitOid) return null;
                parents.set(number, Object.freeze({...parent}));
                return parents.get(number) ?? null;
            } : undefined;

            async function submitIntent(intent: PublicationIntent, current: () => boolean) {
                let job = await bridge.enqueue(intent, current);
                if (!job && bridge.approval === 'browser' && current()) {
                    const pending = await readProgress();
                    if (pending.approvalIntent) update(pending);
                    job = pending.job;
                }
                if (!job) return false;
                const approved = check(job);
                if (approved.intent.base !== intent.base || approved.intent.baseOid !== intent.baseOid ||
                    approved.intent.title !== intent.title || approved.intent.body !== intent.body ||
                    approved.intent.goal !== intent.goal || Boolean(approved.intent.allowNoChecks) !== Boolean(intent.allowNoChecks) ||
                    !sameIssue(approved.intent.issue, intent.issue) ||
                    approved.intent.stackParent?.number !== intent.stackParent?.number ||
                    approved.intent.stackParent?.head !== intent.stackParent?.head ||
                    approved.intent.stackParent?.headOid !== intent.stackParent?.headOid ||
                    approved.intent.stackParent?.targetBase !== intent.stackParent?.targetBase ||
                    approved.intent.stackParent?.stackNumber !== intent.stackParent?.stackNumber) {
                    throw new Error('PUBLICATION_CHANGED');
                }
                if (!entry.state.running) {
                    update({job: approved, running: false});
                    resume();
                }
                return true;
            }

            return {
                ...repository, capabilities, head, stackParent, approval: bridge.approval,
                progress: () => entry.state,
                subscribe(listener) {
                    entry.listeners.add(listener);
                    return () => {entry.listeners.delete(listener);};
                },
                async submit(draft, current) {
                    guard();
                    if (!current()) return false;
                    if (draft.stackParent && draft.stackParent !== parents.get(draft.stackParent.number))
                        throw new Error('PUBLICATION_STACK_PARENT');
                    const base = repository.branches.find(branch => branch.name === draft.base);
                    if (!base || base.name === head || base.oid === commit.commitOid ||
                        draft.stackParent && (draft.stackParent.head !== base.name || draft.stackParent.headOid !== base.oid)) {
                        throw new Error('PUBLICATION_BASE');
                    }
                    return submitIntent({...draft, ...target, head, baseOid: base.oid, commitOid: commit.commitOid}, current);
                },
                approvePending: bridge.approval === 'browser' ? current => {
                    guard();
                    const intent = entry.state.approvalIntent;
                    return current() && intent ? submitIntent({...checkIntent(intent), remote: target.remote}, current) : Promise.resolve(false);
                } : undefined,
                resume
            };
        }
    };
}
