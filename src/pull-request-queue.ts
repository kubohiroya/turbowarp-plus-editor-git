import {remoteUrl} from './smart-http.js';
export {inspectPublicationRepository, pushPublicationCommit} from './publish-ref.js';
export type {PublicationRepository} from './publish-ref.js';

type Goal = 'pr' | 'merge';
type IssueChoice = {number: number; closeAfterMerge: boolean} |
    {title: string; body: string; closeAfterMerge: boolean};

export interface PublicationIntent {
    /** The local commit job ID, retained across restarts. */
    id: string;
    remote: string;
    repositoryId: number;
    head: string;
    base: string;
    baseOid: string;
    commitOid: string;
    title: string;
    body: string;
    goal: Goal;
    /** Optional, independent approval for a repository with no check runs or statuses. */
    allowNoChecks?: boolean;
    issue?: IssueChoice;
}

export interface PullRequestReference {
    number: number;
    repositoryId: number;
    headRepositoryId: number;
    head: string;
    base: string;
    headOid: string;
    baseOid: string;
    body: string;
}

export interface PullRequestObservation extends PullRequestReference {
    state: 'open' | 'closed' | 'merged';
    checks: 'pending' | 'failed' | 'passed' | 'absent' | 'unknown';
    review: 'approved' | 'changesRequested' | 'required' | 'none' | 'unknown';
    mergeable: 'ready' | 'blocked' | 'conflicting' | 'unknown';
    /** Digest of the complete GitHub diff for this pair of refs, or null when it cannot be verified. */
    diffDigest: string | null;
    mergeOid?: string;
    /** True when an asynchronous merge can also apply other PRs. */
    downstackOpen?: boolean;
    closesOtherIssues?: boolean;
}

interface MergeCondition {
    number: number;
    head: string;
    base: string;
    headOid: string;
    baseOid: string;
    diffDigest: string;
    allowNoChecks: boolean;
}

export interface PullRequestPublicationPort {
    branchOid(branch: string): Promise<string | null>;
    /** Creates the job-owned ref only, or succeeds if it already points at the requested OID. */
    pushCommit(oid: string, ref: string): Promise<void>;
    findPullRequests(head: string): Promise<readonly PullRequestReference[]>;
    createPullRequest(draft: {head: string; base: string; title: string; body: string}): Promise<PullRequestReference>;
    observePullRequest(number: number): Promise<PullRequestObservation>;
    /** The privileged implementation rechecks the supplied condition immediately before the merge request. */
    mergePullRequest(expected: MergeCondition): Promise<{state: 'accepted' | 'merged' | 'rejected'; requestId?: string}>;
    observeMergeRequest?(number: number, requestId: string): Promise<'pending' | 'enqueued' | 'merged' | 'failed'>;
    readIssue?(number: number): Promise<{number: number; state: 'open' | 'closed'} | null>;
    findIssues?(marker: string): Promise<readonly {number: number; body: string}[]>;
    createIssue?(draft: {title: string; body: string}): Promise<{number: number; body: string}>;
    closeIssue?(number: number): Promise<void>;
}

export type PublicationStatus = 'queued' | 'pushed' | 'creatingIssue' | 'issueReady' | 'creatingPull' |
    'waiting' | 'ready' | 'merging' | 'merged' | 'done';
export type PublicationPause = 'baseChanged' | 'headChanged' | 'issueUnknown' | 'pullUnknown' | 'issueUnavailable' |
    'pullClosed' | 'comparisonUnavailable' | 'checksFailed' | 'noChecks' | 'reviewChanges' | 'conflicting' |
    'downstack' | 'closingIssues' | 'mergeRejected' | 'mergeUnknown' | 'requestFailed';

export interface PublicationJob {
    intent: PublicationIntent;
    status: PublicationStatus;
    issueNumber?: number;
    pullNumber?: number;
    diffDigest?: string;
    mergeOid?: string;
    mergeRequestId?: string;
    mergeAccepted?: boolean;
    noChecksApproved?: boolean;
    pause?: PublicationPause;
}

export interface PublicationJournal {
    exclusive<T>(key: string, action: () => Promise<T>): Promise<T>;
    get(key: string): Promise<PublicationJob | undefined>;
    put(key: string, value: PublicationJob): Promise<void>;
}

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const isOid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const branchName = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,249}$/u.test(value) &&
    !value.includes('..') && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock')) &&
    !value.endsWith('.');
const markerFor = (kind: 'issue' | 'pull', id: string) => `<!-- tw-plus-${kind}:${id} -->`;
const withMarker = (body: string, marker: string) => body.trimEnd() + '\n\n' + marker;
const description = (title: string, body: string) =>
    typeof title === 'string' && typeof body === 'string' &&
    Boolean(title.trim()) && title.length <= 256 && !/[\x00-\x1f]/u.test(title) &&
    new TextEncoder().encode(body).byteLength <= 62_000 && !body.includes('<!-- tw-plus-');
const closingKeyword = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\b\s*:?\s+(?:(?:[\w.-]+\/[\w.-]+)?#\d+|https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+)/iu;

export function validatePublicationIntent(intent: PublicationIntent): PublicationIntent {
    if (!uuid.test(intent.id) || !positive(intent.repositoryId) || !isOid(intent.baseOid) || !isOid(intent.commitOid) ||
        intent.head !== 'tw-plus/pr-' + intent.id || !branchName(intent.base) || intent.base === intent.head ||
        !description(intent.title, intent.body) || !['pr', 'merge'].includes(intent.goal) ||
        (intent.allowNoChecks !== undefined && typeof intent.allowNoChecks !== 'boolean') ||
        closingKeyword.test(intent.title) || closingKeyword.test(intent.body)) {
        throw new TypeError('Invalid publication intent');
    }
    const issue = intent.issue;
    if (issue && (typeof issue.closeAfterMerge !== 'boolean' ||
        ('number' in issue ? !positive(issue.number) : !description(issue.title, issue.body)))) {
        throw new TypeError('Invalid issue choice');
    }
    const {id, repositoryId, head, base, baseOid, commitOid, title, body, goal, allowNoChecks} = intent;
    const chosen = issue && ('number' in issue ? {number: issue.number, closeAfterMerge: issue.closeAfterMerge} :
        {title: issue.title, body: issue.body, closeAfterMerge: issue.closeAfterMerge});
    return {id, remote: remoteUrl(intent.remote), repositoryId, head, base, baseOid, commitOid, title, body, goal,
        allowNoChecks, issue: chosen};
}

/** Advance a durable publication one checkpoint at a time. The host can schedule polls without holding the local Git lock. */
export function createPullRequestQueue({journal, repository, port}: {
    journal: PublicationJournal;
    repository: {remote: string; id: number};
    port: PullRequestPublicationPort;
}) {
    const remote = remoteUrl(repository.remote);
    const repositoryId = repository.id;
    if (!positive(repositoryId)) throw new TypeError('Invalid repository ID');
    const keyFor = (id: string) => {
        if (!uuid.test(id)) throw new TypeError('Invalid job ID');
        return repositoryId + ':' + remote + ':' + id;
    };

    async function enqueue(input: PublicationIntent): Promise<PublicationJob> {
        const intent = validatePublicationIntent(input);
        if (intent.remote !== remote || intent.repositoryId !== repositoryId) throw new TypeError('Wrong repository');
        const key = keyFor(intent.id);
        return journal.exclusive(key, async () => {
            if (await journal.get(key)) throw new Error('Publication already queued');
            const job: PublicationJob = {intent, status: 'queued'};
            await journal.put(key, job);
            return job;
        });
    }

    async function advance(id: string, {retryRejectedMerge = false} = {}): Promise<PublicationJob> {
        const key = keyFor(id);
        return journal.exclusive(key, async () => {
            let job = await journal.get(key);
            if (!job || job.intent.remote !== remote || job.intent.repositoryId !== repositoryId)
                throw new Error('Publication not found');
            if (job.pause === 'mergeRejected' && !retryRejectedMerge) return job;
            const {intent} = job;
            const issueMarker = markerFor('issue', id);
            const pullMarker = markerFor('pull', id);
            const save = async (patch: Partial<PublicationJob>) => {
                const next = {...job!, pause: undefined, ...patch};
                await journal.put(key, next);
                job = next;
                return next;
            };
            const pause = (reason: PublicationPause) => save({pause: reason});
            const samePull = (pull: PullRequestReference) => pull.repositoryId === repositoryId &&
                pull.headRepositoryId === repositoryId && pull.head === intent.head && pull.base === intent.base &&
                pull.headOid === intent.commitOid;

            const rememberPull = async (pull: PullRequestReference) => {
                if (!positive(pull.number) || !samePull(pull) || !pull.body.includes(pullMarker)) return pause('pullUnknown');
                if (pull.baseOid !== intent.baseOid) return save({status: 'waiting', pullNumber: pull.number, pause: 'baseChanged'});
                return save({status: intent.goal === 'pr' && !intent.issue?.closeAfterMerge ? 'done' : 'waiting',
                    pullNumber: pull.number});
            };

            async function prepareIssue() {
                const issue = intent.issue;
                if (!issue) return save({status: 'issueReady'});
                if ('number' in issue) {
                    const found = await port.readIssue?.(issue.number);
                    return found?.number === issue.number ? save({status: 'issueReady', issueNumber: issue.number}) :
                        pause('issueUnavailable');
                }
                if (!port.createIssue || !port.findIssues) return pause('issueUnavailable');
                await save({status: 'creatingIssue'});
                const found = await port.createIssue({title: issue.title, body: withMarker(issue.body, issueMarker)});
                return positive(found.number) && found.body.includes(issueMarker) ?
                    save({status: 'issueReady', issueNumber: found.number}) : pause('issueUnknown');
            }

            async function checkPull() {
                const pull = await port.observePullRequest(job!.pullNumber!);
                if (pull.number !== job!.pullNumber || !samePull(pull)) return pause('headChanged');
                if (pull.state === 'merged') {
                    if (!isOid(pull.mergeOid)) return pause('mergeUnknown');
                    return save({status: 'merged', mergeOid: pull.mergeOid});
                }
                if (pull.state === 'closed') return pause('pullClosed');
                // A timed out merge is reconciled by observing GitHub. It never sends a second merge automatically.
                if (job!.status === 'merging') {
                    const requestId = job!.mergeRequestId;
                    if (!requestId || !port.observeMergeRequest) {
                        return job!.mergeAccepted ? save({status: 'merging'}) : pause('mergeUnknown');
                    }
                    const result = await port.observeMergeRequest(pull.number, requestId);
                    return result === 'failed' ? save({status: 'waiting', pause: 'mergeRejected', mergeRequestId: undefined,
                        mergeAccepted: undefined}) :
                        save({status: 'merging'});
                }
                if (pull.baseOid !== intent.baseOid) return pause('baseChanged');
                if (intent.goal === 'pr') return save({status: intent.issue?.closeAfterMerge ? 'waiting' : 'done'});
                if (pull.downstackOpen) return pause('downstack');
                if (pull.closesOtherIssues) return pause('closingIssues');
                if (pull.mergeable === 'conflicting') return pause('conflicting');
                if (pull.review === 'changesRequested') return pause('reviewChanges');
                if (pull.checks === 'failed') return pause('checksFailed');
                const allowNoChecks = intent.allowNoChecks === true || job!.noChecksApproved === true;
                if (pull.checks === 'absent' && !allowNoChecks) return pause('noChecks');
                if (!isDigest(pull.diffDigest)) return pause('comparisonUnavailable');
                if (job!.diffDigest && job!.diffDigest !== pull.diffDigest) return pause('baseChanged');
                const checksReady = pull.checks === 'passed' || pull.checks === 'absent' && allowNoChecks;
                const reviewReady = pull.review === 'approved' || pull.review === 'none';
                if (!checksReady || !reviewReady || pull.mergeable !== 'ready') return save({status: 'waiting'});
                if (job!.status !== 'ready') return save({status: 'ready', diffDigest: pull.diffDigest});
                await save({status: 'merging'});
                const result = await port.mergePullRequest({number: pull.number, head: pull.head, base: pull.base, headOid: pull.headOid,
                    baseOid: pull.baseOid, diffDigest: pull.diffDigest, allowNoChecks});
                return result.state === 'rejected' ? save({status: 'waiting', pause: 'mergeRejected'}) :
                    save({status: 'merging', mergeRequestId: result.requestId, mergeAccepted: true});
            }

            try {
                switch (job.status) {
                case 'queued': {
                    if (await port.branchOid(intent.base) !== intent.baseOid) return pause('baseChanged');
                    const current = await port.branchOid(intent.head);
                    if (current && current !== intent.commitOid) return pause('headChanged');
                    if (!current) await port.pushCommit(intent.commitOid, 'refs/heads/' + intent.head);
                    return save({status: 'pushed'});
                }
                case 'pushed':
                    if (await port.branchOid(intent.base) !== intent.baseOid) return pause('baseChanged');
                    return await prepareIssue();
                case 'creatingIssue': {
                    const matches = await port.findIssues?.(issueMarker);
                    const exact = matches?.filter(item => positive(item.number) && item.body.includes(issueMarker));
                    return exact?.length === 1 ? save({status: 'issueReady', issueNumber: exact[0].number}) : pause('issueUnknown');
                }
                case 'issueReady': {
                    if (await port.branchOid(intent.base) !== intent.baseOid) return pause('baseChanged');
                    if (await port.branchOid(intent.head) !== intent.commitOid) return pause('headChanged');
                    const matches = await port.findPullRequests(intent.head);
                    if (matches.length) return matches.length === 1 ? rememberPull(matches[0]) : pause('pullUnknown');
                    const {head, base, title} = intent;
                    const body = job.issueNumber ? intent.body + '\n\nRefs #' + job.issueNumber : intent.body;
                    await save({status: 'creatingPull'});
                    return await rememberPull(await port.createPullRequest({head, base, title, body: withMarker(body, pullMarker)}));
                }
                case 'creatingPull': {
                    const matches = (await port.findPullRequests(intent.head)).filter(samePull);
                    return matches.length === 1 ? rememberPull(matches[0]) : pause('pullUnknown');
                }
                case 'waiting':
                case 'ready':
                case 'merging':
                    return await checkPull();
                case 'merged':
                    if (intent.issue?.closeAfterMerge) {
                        const issueNumber = job.issueNumber;
                        if (!issueNumber || !port.readIssue || !port.closeIssue) return pause('issueUnavailable');
                        const issue = await port.readIssue(issueNumber);
                        if (issue?.number !== issueNumber) return pause('issueUnavailable');
                        if (issue.state !== 'closed') await port.closeIssue(issueNumber);
                    }
                    return save({status: 'done'});
                case 'done':
                    return job;
                }
            } catch {
                const reason = (job! as PublicationJob).status;
                return pause(reason === 'creatingIssue' ? 'issueUnknown' : reason === 'creatingPull' ? 'pullUnknown' :
                    reason === 'merging' ? 'mergeUnknown' : 'requestFailed');
            }
        });
    }

    async function confirmNoChecks(id: string) {
        const key = keyFor(id);
        return journal.exclusive(key, async () => {
            const job = await journal.get(key);
            if (!job || job.intent.goal !== 'merge' || job.pause !== 'noChecks' || !job.pullNumber)
                throw new Error('Publication is not waiting for missing-check approval');
            const {intent} = job;
            const pull = await port.observePullRequest(job.pullNumber);
            if (pull.state !== 'open' || pull.number !== job.pullNumber || pull.repositoryId !== repositoryId ||
                pull.headRepositoryId !== repositoryId || pull.head !== intent.head || pull.base !== intent.base ||
                pull.headOid !== intent.commitOid || pull.baseOid !== intent.baseOid ||
                pull.checks !== 'absent' || !isDigest(pull.diffDigest)) throw new Error('Pull request changed');
            const approved = {...job, noChecksApproved: true, diffDigest: pull.diffDigest, pause: undefined};
            await journal.put(key, approved);
            return approved;
        });
    }

    async function watch(id: string, {signal, onProgress = () => {}}: {
        signal: AbortSignal;
        onProgress?(job: PublicationJob): void;
    }) {
        let pollInterval = 30_000;
        for (;;) {
            signal.throwIfAborted();
            const job = await advance(id);
            onProgress(job);
            if (job.status === 'done' || job.pause) return job;
            if (job.status === 'waiting' || job.status === 'merging') {
                await waitForPoll(pollInterval, signal);
                pollInterval = Math.min(300_000, pollInterval * 2);
            } else pollInterval = 30_000;
        }
    }

    return {enqueue, advance, confirmNoChecks, watch, get: (id: string) => journal.get(keyFor(id))};
}

function waitForPoll(ms: number, signal: AbortSignal) {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
        const cancel = () => {clearTimeout(timer); reject(signal.reason);};
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', cancel);
            resolve();
        }, ms);
        signal.addEventListener('abort', cancel, {once: true});
    });
}

/** A journal shared by tabs of the same Editor origin. It never stores a GitHub credential. */
export function createIndexedDbPublicationJournal(indexedDb: IDBFactory, locks: LockManager): PublicationJournal {
    const store = 'jobs';
    let opened: Promise<IDBDatabase> | undefined;
    function database() {
        return opened ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDb.open('turbowarp-plus-editor-publication', 1);
            request.onupgradeneeded = () => request.result.createObjectStore(store);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => {db.close(); opened = undefined;};
                resolve(db);
            };
        }).catch(error => {opened = undefined; throw error;});
    }
    async function transact<T>(mode: IDBTransactionMode, request: (table: IDBObjectStore) => IDBRequest<T>) {
        const db = await database();
        return new Promise<T>((resolve, reject) => {
            const tx = db.transaction(store, mode);
            const pending = request(tx.objectStore(store));
            tx.oncomplete = () => resolve(pending.result);
            tx.onabort = () => reject(tx.error ?? pending.error);
        });
    }
    return {
        exclusive: (key, action) => locks.request('tw-plus-publication:' + key, action),
        get: key => transact('readonly', table => table.get(key)),
        async put(key, job) {await transact('readwrite', table => table.put(job, key));}
    };
}
