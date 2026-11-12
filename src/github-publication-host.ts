import type {PullRequestObservation, PullRequestPublicationPort, PullRequestReference} from './pull-request-queue.js';
import {remoteUrl} from './smart-http.js';

type Capability = 'pulls-read' | 'pulls-write' | 'issues-read' | 'issues-write' | 'checks-read' | 'merge';
type RecordValue = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
type Auth = {repositoryId: number; accessToken: string};

const oid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const record = (value: unknown): RecordValue => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub response');
    return value as RecordValue;
};
const list = (value: unknown): unknown[] => {
    if (!Array.isArray(value)) throw new Error('Invalid GitHub response');
    return value;
};
const numberPath = (value: number) => {
    if (!positive(value)) throw new TypeError('Invalid GitHub number');
    return String(value);
};
const mergeUuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const branch = (name: string) => {
    if (!name || name.length > 250 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(name) || name.includes('..') ||
        name.endsWith('.') || name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')))
        throw new TypeError('Invalid branch');
    return name;
};
const publicationBranch = (name: string) => {
    if (!name.startsWith('tw-plus/pr-') || !mergeUuid.test(name.slice(11))) throw new TypeError('Invalid publication branch');
    return branch(name);
};
const checkQuery = `query PublicationChecks($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    databaseId
    pullRequest(number: $number) {
      headRefOid baseRefOid isDraft mergeStateStatus mergeable reviewDecision
      closingIssuesReferences(first: 1) { totalCount }
      commits(last: 1) {
        nodes { commit { oid statusCheckRollup { state contexts(first: 1) { totalCount } } } }
      }
    }
  }
}`;

class ApiFailure extends Error {
    constructor(readonly status: number) {super('GitHub API ' + status);}
}

async function readJson(response: Response) {
    if (!response.body) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let length = 0;
    let result = '';
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) return JSON.parse(result + decoder.decode());
            length += value.byteLength;
            if (length > 8 * 1024 * 1024) throw new Error('GitHub response too large');
            result += decoder.decode(value, {stream: true});
        }
    } finally {
        void reader.cancel().catch(() => {});
    }
}

async function digest(value: unknown) {
    const data = new TextEncoder().encode(JSON.stringify(value));
    const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    return Array.from(hashed, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Fixed upstream calls for a privileged host. Pass a repository-ID-bound, capability-specific grant on each request. */
export function createGitHubPublicationHost({remote, repositoryId, grant, pushCommit, fetch: send = fetch, signal}: {
    remote: string;
    repositoryId: number;
    grant(capability: Capability): Promise<Auth | null>;
    pushCommit: PullRequestPublicationPort['pushCommit'];
    fetch?: typeof fetch;
    signal?: AbortSignal;
}): PullRequestPublicationPort {
    if (!positive(repositoryId)) throw new TypeError('Invalid repository ID');
    const [, owner, repo] = new URL(remoteUrl(remote)).pathname.slice(0, -4).split('/');
    const path = `/repos/${owner}/${repo}`;

    async function sendRequest(capability: Capability, route: string, method: Method, body?: object) {
        signal?.throwIfAborted();
        const auth = await grant(capability);
        if (!auth || auth.repositoryId !== repositoryId || !/^[A-Za-z0-9_]{1,2048}$/u.test(auth.accessToken)) throw new ApiFailure(403);
        const timeout = AbortSignal.timeout(25_000);
        return send('https://api.github.com' + route, {
            method, redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            headers: {Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + auth.accessToken,
                'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10'},
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    }

    async function json(capability: Capability, route: string, method: Method = 'GET', body?: object, missing = false) {
        const response = await sendRequest(capability, route, method, body);
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            if (missing && response.status === 404) return null;
            throw new ApiFailure(response.status);
        }
        return readJson(response);
    }

    function pullReference(value: unknown): PullRequestReference {
        const pull = record(value);
        const head = record(pull.head);
        const base = record(pull.base);
        const headRepositoryId = record(head.repo).id;
        if (!positive(pull.number) || record(base.repo).id !== repositoryId || headRepositoryId !== repositoryId ||
            typeof head.ref !== 'string' || typeof base.ref !== 'string' || !oid(head.sha) || !oid(base.sha)) {
            throw new Error('Unexpected pull request identity');
        }
        return {number: pull.number, repositoryId, headRepositoryId, head: head.ref, base: base.ref,
            headOid: head.sha, baseOid: base.sha, body: typeof pull.body === 'string' ? pull.body : ''};
    }

    async function readPull(number: number) {
        const raw = record(await json('pulls-read', path + '/pulls/' + numberPath(number)));
        const reference = pullReference(raw);
        if (reference.number !== number || (raw.state !== 'open' && raw.state !== 'closed'))
            throw new Error('Unexpected pull request state');
        return {raw, reference};
    }

    async function readDiff(number: number, count: unknown) {
        if (!positive(count) || count > 3000) return null;
        const entries = new Map<string, unknown>();
        for (let page = 1; page <= Math.ceil(count / 100); page++) {
            const rows = list(await json('pulls-read', path + '/pulls/' + numberPath(number) + '/files?per_page=100&page=' + page));
            for (const row of rows) {
                const file = record(row);
                if (typeof file.filename !== 'string' || entries.has(file.filename) || !oid(file.sha) ||
                    typeof file.status !== 'string' || !Number.isSafeInteger(file.additions) ||
                    !Number.isSafeInteger(file.deletions)) return null;
                entries.set(file.filename, [file.sha, file.status, file.previous_filename ?? null, file.additions, file.deletions]);
            }
        }
        return entries.size === count ? digest([...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : null;
    }

    async function observePullRequest(number: number): Promise<PullRequestObservation> {
        const {raw, reference} = await readPull(number);
        const baseObservation = {...reference, checks: 'unknown', review: 'unknown', mergeable: 'unknown', diffDigest: null} as const;
        if (raw.merged === true) return {...baseObservation, state: 'merged',
            mergeOid: oid(raw.merge_commit_sha) ? raw.merge_commit_sha : undefined};
        if (raw.state === 'closed') return {...baseObservation, state: 'closed'};
        // Standard PR automation does not request a merge that could include another PR.
        if (raw.stack != null) return {...baseObservation, state: 'open', downstackOpen: true};
        const [graph, diffDigest] = await Promise.all([
            json('checks-read', '/graphql', 'POST', {query: checkQuery, variables: {owner, name: repo, number}}),
            readDiff(number, raw.changed_files)
        ]);
        const data = record(graph);
        if (Array.isArray(data.errors) && data.errors.length) throw new Error('GitHub check query failed');
        const target = record(record(data.data).repository);
        const view = record(target.pullRequest);
        const last = record(record(list(record(view.commits).nodes).at(-1)).commit);
        if (target.databaseId !== repositoryId || view.headRefOid !== reference.headOid || view.baseRefOid !== reference.baseOid ||
            last.oid !== reference.headOid) return {...baseObservation, state: 'open'};
        const rollup = last.statusCheckRollup === null ? null : record(last.statusCheckRollup);
        const total = rollup ? record(rollup.contexts).totalCount : 0;
        const checks = total === 0 ? 'absent' : !positive(total) ? 'unknown' : rollup?.state === 'SUCCESS' ? 'passed' :
            ['ERROR', 'FAILURE'].includes(String(rollup?.state)) ? 'failed' :
                ['EXPECTED', 'PENDING'].includes(String(rollup?.state)) ? 'pending' : 'unknown';
        const review = view.reviewDecision === 'APPROVED' ? 'approved' : view.reviewDecision === 'REVIEW_REQUIRED' ? 'required' :
            view.reviewDecision === 'CHANGES_REQUESTED' ? 'changesRequested' : view.reviewDecision === null ? 'none' : 'unknown';
        const mergeable = view.mergeable === 'CONFLICTING' ? 'conflicting' :
            view.mergeable === 'MERGEABLE' && view.mergeStateStatus === 'CLEAN' && view.isDraft === false ? 'ready' :
                view.mergeable === 'UNKNOWN' ? 'unknown' : 'blocked';
        const current = await readPull(number);
        if (current.raw.state !== 'open' || current.raw.stack != null || current.reference.headOid !== reference.headOid ||
            current.reference.baseOid !== reference.baseOid || current.reference.head !== reference.head ||
            current.reference.base !== reference.base || current.raw.changed_files !== raw.changed_files) {
            return {...baseObservation, state: 'open'};
        }
        const closesOtherIssues = record(view.closingIssuesReferences).totalCount !== 0;
        return {...reference, state: 'open', checks, review, mergeable, diffDigest, closesOtherIssues};
    }

    return {
        async branchOid(name) {
            const value = await json('pulls-read', path + '/git/ref/heads/' + branch(name), 'GET', undefined, true);
            if (value === null) return null;
            const ref = record(value);
            const object = record(ref.object);
            if (ref.ref !== 'refs/heads/' + name || object.type !== 'commit' || !oid(object.sha))
                throw new Error('Unexpected branch reference');
            return object.sha;
        },
        pushCommit,
        async findPullRequests(head) {
            const query = new URLSearchParams({state: 'all', head: owner + ':' + publicationBranch(head), per_page: '100'});
            return list(await json('pulls-read', path + '/pulls?' + query)).map(pullReference);
        },
        async createPullRequest(draft) {
            return pullReference(await json('pulls-write', path + '/pulls', 'POST',
                {head: publicationBranch(draft.head), base: branch(draft.base), title: draft.title, body: draft.body}));
        },
        observePullRequest,
        async mergePullRequest(expected) {
            const current = await observePullRequest(expected.number);
            if (current.state === 'merged' && current.headOid === expected.headOid && current.base === expected.base &&
                current.head === expected.head) return {state: 'merged'};
            if (current.state !== 'open' || current.downstackOpen || current.closesOtherIssues || current.headOid !== expected.headOid ||
                current.head !== expected.head || current.base !== expected.base ||
                current.baseOid !== expected.baseOid || !expected.diffDigest || current.diffDigest !== expected.diffDigest ||
                current.mergeable !== 'ready' || !['approved', 'none'].includes(current.review) ||
                !(current.checks === 'passed' || current.checks === 'absent' && expected.allowNoChecks)) return {state: 'rejected'};
            const route = path + '/pulls/' + numberPath(expected.number) + '/merge-async';
            const response = await sendRequest('merge', route, 'PUT',
                {sha: expected.headOid, merge_method: 'squash', merge_action: 'default', bypass_rules: false});
            if ([400, 403, 404, 422].includes(response.status)) {
                await response.body?.cancel().catch(() => {});
                return {state: 'rejected'};
            }
            if (![200, 202, 409].includes(response.status)) {
                await response.body?.cancel().catch(() => {});
                throw new ApiFailure(response.status);
            }
            const result = record(await readJson(response));
            if (response.status === 200 && result.status === 'merged') return {state: 'merged'};
            if (response.status === 200 && result.status === 'enqueued') return {state: 'accepted'};
            const details = record(result.details);
            const requestId = details.uuid;
            if (typeof requestId !== 'string' || !mergeUuid.test(requestId) || result.status !== 'pending' ||
                (response.status === 409 && (details.expected_head_sha !== expected.headOid ||
                    details.merge_method !== 'squash' || details.merge_action !== 'default' || details.bypass_rules !== false)))
                throw new Error('Unexpected merge request');
            return {state: 'accepted', requestId};
        },
        async observeMergeRequest(number, requestId) {
            if (!mergeUuid.test(requestId)) throw new TypeError('Invalid merge request');
            const value = record(await json('merge', path + '/pulls/' + numberPath(number) + '/merge-async/' + requestId));
            if (value.status !== 'pending' && value.status !== 'enqueued' && value.status !== 'merged' && value.status !== 'failed')
                throw new Error('Unexpected merge status');
            return value.status;
        },
        async readIssue(number) {
            const value = await json('issues-read', path + '/issues/' + numberPath(number), 'GET', undefined, true);
            if (value === null) return null;
            const item = record(value);
            if (item.pull_request || item.number !== number || (item.state !== 'open' && item.state !== 'closed'))
                throw new Error('Unexpected issue identity');
            return {number, state: item.state};
        },
        async findIssues(marker) {
            const found: {number: number; body: string}[] = [];
            for (let page = 1; page <= 5; page++) {
                const issues = list(await json('issues-read', path + '/issues?state=all&sort=created&direction=desc&per_page=100&page=' + page));
                for (const issue of issues) {
                    const value = record(issue);
                    if (!value.pull_request && positive(value.number) && typeof value.body === 'string' && value.body.includes(marker))
                        found.push({number: value.number, body: value.body});
                }
                if (issues.length < 100) break;
            }
            return found;
        },
        async createIssue(draft) {
            const item = record(await json('issues-write', path + '/issues', 'POST', {title: draft.title, body: draft.body}));
            if (item.pull_request || !positive(item.number) || typeof item.body !== 'string')
                throw new Error('Unexpected issue identity');
            return {number: item.number, body: item.body};
        },
        async closeIssue(number) {
            const result = record(await json('issues-write', path + '/issues/' + numberPath(number), 'PATCH',
                {state: 'closed', state_reason: 'completed'}));
            if (result.number !== number || result.state !== 'closed' || result.pull_request) throw new Error('Issue close not verified');
        }
    };
}
