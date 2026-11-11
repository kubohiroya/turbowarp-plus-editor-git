import {GitHubReviewError, isReviewThreadPath, newReviewSubmitId, reviewEvents} from './github-review-api.js';
import type {GitHubReviewApi, GitHubReviewErrorCode, ReviewEvent} from './github-review-api.js';

/**
 * Sending a pull request review through the GitHub connection, apart from React.
 *
 * With the proxy's GraphQL routes, a review is sent in three steps under one Review-Submit-Id: a pending review on the
 * compared commit, one file-level thread on a project.source.json per script comment, then the submission. Until the
 * last step nobody else can see anything, so a failure before it discards the pending review. An unknown outcome is
 * never sent again on its own: the person checks it, and only then sends again. Without the GraphQL routes, the whole
 * review goes in the body of one REST review. The draft stays in the browser until GitHub has the review.
 */

/** One comment on a script, kept under the script's review key. */
export interface ReviewComment {
    /** The project.source.json the script is in. */
    file: string;
    /** Names the stage or sprite, the script and its first block, in the words of the person writing. */
    heading: string;
    body: string;
}

/**
 * A submission in progress. The ID is ours, not GitHub's. `threadKeys` are the comments already on the pending review.
 *  - `starting`, `threading`, `submitting`: a step was sent; a reload while it was out reads as unknown.
 *  - `start-unknown`, `submit-unknown`: whether GitHub applied the step is unknown; check before anything else.
 *  - `pending`: the pending review has all its threads, and the last step was refused; send again or discard.
 *  - `left`: a pending review could not be discarded; discard it again, or on GitHub.
 */
export interface ReviewSubmission {
    id: string;
    commitOid: string;
    route: 'threads' | 'body';
    state: 'starting' | 'threading' | 'submitting' | 'start-unknown' | 'submit-unknown' | 'pending' | 'left';
    threadKeys: string[];
    /** The body-only route: a fingerprint of the body that was sent, to recognise the review on GitHub. */
    sent?: string;
}

export interface ReviewDraft {
    event: ReviewEvent;
    body: string;
    comments: Record<string, ReviewComment>;
    /** Project files whose comments go in the review body because GitHub refused a thread on them. */
    inBody: string[];
    /** The pull request head the comments were written for. */
    head?: string;
    submit?: ReviewSubmission;
}

export const emptyReviewDraft = (): ReviewDraft => ({event: 'COMMENT', body: '', comments: {}, inBody: []});

const draftKey = (name: string) => `turbowarp-plus-git:review-draft:${name}`;
const memoryDrafts = new Map<string, ReviewDraft>();
const draftListeners = new Map<string, Set<() => void>>();
let persistent = true;
// Reviews with an action under way; their in-flight steps are not read as interrupted.
const running = new Set<string>();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
const states: readonly ReviewSubmission['state'][] = ['starting', 'threading', 'submitting', 'start-unknown', 'submit-unknown',
    'pending', 'left'];

/** Keeps only the fields of a draft, so nothing else read from storage reaches a request. */
function readDraftValue(value: unknown, settle: boolean): ReviewDraft | null {
    if (!isRecord(value)) return null;
    const draft = emptyReviewDraft();
    if (reviewEvents.includes(value.event as ReviewEvent)) draft.event = value.event as ReviewEvent;
    if (typeof value.body === 'string') draft.body = value.body;
    if (isRecord(value.comments)) {
        for (const [key, comment] of Object.entries(value.comments)) {
            if (isRecord(comment) && typeof comment.file === 'string' && typeof comment.heading === 'string' &&
                typeof comment.body === 'string') draft.comments[key] = {file: comment.file, heading: comment.heading, body: comment.body};
        }
    }
    if (Array.isArray(value.inBody)) draft.inBody = value.inBody.filter((file): file is string => typeof file === 'string');
    if (isSha(value.head)) draft.head = value.head;
    const submit = value.submit;
    if (isRecord(submit) && typeof submit.id === 'string' && isSha(submit.commitOid) &&
        (submit.route === 'threads' || submit.route === 'body') && states.includes(submit.state as ReviewSubmission['state']) &&
        Array.isArray(submit.threadKeys)) {
        // A step that was out when the page closed may have reached GitHub.
        const state = submit.state as ReviewSubmission['state'];
        draft.submit = {id: submit.id, commitOid: submit.commitOid, route: submit.route,
            state: !settle ? state : state === 'starting' ? 'start-unknown' : state === 'threading' ? 'left' : state === 'submitting' ? 'submit-unknown' : state,
            threadKeys: submit.threadKeys.filter((key): key is string => typeof key === 'string'),
            ...(typeof submit.sent === 'string' && {sent: submit.sent})};
    }
    return draft;
}

/** The saved draft of a review, such as `owner/repo#42`, or an empty one. */
export function readReviewDraft(name: string): ReviewDraft {
    const memory = memoryDrafts.get(name);
    if (memory) return memory;
    try {
        const stored = globalThis.localStorage?.getItem(draftKey(name));
        return (stored && readDraftValue(JSON.parse(stored), !running.has(name))) || emptyReviewDraft();
    } catch {
        return emptyReviewDraft();
    }
}

const isEmpty = (draft: ReviewDraft) => !draft.body && !draft.submit && !draft.inBody.length &&
    Object.values(draft.comments).every(comment => !comment.body);

/** Saves a draft, or removes it with `null`. Without browser storage, the draft is kept while the page is open. */
export function writeReviewDraft(name: string, draft: ReviewDraft | null) {
    const value = draft && !isEmpty(draft) ? draft : null;
    try {
        if (!globalThis.localStorage) throw new Error();
        if (value) globalThis.localStorage.setItem(draftKey(name), JSON.stringify(value));
        else globalThis.localStorage.removeItem(draftKey(name));
        memoryDrafts.delete(name);
        persistent = true;
    } catch {
        persistent = false;
        if (value) memoryDrafts.set(name, value);
        else memoryDrafts.delete(name);
    }
    draftListeners.get(name)?.forEach(listener => listener());
}

/** Whether the last write reached browser storage. */
export const reviewDraftPersistent = () => persistent;

export function subscribeReviewDraft(name: string, listener: () => void) {
    const listeners = draftListeners.get(name) ?? new Set();
    draftListeners.set(name, listeners.add(listener));
    return () => {
        listeners.delete(listener);
        if (!listeners.size) draftListeners.delete(name);
    };
}

export const MAX_REVIEW_THREADS = 50;
export const MAX_REVIEW_BODY = 65536;

export interface ReviewPlan {
    /** File-level threads, in the order they are sent. */
    threads: {key: string; path: string; body: string}[];
    /** Script comments that go in the review body. */
    inBody: {key: string; comment: ReviewComment}[];
    /** The review body: the overall comment, then the script comments that are not threads. */
    body: string;
}

const threadBody = (comment: ReviewComment) => `**${comment.heading}**\n\n${comment.body.trim()}`;

/** Puts the overall comment first, then each script comment that is not a thread under its file and heading. */
export function reviewBody(overall: string, comments: readonly {comment: ReviewComment}[]) {
    const parts = overall.trim() ? [overall.trim()] : [];
    if (comments.length) {
        if (parts.length) parts.push('---');
        for (const {comment} of comments) parts.push(`**${comment.file} · ${comment.heading}**\n\n${comment.body.trim()}`);
    }
    return parts.join('\n\n');
}

/**
 * Decides where each script comment goes. A comment becomes a thread when threads are used, its project.source.json is
 * among the pull request's changed files, GitHub has not refused a thread on that file, and fewer than 50 threads come
 * before it. Comments in `exclude` are already on the pending review.
 */
export function planReview(draft: ReviewDraft, {threads, changedFiles, exclude = []}: {
    threads: boolean; changedFiles: readonly string[]; exclude?: readonly string[];
}): ReviewPlan {
    const changed = new Set(changedFiles);
    const plan: ReviewPlan = {threads: [], inBody: [], body: ''};
    const comments = Object.entries(draft.comments).filter(([key, comment]) => comment.body.trim() && !exclude.includes(key))
        .sort(([a, x], [b, y]) => x.file < y.file ? -1 : x.file > y.file ? 1 : a < b ? -1 : a > b ? 1 : 0);
    for (const [key, comment] of comments) {
        if (threads && plan.threads.length < MAX_REVIEW_THREADS && changed.has(comment.file) && isReviewThreadPath(comment.file) &&
            !draft.inBody.includes(comment.file)) plan.threads.push({key, path: comment.file, body: threadBody(comment)});
        else plan.inBody.push({key, comment});
    }
    plan.body = reviewBody(draft.body, plan.inBody);
    return plan;
}

// A short fingerprint of a sent body, to find the review on GitHub without keeping a second copy of the words.
export const bodyFingerprint = (body: string) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < body.length; index++) hash = Math.imul(hash ^ body.charCodeAt(index), 0x01000193);
    return body.length.toString(36) + '.' + (hash >>> 0).toString(36);
};

export type ReviewProblem = GitHubReviewErrorCode | 'EMPTY_REVIEW' | 'TOO_LONG' | 'UNSUPPORTED' | 'BUSY' |
    'REVIEW_OUTCOME_UNKNOWN' | 'PENDING_REVIEW_LEFT' | 'NOT_ALLOWED';

/** What GitHub would refuse before anything is sent. */
export function reviewProblem(event: ReviewEvent, plan: ReviewPlan, route: 'threads' | 'body'): ReviewProblem | null {
    const threads = route === 'threads' ? plan.threads.length : 0;
    if (plan.body.length > MAX_REVIEW_BODY || plan.threads.some(thread => thread.body.length > MAX_REVIEW_BODY)) return 'TOO_LONG';
    if (event === 'REQUEST_CHANGES' && !plan.body) return 'EMPTY_REVIEW';
    if (event === 'COMMENT' && !plan.body && !threads) return 'EMPTY_REVIEW';
    return null;
}

/**
 * The result of an action. `outcome` says what is now on GitHub:
 *  - `submitted`: the review is published (the draft is removed);
 *  - `not-sent`: nothing is on GitHub (the draft is kept);
 *  - `pending`: a pending review with every thread waits for the last step; send again or discard;
 *  - `unknown`: whether a step reached GitHub is unknown; check it;
 *  - `left`: a pending review could not be discarded;
 *  - `closed`: the check found no review: it was not published, or was discarded on GitHub; send again;
 *  - `lost`: the proxy no longer knows the submission (the session ended); look on GitHub.
 */
export interface ReviewResult {
    outcome: 'submitted' | 'not-sent' | 'pending' | 'unknown' | 'left' | 'closed' | 'lost';
    code?: ReviewProblem;
    /** Seconds to wait before the same action, after a rate limit. */
    retryAfter?: number;
    url?: string;
    /** For `lost`: the person's reviews on the compared commit that GitHub lists, newest first. */
    reviews?: {state: string; submittedAt: string | null}[];
}

export interface ReviewTarget {
    api: GitHubReviewApi;
    /** Where the draft is kept, such as `owner/repo#42`. */
    name: string;
    number: number;
    /** The compared head commit, fetched over Git. */
    head: string;
    /** The pull request's changed files. */
    changedFiles: readonly string[];
    signal?: AbortSignal;
}

/** Runs one action at a time per review, so the steps of a submission are never sent side by side. */
async function exclusive(target: ReviewTarget, action: () => Promise<ReviewResult>): Promise<ReviewResult> {
    if (running.has(target.name)) return {outcome: 'not-sent', code: 'BUSY'};
    running.add(target.name);
    try {
        return await action();
    } finally {
        running.delete(target.name);
    }
}

const failure = (error: unknown): {code: ReviewProblem; retryAfter?: number} => error instanceof GitHubReviewError ?
    {code: error.code, ...(error.retryAfter !== undefined && {retryAfter: error.retryAfter})} : {code: 'NETWORK_ERROR'};
const isUnknown = (error: unknown) => error instanceof GitHubReviewError ? error.unknown : true;
const codeOf = (error: unknown) => error instanceof GitHubReviewError ? error.code : undefined;

function update(name: string, change: (draft: ReviewDraft) => ReviewDraft | null) {
    writeReviewDraft(name, change(readReviewDraft(name)));
}
const setSubmit = (name: string, submit: ReviewSubmission | undefined) => update(name, draft => ({...draft, submit}));
const finish = (name: string) => writeReviewDraft(name, null);

/** The route the next submission takes, or `null` when the proxy offers neither. */
export function reviewRoute(api: GitHubReviewApi): 'threads' | 'body' | null {
    return api.available.threads !== false ? 'threads' : api.available.body !== false ? 'body' : null;
}

/**
 * Asks the proxy which review routes it offers, with one read: the review context, then, when the GraphQL routes are
 * off, the list of reviews. A failure other than an unavailable route leaves the route as it was.
 */
export async function probeReviewRoutes(api: GitHubReviewApi, number: number, signal?: AbortSignal) {
    let context = null;
    try {
        context = await api.context(number, undefined, signal);
    } catch (error) {
        if (codeOf(error) !== 'GITHUB_API_UNAVAILABLE') return {context: null, error};
    }
    if (api.available.threads === false && api.available.body === undefined) {
        try {
            await api.reviews(number, 1, signal);
        } catch (error) {
            if (codeOf(error) !== 'GITHUB_API_UNAVAILABLE') return {context, error};
        }
    }
    return {context};
}

/** Discards the pending review after a failed step. The draft keeps the words either way. */
async function discardAfter(target: ReviewTarget, submit: ReviewSubmission, cause: unknown): Promise<ReviewResult> {
    const {api, name, number, signal} = target;
    try {
        await api.discard(number, submit.id, signal);
    } catch (error) {
        setSubmit(name, {...submit, state: 'left'});
        return {outcome: 'left', code: 'PENDING_REVIEW_LEFT', ...(failure(error).retryAfter !== undefined && {retryAfter: failure(error).retryAfter})};
    }
    setSubmit(name, undefined);
    return {outcome: 'not-sent', ...failure(cause)};
}

async function lastStep(target: ReviewTarget, submit: ReviewSubmission, draft: ReviewDraft): Promise<ReviewResult> {
    const {api, name, number, signal} = target;
    const plan = planReview(draft, {threads: false, changedFiles: [], exclude: submit.threadKeys});
    const problem = reviewProblem(draft.event, {...plan, threads: submit.threadKeys.map(key => ({key, path: '', body: ''}))}, 'threads');
    if (problem) {
        setSubmit(name, {...submit, state: 'pending'});
        return {outcome: 'pending', code: problem};
    }
    setSubmit(name, {...submit, state: 'submitting'});
    try {
        const published = await api.submit(number, submit.id, submit.threadKeys.length, draft.event, plan.body, signal);
        finish(name);
        return {outcome: 'submitted', url: published.url};
    } catch (error) {
        if (isUnknown(error)) {
            setSubmit(name, {...submit, state: 'submit-unknown'});
            return {outcome: 'unknown', code: 'REVIEW_OUTCOME_UNKNOWN'};
        }
        if (codeOf(error) === 'REVIEW_STEP_CONFLICT') {
            // The proxy closed the submission: the pending review is gone.
            setSubmit(name, undefined);
            return {outcome: 'not-sent', ...failure(error)};
        }
        setSubmit(name, {...submit, state: 'pending'});
        return {outcome: 'pending', ...failure(error)};
    }
}

async function sendThreads(target: ReviewTarget, draft: ReviewDraft): Promise<ReviewResult> {
    const {api, name, number, head, changedFiles, signal} = target;
    const plan = planReview(draft, {threads: true, changedFiles});
    const problem = reviewProblem(draft.event, plan, 'threads');
    if (problem) return {outcome: 'not-sent', code: problem};
    let submit: ReviewSubmission = {id: newReviewSubmitId(), commitOid: head, route: 'threads', state: 'starting', threadKeys: []};
    setSubmit(name, submit);
    try {
        await api.start(number, submit.id, head, signal);
    } catch (error) {
        if (!isUnknown(error)) {
            setSubmit(name, undefined);
            return {outcome: 'not-sent', ...failure(error)};
        }
        submit = {...submit, state: 'start-unknown'};
        setSubmit(name, submit);
        return resolveStart(target, submit, error);
    }
    submit = {...submit, state: 'pending'};
    setSubmit(name, submit);
    for (const [index, thread] of plan.threads.entries()) {
        submit = {...submit, state: 'threading'};
        setSubmit(name, submit);
        try {
            await api.thread(number, submit.id, index, thread.path, thread.body, signal);
        } catch (error) {
            if (codeOf(error) === 'REVIEW_THREAD_REJECTED')
                update(name, current => ({...current, inBody: [...new Set([...current.inBody, thread.path])]}));
            if (codeOf(error) === 'REVIEW_STEP_CONFLICT') {
                // The proxy closed the submission because the pending review is gone.
                setSubmit(name, undefined);
                return {outcome: 'not-sent', ...failure(error)};
            }
            return discardAfter(target, submit, error);
        }
        submit = {...submit, state: 'pending', threadKeys: [...submit.threadKeys, thread.key]};
        setSubmit(name, submit);
    }
    submit = {...submit, state: 'pending'};
    return lastStep(target, submit, readReviewDraft(name));
}

/** After an unknown first step: a pending review that the step created is discarded. */
async function resolveStart(target: ReviewTarget, submit: ReviewSubmission, cause: unknown): Promise<ReviewResult> {
    const {api, name, number, signal} = target;
    let state: string | undefined;
    try {
        state = (await api.context(number, submit.id, signal)).submit?.state;
    } catch (error) {
        if (codeOf(error) === 'REVIEW_STEP_CONFLICT') return lost(target, submit);
        return {outcome: 'unknown', code: 'REVIEW_OUTCOME_UNKNOWN'};
    }
    if (state === 'closed') {
        setSubmit(name, undefined);
        return {outcome: 'not-sent', ...failure(cause)};
    }
    if (state === 'pending' || state === 'broken') return discardAfter(target, {...submit, state: 'pending'}, cause);
    return {outcome: 'unknown', code: 'REVIEW_OUTCOME_UNKNOWN'};
}

async function lost(target: ReviewTarget, submit: ReviewSubmission): Promise<ReviewResult> {
    let reviews: ReviewResult['reviews'] = [];
    try {
        reviews = (await target.api.context(target.number, undefined, target.signal)).reviews
            .filter(review => review.commitOid === submit.commitOid).map(({state, submittedAt}) => ({state, submittedAt}));
    } catch {
        // The person can still look on GitHub.
    }
    return {outcome: 'lost', code: 'REVIEW_STEP_CONFLICT', reviews};
}

async function sendBody(target: ReviewTarget, draft: ReviewDraft): Promise<ReviewResult> {
    const {api, name, number, head, signal} = target;
    const plan = planReview(draft, {threads: false, changedFiles: []});
    const problem = reviewProblem(draft.event, plan, 'body');
    if (problem) return {outcome: 'not-sent', code: problem};
    const submit: ReviewSubmission = {id: newReviewSubmitId(), commitOid: head, route: 'body', state: 'submitting', threadKeys: [],
        sent: bodyFingerprint(plan.body)};
    setSubmit(name, submit);
    try {
        const created = await api.create(number, submit.id, head, draft.event, plan.body, signal);
        finish(name);
        return {outcome: 'submitted', url: created.url};
    } catch (error) {
        if (isUnknown(error)) {
            setSubmit(name, {...submit, state: 'submit-unknown'});
            return {outcome: 'unknown', code: 'REVIEW_OUTCOME_UNKNOWN'};
        }
        setSubmit(name, undefined);
        return {outcome: 'not-sent', ...failure(error)};
    }
}

/**
 * Sends the draft, or, after the last step was refused (`pending`), sends that step again with the current event and
 * overall comment. A submission whose outcome is unknown, or whose pending review was left, is not sent again.
 */
export function sendReview(target: ReviewTarget): Promise<ReviewResult> {
    return exclusive(target, async () => {
        const draft = readReviewDraft(target.name);
        const submit = draft.submit;
        if (submit?.state === 'pending' && submit.route === 'threads') return lastStep(target, submit, draft);
        if (submit?.state === 'left') return {outcome: 'left', code: 'PENDING_REVIEW_LEFT'};
        if (submit) return {outcome: 'unknown', code: 'REVIEW_OUTCOME_UNKNOWN'};
        const route = reviewRoute(target.api);
        if (!route) return {outcome: 'not-sent', code: 'UNSUPPORTED'};
        const result = await (route === 'threads' ? sendThreads(target, draft) : sendBody(target, draft));
        // The GraphQL routes are off: nothing was sent, and the next send puts every comment in the body.
        if (result.code === 'GITHUB_API_UNAVAILABLE' && !reviewRoute(target.api)) return {...result, code: 'UNSUPPORTED'};
        return result;
    });
}

/** Finds out what happened to a submission whose outcome is unknown. Reading is safe to repeat. */
export function checkReview(target: ReviewTarget): Promise<ReviewResult> {
    return exclusive(target, async () => {
        const {api, name, number, signal} = target;
        const submit = readReviewDraft(name).submit;
        if (!submit) return {outcome: 'not-sent'};
        if (submit.route === 'body') {
            const login = api.account();
            try {
                for (let page = 1; page <= 10; page++) {
                    const reviews = await api.reviews(number, page, signal);
                    if (reviews.some(review => review.login === login && review.commitId === submit.commitOid &&
                        bodyFingerprint(review.body) === submit.sent)) {
                        finish(name);
                        return {outcome: 'submitted'};
                    }
                    if (reviews.length < 30) break;
                }
            } catch (error) {
                return {outcome: 'unknown', ...failure(error)};
            }
            setSubmit(name, undefined);
            return {outcome: 'closed'};
        }
        if (submit.state === 'start-unknown') return resolveStart(target, submit, new GitHubReviewError('UPSTREAM_FAILURE'));
        let state: string | undefined;
        try {
            state = (await api.context(number, submit.id, signal)).submit?.state;
        } catch (error) {
            if (codeOf(error) === 'REVIEW_STEP_CONFLICT') return lost(target, submit);
            return {outcome: 'unknown', ...failure(error)};
        }
        if (state === 'submitted') {
            finish(name);
            return {outcome: 'submitted'};
        }
        if (state === 'closed') {
            setSubmit(name, undefined);
            return {outcome: 'closed'};
        }
        if (state === 'pending') {
            setSubmit(name, {...submit, state: 'pending'});
            return {outcome: 'pending'};
        }
        if (state === 'broken') {
            setSubmit(name, {...submit, state: 'left'});
            return {outcome: 'left', code: 'PENDING_REVIEW_LEFT'};
        }
        return {outcome: 'unknown', code: 'REVIEW_OUTCOME_UNKNOWN'};
    });
}

/** Discards the submission's pending review on GitHub, when one was left or the last step was refused. */
export function discardReview(target: ReviewTarget): Promise<ReviewResult> {
    return exclusive(target, async () => {
        const {api, name, number, signal} = target;
        const submit = readReviewDraft(name).submit;
        if (!submit || submit.route !== 'threads' || (submit.state !== 'pending' && submit.state !== 'left'))
            return {outcome: 'not-sent', code: 'NOT_ALLOWED'};
        try {
            await api.discard(number, submit.id, signal);
        } catch (error) {
            // The proxy answers a repeated discard of a closed submission as a duplicate: read what it recorded.
            if (codeOf(error) === 'REVIEW_DUPLICATE' || codeOf(error) === 'REVIEW_STEP_CONFLICT') {
                try {
                    if ((await api.context(number, submit.id, signal)).submit?.state === 'closed') {
                        setSubmit(name, undefined);
                        return {outcome: 'not-sent'};
                    }
                } catch (check) {
                    if (codeOf(check) === 'REVIEW_STEP_CONFLICT') return lost(target, submit);
                }
            }
            setSubmit(name, {...submit, state: 'left'});
            return {outcome: 'left', code: 'PENDING_REVIEW_LEFT', ...(failure(error).retryAfter !== undefined && {retryAfter: failure(error).retryAfter})};
        }
        setSubmit(name, undefined);
        return {outcome: 'not-sent'};
    });
}

/** Forgets a submission the proxy no longer knows, keeping the words. Anything left on GitHub is handled there. */
export function forgetReviewSubmission(name: string) {
    setSubmit(name, undefined);
}
