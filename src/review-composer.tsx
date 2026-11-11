import React, {useEffect, useRef, useState} from 'react';
import {CloseButton} from './close-button.js';
import {reviewEvents} from './github-review-api.js';
import type {GitHubReviewApi} from './github-review-api.js';
import {reviewLabelsFor} from './messages.js';
import type {ReviewLabels} from './messages.js';
import {
    checkReview, discardReview, forgetReviewSubmission, planReview, probeReviewRoutes, readReviewDraft, reviewDraftPersistent,
    reviewProblem, reviewRoute, sendReview, subscribeReviewDraft, writeReviewDraft
} from './review-submit.js';
import type {ReviewDraft, ReviewResult} from './review-submit.js';

/** The saved draft of a review, updated when any view of the same review writes it. */
export function useReviewDraft(name: string | undefined): ReviewDraft | null {
    const [, refresh] = useState(0);
    useEffect(() => name ? subscribeReviewDraft(name, () => refresh(count => count + 1)) : undefined, [name]);
    return name ? readReviewDraft(name) : null;
}

/** Changes the saved draft from what is stored now, so other views' words are kept. */
export function changeReviewDraft(name: string, change: (draft: ReviewDraft) => ReviewDraft) {
    writeReviewDraft(name, change(readReviewDraft(name)));
}

const sessionCodes = ['SESSION_REQUIRED', 'SESSION_EXPIRED', 'REAUTH_REQUIRED', 'SESSION_UNAVAILABLE', 'INVALID_SESSION'];

function resultMessage(result: ReviewResult, labels: ReviewLabels) {
    const code = result.code;
    if (code === 'RATE_LIMITED') return labels.RATE_LIMITED.replace('{seconds}', String(result.retryAfter ?? 60));
    if (result.outcome === 'submitted') return labels.sent;
    if (result.outcome === 'closed') return labels.closed;
    if (result.outcome === 'lost') return labels.lost.replace('{count}', String(result.reviews?.length ?? 0));
    if (result.outcome === 'left') return labels.PENDING_REVIEW_LEFT;
    if (result.outcome === 'unknown') return labels.REVIEW_OUTCOME_UNKNOWN;
    if (code && sessionCodes.includes(code)) return labels.session;
    if (code === 'PENDING_REVIEW_EXISTS' || code === 'REVIEW_REJECTED' || code === 'REVIEW_THREAD_REJECTED' || code === 'EMPTY_REVIEW' ||
        code === 'TOO_LONG' || code === 'FORBIDDEN' || code === 'GITHUB_API_UNAVAILABLE') {
        const message = labels[code];
        return result.outcome === 'pending' ? labels.pending + ' ' + message : message;
    }
    if (code === 'UNSUPPORTED') return labels.unsupported;
    if (result.outcome === 'pending') return labels.pending;
    if (result.outcome === 'not-sent' && !code) return labels.discarded;
    return labels.failed;
}

/**
 * The overall comment, the result, how the code comments will be sent, and the send button of a pull request review.
 * The code comments are written under each code change of the review that shares `name`.
 */
export function PullRequestReviewComposer({api, name, number, head, changedFiles, url, locale}: {
    api: GitHubReviewApi;
    /** Where the draft is kept, such as `owner/repo#42`. */
    name: string;
    number: number;
    /** The compared head commit. */
    head: string;
    changedFiles: readonly string[];
    /** The pull request on GitHub. */
    url: string;
    locale: string;
}) {
    const labels = reviewLabelsFor(locale);
    const draft = useReviewDraft(name)!;
    const [route, setRoute] = useState(() => reviewRoute(api));
    const [busy, setBusy] = useState<'send' | 'check' | null>(null);
    const [result, setResult] = useState<ReviewResult | null>(null);
    const [blocked, setBlocked] = useState(false);
    const active = useRef(true);
    useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
    const target = {api, name, number, head, changedFiles};

    const run = async (kind: 'send' | 'check', action: () => Promise<ReviewResult>) => {
        if (busy || blocked) return;
        setBusy(kind);
        setResult(null);
        let next: ReviewResult;
        try {
            next = await action();
        } catch {
            next = {outcome: 'not-sent', code: 'NETWORK_ERROR'};
        }
        if (!active.current) return;
        setBusy(null);
        setRoute(reviewRoute(api));
        if (next.code === 'BUSY') return;
        setResult(next);
        if (next.retryAfter) {
            setBlocked(true);
            setTimeout(() => {if (active.current) setBlocked(false);}, next.retryAfter * 1000);
        }
    };

    // Ask once which routes the connection offers, and settle a submission whose outcome was unknown when the page closed.
    useEffect(() => {
        const controller = new AbortController();
        void (async () => {
            await probeReviewRoutes(api, number, controller.signal);
            if (controller.signal.aborted) return;
            setRoute(reviewRoute(api));
            const state = readReviewDraft(name).submit?.state;
            if (state === 'start-unknown' || state === 'submit-unknown') await run('check', () => checkReview(target));
        })();
        return () => controller.abort();
    }, [api, name, number]);
    // The comments were written for the head they were first written on.
    const hasWords = !!draft.body || Object.values(draft.comments).some(comment => comment.body);
    useEffect(() => {
        if (hasWords && !draft.head) changeReviewDraft(name, current => ({...current, head}));
    }, [hasWords, draft.head, head, name]);

    const submit = draft.submit;
    const plan = planReview(draft, {threads: route === 'threads' && submit?.state !== 'pending', changedFiles, exclude: submit?.threadKeys});
    const threads = submit?.state === 'pending' ? submit.threadKeys.length : route === 'threads' ? plan.threads.length : 0;
    const comments = (submit?.state === 'pending' ? submit.threadKeys.length : 0) + plan.threads.length + plan.inBody.length;
    const problem = route && reviewProblem(draft.event, {...plan, threads: Array.from({length: threads}, () => ({key: '', path: '', body: ''}))},
        route);
    const disabled = !!busy || blocked;
    const message = result && resultMessage(result, labels);
    const failed = result && result.outcome !== 'submitted' && !(result.outcome === 'not-sent' && !result.code);
    const pullLink = <a href={url} target="_blank" rel="noreferrer">{labels.openPullRequest}</a>;

    return <section className="twgit-review-composer" aria-label={labels.composer} data-git-review-composer="">
        <h3>{labels.composer}</h3>
        {!reviewDraftPersistent() && <p role="status" className="twgit-review-note">{labels.notStored}</p>}
        {draft.head && draft.head !== head && <p role="status" className="twgit-review-note">{labels.headChanged}{' '}
            <button type="button" onClick={() => changeReviewDraft(name, current => ({...current, head}))}>{labels.useVersion}</button></p>}
        <label className="twgit-review-field">{labels.overall}
            <textarea value={draft.body} rows={4} onChange={event => {
                const body = event.currentTarget.value;
                changeReviewDraft(name, current => ({...current, body}));
            }}/></label>
        <fieldset className="twgit-review-events">
            <legend>{labels.event}</legend>
            {reviewEvents.map(event => <label key={event}><input type="radio" name={`twgit-review-event-${name}`} value={event}
                checked={draft.event === event} onChange={() => changeReviewDraft(name, current => ({...current, event}))}/> {labels[event]}</label>)}
        </fieldset>
        {route === null ? <p role="status">{labels.unsupported}</p> : <>
            {(!submit || submit.state === 'pending') && <p className="twgit-review-summary" data-git-review-summary="">{!comments ? labels.summaryNone :
                route === 'threads' ? labels.summaryThreads.replace('{threads}', String(threads)).replace('{body}', String(plan.inBody.length)) :
                    labels.summaryBody.replace('{body}', String(plan.inBody.length))}</p>}
            <div className="twgit-review-actions">
                {(!submit || submit.state === 'pending') && <button type="button" data-git-review-send="" disabled={disabled || !!problem}
                    title={problem ? resultMessage({outcome: 'not-sent', code: problem}, labels) : undefined}
                    onClick={() => void run('send', () => sendReview(target))}>{submit ? labels.sendAgain : labels.send}</button>}
                {(submit?.state === 'start-unknown' || submit?.state === 'submit-unknown') &&
                    <button type="button" disabled={disabled} onClick={() => void run('check', () => checkReview(target))}>{labels.check}</button>}
                {(submit?.state === 'pending' || submit?.state === 'left') &&
                    <button type="button" disabled={disabled} onClick={() => void run('send', () => discardReview(target))}>{labels.discard}</button>}
                {(submit?.state === 'left' || result?.outcome === 'lost') && <>
                    {pullLink}
                    <button type="button" disabled={disabled} onClick={() => {forgetReviewSubmission(name); setResult(null);}}>{labels.forget}</button>
                </>}
            </div>
            {busy && <p role="status">{busy === 'send' ? labels.sending : labels.checking}</p>}
            {!busy && !result && submit && <p role="status" className="twgit-review-state">
                {submit.state === 'pending' ? labels.pending : submit.state === 'left' ? labels.PENDING_REVIEW_LEFT : labels.REVIEW_OUTCOME_UNKNOWN}</p>}
            {message && result && <div className={failed ? 'twgit-review-result twgit-error' : 'twgit-review-result twgit-context'}
                role={failed ? 'alert' : 'status'}>
                <p>{message}{result.code === 'PENDING_REVIEW_EXISTS' && <> {pullLink}</>}
                    {result.outcome === 'submitted' && result.url && <> <a href={result.url} target="_blank" rel="noreferrer">{labels.openReview}</a></>}</p>
                <CloseButton label={labels.dismiss} onClick={() => setResult(null)}/>
            </div>}
        </>}
    </section>;
}
