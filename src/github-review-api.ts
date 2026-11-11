import type {GitProxySession} from '@kubohiroya/turbowarp-plus-editor-auth';
import {checkConnection, remoteUrl} from './smart-http.js';

/**
 * The pull request review routes of the GitHub connection's proxy, under `/v1/github/<owner>/<repo>/`. The proxy keeps
 * the GitHub token and the GitHub node IDs; this client sends only a pull request number, the compared commit, a
 * Review-Submit-Id and the review's words, and reads back the few fields the proxy returns.
 */

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
export const reviewEvents: readonly ReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];

const proxyCodes = {
    400: ['BAD_REQUEST'],
    401: ['SESSION_REQUIRED', 'SESSION_EXPIRED', 'REAUTH_REQUIRED'],
    403: ['FORBIDDEN'],
    // A proxy without the route group answers 404 too, so an unnamed 404 means the route is unavailable.
    404: ['GITHUB_API_UNAVAILABLE', 'PULL_REQUEST_NOT_FOUND'],
    409: ['REVIEW_STEP_CONFLICT', 'REVIEW_DUPLICATE', 'PENDING_REVIEW_EXISTS', 'REDIRECT_REJECTED'],
    411: ['LENGTH_REQUIRED'],
    413: ['PAYLOAD_TOO_LARGE'],
    422: ['REVIEW_REJECTED', 'REVIEW_THREAD_REJECTED'],
    429: ['RATE_LIMITED'],
    500: ['GITHUB_API_MISCONFIGURED'],
    502: ['UPSTREAM_FAILURE'],
    504: ['UPSTREAM_TIMEOUT']
} as const;

type ProxyCode = (typeof proxyCodes)[keyof typeof proxyCodes][number];
export type GitHubReviewErrorCode = ProxyCode | 'INVALID_REMOTE' | 'INVALID_CONNECTION' | 'INVALID_SESSION' |
    'SESSION_UNAVAILABLE' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' | 'ABORTED';

// Codes after which a mutation may or may not have reached GitHub.
const unknownCodes: readonly GitHubReviewErrorCode[] = ['REVIEW_DUPLICATE', 'UPSTREAM_FAILURE', 'UPSTREAM_TIMEOUT',
    'NETWORK_ERROR', 'INVALID_RESPONSE'];

export class GitHubReviewError extends Error {
    constructor(readonly code: GitHubReviewErrorCode, readonly options: {
        status?: number; requestId?: string; retryAfter?: number;
        /** A mutation was sent and GitHub may have applied it. */
        unknown?: boolean;
    } = {}) {
        super(code);
        this.name = 'GitHubReviewError';
    }
    get unknown() {return this.options.unknown === true;}
    get retryAfter() {return this.options.retryAfter;}
}

const isSha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const optionalString = (value: unknown) => value === null || typeof value === 'string';
const submitIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const requestIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

/** A thread path the proxy accepts: a relative path whose last element is exactly project.source.json. */
export function isReviewThreadPath(path: string) {
    const parts = path.split('/');
    return parts[parts.length - 1] === 'project.source.json' && new TextEncoder().encode(path).byteLength <= 1024 &&
        parts.every(part => part && part !== '.' && part !== '..') && !/[\\\u0000-\u001f\u007f]/u.test(path);
}

export function newReviewSubmitId() {
    const id = crypto.randomUUID();
    if (!submitIdPattern.test(id)) throw new GitHubReviewError('INVALID_RESPONSE');
    return id;
}

export interface ReviewContext {
    headRefOid: string;
    viewer: string;
    pendingReview: {ours: boolean; commitOid: string | null; createdAt: string} | null;
    reviews: {state: string; commitOid: string | null; submittedAt: string | null; ours: boolean}[];
    /** The proxy's record of the submission, when the request named one. */
    submit?: {state: string; threads: number};
}

export interface SubmittedReview {state: string; commitOid: string; submittedAt: string; url: string}
export interface RestReview {id: number; login: string | null; commitId: string | null; state: string; body: string}

function readContext(value: unknown, withSubmit: boolean): ReviewContext {
    if (!isRecord(value) || !isSha(value.headRefOid) || typeof value.viewer !== 'string' || !Array.isArray(value.reviews))
        throw new GitHubReviewError('INVALID_RESPONSE');
    let pendingReview: ReviewContext['pendingReview'] = null;
    if (value.pendingReview !== null) {
        const pending = value.pendingReview;
        if (!isRecord(pending) || typeof pending.ours !== 'boolean' || !(pending.commitOid === null || isSha(pending.commitOid)) ||
            typeof pending.createdAt !== 'string') throw new GitHubReviewError('INVALID_RESPONSE');
        pendingReview = {ours: pending.ours, commitOid: pending.commitOid, createdAt: pending.createdAt};
    }
    const reviews = value.reviews.map(review => {
        if (!isRecord(review) || typeof review.state !== 'string' || !(review.commitOid === null || isSha(review.commitOid)) ||
            !optionalString(review.submittedAt) || typeof review.ours !== 'boolean') throw new GitHubReviewError('INVALID_RESPONSE');
        return {state: review.state, commitOid: review.commitOid as string | null, submittedAt: review.submittedAt as string | null,
            ours: review.ours};
    });
    const context: ReviewContext = {headRefOid: value.headRefOid, viewer: value.viewer, pendingReview, reviews};
    if (withSubmit) {
        const submit = value.submit;
        if (!isRecord(submit) || typeof submit.state !== 'string' || !isCount(submit.threads, 50))
            throw new GitHubReviewError('INVALID_RESPONSE');
        context.submit = {state: submit.state, threads: submit.threads};
    }
    return context;
}

async function readBounded(response: Response, limit: number) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let text = '', size = 0;
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) return text + decoder.decode();
            size += value.byteLength;
            if (size > limit) throw new GitHubReviewError('INVALID_RESPONSE');
            text += decoder.decode(value, {stream: true});
        }
    } finally {
        void reader.cancel().catch(() => {});
    }
}

export interface GitHubReviewApiOptions {
    /** The repository's GitHub HTTPS remote, as the connection was made for it. */
    readonly remote: string;
    /** The connection's session for `remote`; review calls ask for the review grant. */
    readonly getSession: (remote: string, write: boolean, review?: boolean) => Promise<GitProxySession | null>;
    readonly fetch?: typeof fetch;
}

export function createGitHubReviewApi({remote, getSession, fetch: send = (...args) => fetch(...args)}: GitHubReviewApiOptions) {
    let path: string;
    try {
        path = '/v1/github' + remoteUrl(remote).slice('https://github.com'.length).replace(/\.git$/u, '');
    } catch {
        throw new GitHubReviewError('INVALID_REMOTE');
    }
    /** What the proxy answered about each route group: `false` after `404 GITHUB_API_UNAVAILABLE`. */
    const available: {threads?: boolean; body?: boolean} = {};
    let account: string | null = null;

    async function session(review: boolean) {
        let value: GitProxySession | null;
        try {
            value = await getSession(remote, false, review);
        } catch {
            throw new GitHubReviewError('SESSION_UNAVAILABLE');
        }
        if (!value) throw new GitHubReviewError('SESSION_REQUIRED');
        if (!Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) throw new GitHubReviewError('SESSION_EXPIRED');
        try {
            checkConnection(value.connection);
        } catch {
            throw new GitHubReviewError('INVALID_CONNECTION');
        }
        if (typeof value.bearer !== 'string' || !/^[A-Za-z0-9._~+\/-]+=*$/u.test(value.bearer))
            throw new GitHubReviewError('INVALID_SESSION');
        account = typeof value.account?.login === 'string' ? value.account.login : null;
        return value;
    }

    async function call(route: string, {method = 'GET', body, submitId, review = false, mutation = false, limit = 256 * 1024,
        group, signal}: {
        method?: 'GET' | 'POST'; body?: unknown; submitId?: string; review?: boolean; mutation?: boolean; limit?: number;
        group: 'threads' | 'body' | 'read'; signal?: AbortSignal;
    }): Promise<unknown> {
        if (signal?.aborted) throw new GitHubReviewError('ABORTED');
        const current = await session(review);
        const headers: Record<string, string> = {Authorization: 'Bearer ' + current.bearer, Accept: 'application/json'};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (submitId !== undefined) {
            if (!submitIdPattern.test(submitId)) throw new GitHubReviewError('BAD_REQUEST');
            headers['Review-Submit-Id'] = submitId;
        }
        let response: Response;
        try {
            response = await send(current.connection.proxyOrigin + path + route, {
                method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal,
                credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer'
            });
        } catch {
            if (!mutation && signal?.aborted) throw new GitHubReviewError('ABORTED');
            throw new GitHubReviewError('NETWORK_ERROR', {unknown: mutation});
        }
        const json = response.headers.get('content-type')?.split(';')[0].trim() === 'application/json';
        if (response.status !== 200) {
            const allowed: readonly ProxyCode[] | undefined = proxyCodes[response.status as keyof typeof proxyCodes];
            let code: GitHubReviewErrorCode = allowed?.[0] ?? 'INVALID_RESPONSE';
            let requestId: string | undefined, retryAfter: number | undefined;
            try {
                const parsed: unknown = json ? JSON.parse(await readBounded(response, 4096)) : null;
                if (isRecord(parsed)) {
                    if (allowed?.includes(parsed.code as ProxyCode)) code = parsed.code as ProxyCode;
                    if (typeof parsed.requestId === 'string' && requestIdPattern.test(parsed.requestId)) requestId = parsed.requestId;
                    if (Number.isSafeInteger(parsed.retryAfter) && Number(parsed.retryAfter) >= 0) retryAfter = Number(parsed.retryAfter);
                }
            } catch {
                // An untrusted error body never becomes part of a client error.
            }
            if (code === 'GITHUB_API_UNAVAILABLE' && group !== 'read') available[group] = false;
            if (code === 'GITHUB_API_UNAVAILABLE' && group === 'read') available.threads = false;
            const unknown = mutation && (unknownCodes.includes(code) || !allowed);
            throw new GitHubReviewError(unknown && !allowed ? 'UPSTREAM_FAILURE' : code,
                {status: response.status, requestId, retryAfter, unknown});
        }
        if (group !== 'read') available[group] = true;
        try {
            if (!json) throw new Error();
            return JSON.parse(await readBounded(response, limit));
        } catch {
            throw new GitHubReviewError('INVALID_RESPONSE', {unknown: mutation});
        }
    }

    const checkNumber = (number: number) => {
        if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new GitHubReviewError('BAD_REQUEST');
    };
    const graphql = (operation: string, number: number, variables: Record<string, unknown>, submitId: string | undefined,
        signal: AbortSignal | undefined, mutation = true) => {
        checkNumber(number);
        return call('/graphql/' + operation, {method: 'POST', body: {number, ...variables}, submitId, review: mutation, mutation,
            group: mutation ? 'threads' : 'read', signal});
    };
    const shape = <T>(check: boolean, value: T, mutation = true): T => {
        if (!check) throw new GitHubReviewError('INVALID_RESPONSE', {unknown: mutation});
        return value;
    };

    return {
        available,
        /** The GitHub login of the last session this client used. */
        account: () => account,
        /** Reads the viewer's pending and recent reviews; with `submitId`, resolves that submission's unknown outcome. */
        async context(number: number, submitId?: string, signal?: AbortSignal) {
            const value = await graphql('pullRequestReviewContext', number, {}, submitId, signal, false);
            const context = readContext(value, submitId !== undefined);
            available.threads = true;
            return context;
        },
        /** Step 1: a pending review on `commitOid`. */
        async start(number: number, submitId: string, commitOid: string, signal?: AbortSignal) {
            if (!isSha(commitOid)) throw new GitHubReviewError('BAD_REQUEST');
            const value = await graphql('addPullRequestReview', number, {commitOid}, submitId, signal);
            shape(isRecord(value) && value.state === 'PENDING' && value.commitOid === commitOid, value);
        },
        /** Step 2: one file-level thread on a project.source.json; resolves the number of threads the proxy has accepted. */
        async thread(number: number, submitId: string, threadIndex: number, threadPath: string, body: string, signal?: AbortSignal) {
            if (!isCount(threadIndex, 49) || !isReviewThreadPath(threadPath) || !body || body.length > 65536)
                throw new GitHubReviewError('BAD_REQUEST');
            const value = await graphql('addPullRequestReviewThread', number, {threadIndex, path: threadPath, body}, submitId, signal);
            return shape(isRecord(value) && value.threads === threadIndex + 1, threadIndex + 1);
        },
        /** Step 3: publishes the pending review. */
        async submit(number: number, submitId: string, threadCount: number, event: ReviewEvent, body: string, signal?: AbortSignal) {
            if (!isCount(threadCount, 50) || !reviewEvents.includes(event) || body.length > 65536)
                throw new GitHubReviewError('BAD_REQUEST');
            const value = await graphql('submitPullRequestReview', number, {threadCount, event, body}, submitId, signal);
            const review = (isRecord(value) ? value : {}) as Partial<Record<keyof SubmittedReview, unknown>>;
            return shape(typeof review.state === 'string' && review.state !== 'PENDING' && isSha(review.commitOid) &&
                typeof review.submittedAt === 'string' && typeof review.url === 'string', review as SubmittedReview);
        },
        /** Removes the pending review of the submission. */
        async discard(number: number, submitId: string, signal?: AbortSignal) {
            const value = await graphql('deletePullRequestReview', number, {}, submitId, signal);
            shape(isRecord(value) && value.deleted === true, value);
        },
        /** The review-body route: one page of the pull request's reviews, oldest first. */
        async reviews(number: number, page: number, signal?: AbortSignal): Promise<RestReview[]> {
            checkNumber(number);
            if (!Number.isSafeInteger(page) || page < 1 || page > 10) throw new GitHubReviewError('BAD_REQUEST');
            const value = await call(`/pulls/${number}/reviews?page=${page}`, {group: 'body', limit: 4 * 1024 * 1024, signal});
            if (!Array.isArray(value)) throw new GitHubReviewError('INVALID_RESPONSE');
            return value.map(review => {
                if (!isRecord(review) || !Number.isSafeInteger(review.id) || typeof review.state !== 'string' ||
                    !(review.commit_id === null || isSha(review.commit_id)) || !optionalString(review.body))
                    throw new GitHubReviewError('INVALID_RESPONSE');
                const login = isRecord(review.user) && typeof review.user.login === 'string' ? review.user.login : null;
                return {id: Number(review.id), login, commitId: review.commit_id as string | null, state: review.state,
                    body: typeof review.body === 'string' ? review.body : ''};
            });
        },
        /** The review-body route: creates and publishes a review with a body only. */
        async create(number: number, submitId: string, commitOid: string, event: ReviewEvent, body: string, signal?: AbortSignal) {
            checkNumber(number);
            if (!isSha(commitOid) || !reviewEvents.includes(event) || body.length > 65536 || (!body && event !== 'APPROVE'))
                throw new GitHubReviewError('BAD_REQUEST');
            const value = await call(`/pulls/${number}/reviews`, {method: 'POST', body: {commit_id: commitOid, event, body},
                submitId, review: true, mutation: true, group: 'body', limit: 1024 * 1024, signal});
            return shape(isRecord(value) && typeof value.state === 'string' && typeof value.html_url === 'string',
                {url: (value as {html_url: string}).html_url});
        }
    };
}

export type GitHubReviewApi = ReturnType<typeof createGitHubReviewApi>;
