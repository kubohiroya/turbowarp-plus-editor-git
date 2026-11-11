// A stand-in for the GitHub connection's review routes (/v1/github/<owner>/<repo>/…) and the GitHub state behind them.
// It follows the merged proxy contract: the submission record and its steps, Review-Submit-Id duplicates, and the
// error bodies {code, requestId, retryAfter?}. It needs no Node.js modules, so a browser test page can use it too.

export const reviewRemote = 'https://github.com/fixture/work.git';
export const reviewProxyOrigin = 'http://127.0.0.1:4567';
export const reviewBearer = 'r'.repeat(43);
const prefix = '/v1/github/fixture/work';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const finished = ['submitted', 'closed'];

export function reviewSession(login = 'reviewer') {
    return {connection: {mode: 'desktop', proxyOrigin: reviewProxyOrigin}, account: {login}, bearer: reviewBearer,
        expiresAt: Date.now() + 60_000};
}

/**
 * `fixture.fetch` answers like the proxy. Push `{operation, status, code, apply, retryAfter, then}` on `fixture.faults`
 * to make the next matching request fail: with `apply`, GitHub applies the step and the answer is lost. Operations are
 * the GraphQL operation names, `reviews` and `createReview`. `then(fixture)` runs after the step.
 */
export function createReviewFixture({head = 'b'.repeat(40), number = 42, groups = ['pulls-read', 'review-threads', 'reviews-body'],
    login = 'reviewer', delay = 0} = {}) {
    const fixture = {
        head, number, login, groups: new Set(groups), requests: [], faults: [], records: new Map(), reviewIds: new Set(),
        /** The viewer's pending review on GitHub, with its threads. `ours` marks one that this fixture's steps did not make. */
        pending: null,
        /** Published reviews, oldest first. */
        reviews: [], active: 0, maxActive: 0, nextReview: 1
    };
    const reply = (status, code, extra = {}) => new Response(JSON.stringify({code, requestId: crypto.randomUUID(), ...extra}),
        {status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});
    const ok = value => new Response(JSON.stringify(value), {status: 200, headers: {'Content-Type': 'application/json'}});
    const context = (submitId, submit) => {
        const record = submitId && fixture.records.get(submitId);
        const pending = fixture.pending;
        return {
            headRefOid: fixture.head, viewer: fixture.login,
            pendingReview: pending ? {ours: !!record && pending.id === record.reviewId, commitOid: pending.commitOid,
                createdAt: '2026-11-11T00:00:00Z'} : null,
            reviews: [...fixture.reviews].reverse().map(review => ({state: review.state, commitOid: review.commitOid,
                submittedAt: review.submittedAt, ours: !!record && review.id === record.reviewId})),
            ...(submit && {submit})
        };
    };
    const fault = operation => {
        const index = fixture.faults.findIndex(item => item.operation === operation);
        return index < 0 ? null : fixture.faults.splice(index, 1)[0];
    };
    const failWith = (item, effect, outcome) => {
        if (item.apply) effect();
        outcome(item.apply);
        item.then?.(fixture);
        return reply(item.status, item.code, item.retryAfter === undefined ? {} : {retryAfter: item.retryAfter});
    };

    async function handle(url, init) {
        const {pathname, search} = new URL(url);
        const method = init.method ?? 'GET';
        const headers = new Headers(init.headers);
        const submitId = headers.get('review-submit-id');
        const body = init.body === undefined ? undefined : JSON.parse(init.body);
        const route = pathname.slice(prefix.length);
        const graphql = /^\/graphql\/([A-Za-z]+)$/u.exec(route)?.[1];
        const operation = graphql ?? (method === 'POST' ? 'createReview' : 'reviews');
        fixture.requests.push({operation, method, route: route + search, submitId, body,
            init: {credentials: init.credentials, redirect: init.redirect, cache: init.cache, referrerPolicy: init.referrerPolicy}});
        if (!pathname.startsWith(prefix + '/')) return reply(400, 'BAD_REQUEST');
        const group = graphql ? 'review-threads' : 'reviews-body';
        if (!fixture.groups.has(group)) return reply(404, 'GITHUB_API_UNAVAILABLE');
        if (headers.get('authorization') !== 'Bearer ' + reviewBearer) return reply(401, 'SESSION_REQUIRED');
        if (submitId !== null && !uuid.test(submitId)) return reply(400, 'BAD_REQUEST');
        const item = fault(operation);

        if (!graphql) {
            const match = /^\/pulls\/([1-9][0-9]*)\/reviews$/u.exec(route);
            if (!match || Number(match[1]) !== fixture.number) return reply(404, 'PULL_REQUEST_NOT_FOUND');
            if (method === 'GET') {
                if (item) return reply(item.status, item.code, item.retryAfter === undefined ? {} : {retryAfter: item.retryAfter});
                const page = Number(new URLSearchParams(search).get('page'));
                return ok(fixture.reviews.slice((page - 1) * 30, page * 30).map(review => ({id: review.number, user: {login: review.login},
                    commit_id: review.commitOid, state: review.state, submitted_at: review.submittedAt, body: review.body})));
            }
            if (!submitId) return reply(400, 'BAD_REQUEST');
            if (fixture.reviewIds.has(submitId) || fixture.records.has(submitId)) return reply(409, 'REVIEW_DUPLICATE');
            fixture.reviewIds.add(submitId);
            const publish = () => fixture.reviews.push({id: 'R' + fixture.nextReview, number: fixture.nextReview++, login: fixture.login,
                commitOid: body.commit_id, state: body.event === 'APPROVE' ? 'APPROVED' : body.event === 'REQUEST_CHANGES' ?
                    'CHANGES_REQUESTED' : 'COMMENTED', submittedAt: '2026-11-11T00:00:01Z', body: body.body, threads: []});
            if (item) return failWith(item, publish, () => {});
            publish();
            const review = fixture.reviews.at(-1);
            return ok({id: review.number, state: review.state, commit_id: review.commitOid, submitted_at: review.submittedAt,
                html_url: `https://github.com/fixture/work/pull/${fixture.number}#pullrequestreview-${review.number}`});
        }

        if (body.number !== fixture.number) return reply(404, 'PULL_REQUEST_NOT_FOUND');
        if (graphql === 'pullRequestReviewContext') {
            if (item) return reply(item.status, item.code, item.retryAfter === undefined ? {} : {retryAfter: item.retryAfter});
            if (!submitId) return ok(context(null));
            const record = fixture.records.get(submitId);
            if (!record) return reply(409, 'REVIEW_STEP_CONFLICT');
            if (record.state === 'start-unknown') {
                const created = fixture.pending;
                if (created && created.commitOid === record.commitOid && !created.body && !created.threads.length) {
                    record.reviewId = created.id;
                    record.state = 'pending';
                } else record.state = 'closed';
            } else if (record.state === 'submit-unknown') {
                const published = fixture.reviews.find(review => review.id === record.reviewId);
                record.state = fixture.pending?.id === record.reviewId ? 'pending' : published ? 'submitted' : 'closed';
            }
            return ok(context(submitId, {state: record.state, threads: record.threads}));
        }
        if (!submitId) return reply(400, 'BAD_REQUEST');
        const record = fixture.records.get(submitId);

        if (graphql === 'addPullRequestReview') {
            if (record || fixture.reviewIds.has(submitId)) return reply(409, 'REVIEW_DUPLICATE');
            if ([...fixture.records.values()].some(other => !finished.includes(other.state))) return reply(409, 'REVIEW_STEP_CONFLICT');
            const created = {submitId, commitOid: body.commitOid, state: 'starting', threads: 0, reviewId: null};
            fixture.records.set(submitId, created);
            if (fixture.pending) {
                created.state = 'closed';
                return reply(409, 'PENDING_REVIEW_EXISTS');
            }
            const make = () => {
                fixture.pending = {id: 'P' + fixture.nextReview, number: fixture.nextReview++, commitOid: body.commitOid, body: '', threads: []};
                created.reviewId = fixture.pending.id;
            };
            if (item) return failWith(item, make, applied => {created.state = applied || item.status >= 500 ? 'start-unknown' : 'closed';});
            make();
            created.state = 'pending';
            return ok({state: 'PENDING', commitOid: body.commitOid});
        }

        if (!record) return reply(409, 'REVIEW_STEP_CONFLICT');
        if (graphql === 'addPullRequestReviewThread') {
            if (body.threadIndex < record.threads || (record.state === 'broken' && body.threadIndex === record.threads))
                return reply(409, 'REVIEW_DUPLICATE');
            if (record.state !== 'pending' || body.threadIndex !== record.threads) return reply(409, 'REVIEW_STEP_CONFLICT');
            const add = () => fixture.pending.threads.push({path: body.path, body: body.body});
            if (item) return failWith(item, add, () => {record.state = 'broken';});
            add();
            record.threads++;
            return ok({threads: record.threads});
        }
        if (graphql === 'submitPullRequestReview') {
            if (['submitting', 'submit-unknown', 'submitted'].includes(record.state)) return reply(409, 'REVIEW_DUPLICATE');
            if (record.state !== 'pending' || body.threadCount !== record.threads) return reply(409, 'REVIEW_STEP_CONFLICT');
            if (!fixture.pending || fixture.pending.id !== record.reviewId) {
                record.state = 'closed';
                return reply(409, 'REVIEW_STEP_CONFLICT');
            }
            const publish = () => {
                const pending = fixture.pending;
                fixture.pending = null;
                fixture.reviews.push({...pending, login: fixture.login, body: body.body, submittedAt: '2026-11-11T00:00:02Z',
                    state: body.event === 'APPROVE' ? 'APPROVED' : body.event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED'});
            };
            if (item) return failWith(item, publish, applied => {record.state = applied || item.status >= 500 ? 'submit-unknown' : 'pending';});
            publish();
            record.state = 'submitted';
            const review = fixture.reviews.at(-1);
            return ok({state: review.state, commitOid: review.commitOid, submittedAt: review.submittedAt,
                url: `https://github.com/fixture/work/pull/${fixture.number}#pullrequestreview-${review.number}`});
        }
        if (graphql === 'deletePullRequestReview') {
            if (['deleting', 'closed'].includes(record.state)) return reply(409, 'REVIEW_DUPLICATE');
            if (record.state !== 'pending' && record.state !== 'broken') return reply(409, 'REVIEW_STEP_CONFLICT');
            const remove = () => {if (fixture.pending?.id === record.reviewId) fixture.pending = null;};
            if (item) return failWith(item, remove, () => {});
            remove();
            record.state = 'closed';
            return ok({deleted: true});
        }
        return reply(400, 'BAD_REQUEST');
    }

    fixture.fetch = async (url, init = {}) => {
        fixture.active++;
        fixture.maxActive = Math.max(fixture.maxActive, fixture.active);
        try {
            await new Promise(resolve => setTimeout(resolve, delay));
            const item = fixture.faults[0];
            if (item?.network && item.operation === (/\/graphql\/([A-Za-z]+)$/u.exec(new URL(url).pathname)?.[1] ??
                (init.method === 'POST' ? 'createReview' : 'reviews'))) {
                // The request reaches the proxy, but the answer is lost.
                fixture.faults.shift();
                await handle(url, init);
                throw new TypeError('Failed to fetch');
            }
            return await handle(url, init);
        } finally {
            fixture.active--;
        }
    };
    return fixture;
}
