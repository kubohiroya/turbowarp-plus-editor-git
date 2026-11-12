import {samePublicationStackParent} from './pull-request-queue.js';
import type {PublicationStackParent, PullRequestObservation, PullRequestPublicationPort,
    PullRequestReference} from './pull-request-queue.js';
import {remoteUrl} from './smart-http.js';

type Capability = 'pulls-read' | 'pulls-write' | 'issues-read' | 'issues-write' | 'checks-read' | 'merge' | 'stacks';
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

async function readText(response: Response) {
    if (!response.body) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let length = 0;
    let result = '';
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) return result + decoder.decode();
            length += value.byteLength;
            if (length > 8 * 1024 * 1024) throw new Error('GitHub response too large');
            result += decoder.decode(value, {stream: true});
        }
    } finally {
        void reader.cancel().catch(() => {});
    }
}

async function readJson(response: Response) {
    const text = await readText(response);
    return text === null ? null : JSON.parse(text);
}

async function digest(value: unknown) {
    const data = new TextEncoder().encode(JSON.stringify(value));
    const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    return Array.from(hashed, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Keep complete textual changes and context, ignoring only hunk offsets after GitHub rebases. */
function comparablePatch(value: unknown, additions: number, deletions: number) {
    if (typeof value !== 'string' || !value) return null;
    const lines = value.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const result: string[] = [];
    let removed = 0;
    let added = 0;
    let oldRemaining = 0;
    let newRemaining = 0;
    for (const line of lines) {
        const header = /^@@ -[0-9]+(?:,([0-9]+))? \+[0-9]+(?:,([0-9]+))? @@([^\n]*)$/u.exec(line);
        if (header) {
            if (oldRemaining || newRemaining) return null;
            oldRemaining = Number(header[1] ?? 1);
            newRemaining = Number(header[2] ?? 1);
            result.push('@@' + header[3]);
        } else {
            if (!result.length) return null;
            if (line.startsWith('+')) {newRemaining--; added++;}
            else if (line.startsWith('-')) {oldRemaining--; removed++;}
            else if (line.startsWith(' ')) {oldRemaining--; newRemaining--;}
            else if (line !== '\\ No newline at end of file') return null;
            if (oldRemaining < 0 || newRemaining < 0) return null;
            result.push(line);
        }
    }
    return !oldRemaining && !newRemaining && added === additions && removed === deletions ? result : null;
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

    async function sendRequest(capability: Capability, route: string, method: Method, body?: object,
        accept = 'application/vnd.github+json') {
        signal?.throwIfAborted();
        const auth = await grant(capability);
        if (!auth || auth.repositoryId !== repositoryId || !/^[A-Za-z0-9_]{1,2048}$/u.test(auth.accessToken)) throw new ApiFailure(403);
        const timeout = AbortSignal.timeout(25_000);
        return send('https://api.github.com' + route, {
            method, redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            headers: {Accept: accept, Authorization: 'Bearer ' + auth.accessToken,
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

    async function readDiff(number: number, count: unknown, requireCompletePatch = false) {
        if (!positive(count) || count > 3000) return null;
        const entries = new Map<string, unknown>();
        for (let page = 1; page <= Math.ceil(count / 100); page++) {
            const rows = list(await json('pulls-read', path + '/pulls/' + numberPath(number) + '/files?per_page=100&page=' + page));
            for (const row of rows) {
                const file = record(row);
                if (typeof file.filename !== 'string' || entries.has(file.filename) || !oid(file.sha) ||
                    typeof file.status !== 'string' || !Number.isSafeInteger(file.additions) ||
                    !Number.isSafeInteger(file.deletions)) return null;
                const patch = requireCompletePatch ? comparablePatch(file.patch, Number(file.additions), Number(file.deletions)) :
                    undefined;
                if (requireCompletePatch && !patch) return null;
                const entry = [file.sha, file.status, file.previous_filename ?? null, file.additions, file.deletions];
                if (patch) entry.push(patch);
                entries.set(file.filename, entry);
            }
        }
        return entries.size === count ? digest([...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : null;
    }

    async function readStackDiff(number: number, count: unknown) {
        const files = await readDiff(number, count, true);
        if (!files) return null;
        // The file-list API omits mode metadata. Bind the complete Git headers as well.
        const response = await sendRequest('pulls-read', path + '/pulls/' + numberPath(number), 'GET', undefined,
            'application/vnd.github.diff');
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            return null;
        }
        const raw = await readText(response);
        if (!raw?.startsWith('diff --git ')) return null;
        const sections = raw.split(/(?=^diff --git )/mu);
        const headers = sections.map(section => section.split(/^@@ /mu, 1)[0]);
        if (headers.length !== count || headers.some(header => !header || !/^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/mu.test(header))) {
            return null;
        }
        return digest([files, headers]);
    }

    async function readStack(number: number) {
        const raw = record(await json('stacks', path + '/stacks/' + numberPath(number)));
        const targetBase = record(raw.base).ref;
        if (raw.number !== number || typeof targetBase !== 'string' || typeof raw.open !== 'boolean')
            throw new Error('Unexpected stack identity');
        const seen = new Set<number>();
        const members = list(raw.pull_requests).map(value => {
            const entry = record(value);
            const pull = pullReference(entry);
            if (seen.has(pull.number) || (entry.state !== 'open' && entry.state !== 'closed'))
                throw new Error('Unexpected stack entry');
            seen.add(pull.number);
            const state = entry.state === 'open' ? 'open' :
                typeof entry.merged_at === 'string' && Number.isFinite(Date.parse(entry.merged_at)) ? 'merged' : 'closed';
            return {pull, state};
        });
        return {targetBase: branch(targetBase), open: raw.open, members};
    }

    const stackNumberOf = (raw: RecordValue) => {
        const number = raw.stack == null ? undefined : record(raw.stack).number;
        if (raw.stack != null && !positive(number)) throw new Error('Unexpected stack number');
        return number as number | undefined;
    };
    const sameRefs = (one: PullRequestReference, other: PullRequestReference) => one.number === other.number &&
        one.head === other.head && one.base === other.base && one.headOid === other.headOid && one.baseOid === other.baseOid;

    async function stackParent(number: number): Promise<PublicationStackParent | null> {
        const value = await json('stacks', path + '/pulls/' + numberPath(number), 'GET', undefined, true);
        if (value === null) return null;
        const raw = record(value);
        if (raw.state !== 'open' || record(record(raw.head).repo).id !== repositoryId ||
            record(record(raw.base).repo).id !== repositoryId) return null;
        const reference = pullReference(raw);
        if (reference.number !== number) return null;
        const stackNumber = stackNumberOf(raw);
        const head = branch(reference.head);
        if (stackNumber === undefined) return {number, head, headOid: reference.headOid, targetBase: branch(reference.base)};
        const stack = await readStack(stackNumber);
        const top = stack.members.at(-1);
        return stack.open && top?.state === 'open' && sameRefs(top.pull, reference) ?
            {number, head, headOid: reference.headOid, targetBase: stack.targetBase, stackNumber} : null;
    }

    async function stackRelation(raw: RecordValue, child: PullRequestReference, parent: PublicationStackParent, expectedNumber?: number) {
        const number = stackNumberOf(raw);
        if (number === undefined && expectedNumber === undefined) return {kind: 'unlinked'} as const;
        const approvedStack = expectedNumber ?? parent.stackNumber;
        if (number === undefined || (approvedStack !== undefined && number !== approvedStack)) return {kind: 'changed'} as const;
        const stack = await readStack(number);
        const index = stack.members.findIndex(member => member.pull.number === child.number);
        const current = stack.members[index];
        const immediate = stack.members[index - 1];
        if (index < 1 || (approvedStack === undefined && index !== 1) || stack.targetBase !== parent.targetBase ||
            !sameRefs(current.pull, child) || (raw.state === 'open' && (!stack.open || current.state !== 'open')) ||
            (raw.merged === true && current.state !== 'merged') || immediate?.pull.number !== parent.number ||
            immediate.pull.head !== parent.head || stack.members.slice(0, index).some(member => member.state === 'closed')) {
            return {kind: 'changed'} as const;
        }
        const downstackOpen = stack.members.slice(0, index).some(member => member.state === 'open');
        if (downstackOpen && (immediate.pull.headOid !== parent.headOid || child.base !== parent.head ||
            child.baseOid !== parent.headOid)) return {kind: 'changed'} as const;
        return {kind: 'linked', number, downstackOpen} as const;
    }

    async function stackContainsCommit(parentOid: string, commitOid: string) {
        if (!oid(parentOid) || !oid(commitOid)) throw new TypeError('Invalid comparison');
        const comparison = record(await json('stacks', path + '/compare/' + parentOid + '...' + commitOid + '?per_page=1'));
        return comparison.status === 'ahead' && record(comparison.merge_base_commit).sha === parentOid;
    }

    async function observePullRequest(number: number,
        expectedStack?: NonNullable<Parameters<PullRequestPublicationPort['observePullRequest']>[1]>): Promise<PullRequestObservation> {
        const {raw, reference} = await readPull(number);
        const baseObservation = {...reference, checks: 'unknown', review: 'unknown', mergeable: 'unknown', diffDigest: null} as const;
        const state = raw.merged === true ? 'merged' : raw.state === 'closed' ? 'closed' : 'open';
        if (expectedStack) {
            const relation = await stackRelation(raw, reference, expectedStack.parent, expectedStack.number);
            if (relation.kind !== 'linked') return {...baseObservation, state, stackChanged: true};
            if (relation.downstackOpen) return {...baseObservation, state, downstackOpen: true};
            if (state === 'open' && reference.base === expectedStack.parent.head) return {...baseObservation, state};
        }
        if (raw.merged === true) return {...baseObservation, state: 'merged',
            diffDigest: expectedStack ? await readStackDiff(number, raw.changed_files) : null,
            mergeOid: oid(raw.merge_commit_sha) ? raw.merge_commit_sha : undefined};
        if (raw.state === 'closed') return {...baseObservation, state: 'closed'};
        // Standard PR automation does not request a merge that could include another PR.
        if (!expectedStack && raw.stack != null) return {...baseObservation, state: 'open', downstackOpen: true};
        const [graph, diffDigest] = await Promise.all([
            json('checks-read', '/graphql', 'POST', {query: checkQuery, variables: {owner, name: repo, number}}),
            expectedStack ? readStackDiff(number, raw.changed_files) : readDiff(number, raw.changed_files)
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
        if (current.raw.state !== 'open' || (!expectedStack && current.raw.stack != null) ||
            !sameRefs(current.reference, reference) || current.reference.body !== reference.body ||
            current.raw.changed_files !== raw.changed_files) {
            return {...baseObservation, state: 'open'};
        }
        if (expectedStack) {
            const relation = await stackRelation(current.raw, current.reference, expectedStack.parent, expectedStack.number);
            if (relation.kind !== 'linked') return {...baseObservation, state: 'open', stackChanged: true};
            if (relation.downstackOpen) return {...baseObservation, state: 'open', downstackOpen: true};
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
        stackParent,
        stackContainsCommit,
        async inspectStackChild(number, parent) {
            const {raw, reference} = await readPull(number);
            const relation = await stackRelation(raw, reference, parent);
            const diffDigest = raw.state === 'open' ? await readStackDiff(number, raw.changed_files) : null;
            const current = await readPull(number);
            const stable = sameRefs(current.reference, reference) && current.reference.body === reference.body &&
                current.raw.changed_files === raw.changed_files && current.raw.state === raw.state &&
                stackNumberOf(current.raw) === stackNumberOf(raw);
            return {pull: reference, open: raw.state === 'open', diffDigest: stable ? diffDigest : null,
                membership: stable ? relation.kind : 'changed', stackNumber: relation.kind === 'linked' ? relation.number : undefined};
        },
        async linkStack(parent, child) {
            if (!samePublicationStackParent(await stackParent(parent.number), parent)) throw new Error('Stack parent changed');
            const current = await readPull(child.number);
            if (current.raw.state !== 'open' || current.raw.stack != null || !sameRefs(current.reference, child) ||
                current.reference.body !== child.body || current.reference.base !== parent.head ||
                current.reference.baseOid !== parent.headOid) throw new Error('Stack child changed');
            const route = parent.stackNumber === undefined ? '/stacks' : '/stacks/' + numberPath(parent.stackNumber) + '/add';
            const pull_requests = parent.stackNumber === undefined ? [parent.number, child.number] : [child.number];
            await json('stacks', path + route, 'POST', {pull_requests});
        },
        async mergePullRequest(expected) {
            const current = await observePullRequest(expected.number, expected.stack);
            if (current.state === 'merged' && current.headOid === expected.headOid && current.base === expected.base &&
                current.head === expected.head) return {state: 'merged'};
            if (current.state !== 'open' || current.stackChanged || current.downstackOpen || current.closesOtherIssues ||
                current.headOid !== expected.headOid ||
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
