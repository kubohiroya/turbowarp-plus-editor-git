import type {PublicationIntent, PullRequestObservation} from './pull-request-queue.js';
import {pinPublicationPushSession} from './project-publication.js';
import type {PublicationBridge, PublicationJob, PublicationPushSession, PublicationStackParent, PublicationTarget,
    ReadPublicationPushSession}
    from './project-publication.js';

type PublicationResult = {approval: 'pending' | 'approved' | 'expired' | 'missing';
    job: PublicationJob | null; intent?: PublicationIntent};
type PublicationRepository = Awaited<ReturnType<PublicationBridge['repository']>>;

const prefix = '/v1/github-publication';
const approvalPath = /^\/v1\/github-publication\/approval\/[a-f0-9]{64}\/([a-f0-9-]{36})\/[A-Za-z0-9_-]{43}$/u;
const isOrigin = (value: string) => URL.parse(value)?.origin === value && value.startsWith('https://');
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function errorFor(status: number) {
    switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'SESSION_REQUIRED';
    case 403: return 'FORBIDDEN';
    case 404: return 'GIT_UNAVAILABLE';
    case 409: return 'PUBLICATION_CHANGED';
    case 429: return 'RATE_LIMITED';
    default: return 'PUBLICATION_FAILED';
    }
}

export function createCloudflarePublicationBridge<Session extends PublicationPushSession>({
    view, bffOrigin, proxyOrigin, getSession, send = fetch, delay = pause
}: {
    view: Pick<Window, 'open'>;
    bffOrigin: string;
    proxyOrigin: string;
    getSession: ReadPublicationPushSession<Session>;
    send?: typeof fetch;
    delay?(ms: number): Promise<void>;
}): PublicationBridge & {bindPushSession(job: PublicationJob): ReadPublicationPushSession<Session>} {
    if (!isOrigin(bffOrigin) || !isOrigin(proxyOrigin)) throw new Error('GIT_UNAVAILABLE');
    const pushSessions = new WeakMap<PublicationJob, {remote: string; session: Session}>();
    async function sessionFor(remote: string) {
        const session = await getSession(remote, true);
        if (!session || session.connection.mode !== 'cloudflare' || session.connection.proxyOrigin !== proxyOrigin ||
            !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u.test(session.bearer) || session.expiresAt <= Date.now()) {
            throw new Error('SESSION_REQUIRED');
        }
        return session;
    }
    async function post<T>(route: '/repository' | '/stack-parent' | '/jobs' | '/jobs/status' | '/jobs/advance' |
        '/merge/checks' | '/merge/status' | '/merge', remote: string, body: object, session?: Session, signal?: AbortSignal) {
        session ??= await sessionFor(remote);
        const timeout = AbortSignal.timeout(30_000);
        const response = await send(bffOrigin + prefix + route, {
            method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            headers: {Authorization: 'Bearer ' + session.bearer, 'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            if (route === '/jobs/advance' && response.status === 403 &&
                (await response.json().catch(() => null))?.code === 'APPROVAL_REQUIRED') throw new Error('APPROVAL_REQUIRED');
            throw new Error(errorFor(response.status));
        }
        const value = await response.json();
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PUBLICATION_FAILED');
        return value as T;
    }
    async function status(target: PublicationTarget) {
        const result = await post<PublicationResult>('/jobs/status', target.remote, target);
        if (!['pending', 'approved', 'expired', 'missing'].includes(result.approval) ||
            result.approval === 'approved' && !result.job) throw new Error('PUBLICATION_FAILED');
        return result;
    }
    return {
        approval: 'browser',
        async pullRequestChecks(remote, number, signal) {
            return post<{head: string; base: string; checks: PullRequestObservation['checks']}>('/merge/checks', remote,
                {remote, number}, undefined, signal);
        },
        async mergeStatus(remote, number, signal) {
            return post<PullRequestObservation>('/merge/status', remote, {remote, number}, undefined, signal);
        },
        async mergePullRequest(remote, expected) {
            return post<{state: 'accepted' | 'merged' | 'rejected'}>('/merge', remote, {remote, expected});
        },
        async repository(remote) {
            const result = await post<PublicationRepository>('/repository', remote, {remote});
            if (!Number.isSafeInteger(result.repositoryId) || result.repositoryId < 1 || !Array.isArray(result.capabilities) ||
                !result.capabilities.includes('pulls-read') || !result.capabilities.includes('pulls-write')) {
                throw new Error('GIT_UNAVAILABLE');
            }
            return result;
        },
        async get(target) {
            const result = await status(target);
            return result.approval === 'approved' ? result.job : {job: null, approvalIntent:
                result.approval === 'missing' ? undefined : result.intent};
        },
        async stackParent(remote, number, repositoryId) {
            const result = await post<{parent: PublicationStackParent | null}>('/stack-parent', remote, {remote, number, repositoryId});
            return result.parent;
        },
        async enqueue(intent, current = () => true) {
            if (!current()) return null;
            // The submit event's transient activation must still be present.
            const popup = view.open('about:blank', '_blank');
            if (!popup) throw new Error('PUBLICATION_POPUP');
            popup.opener = null;
            try {
                const {approvalUrl, job} = await post<{approvalUrl: string | null; job: PublicationJob | null}>(
                    '/jobs', intent.remote, {intent});
                if (job && approvalUrl === null) return job;
                if (!current() || popup.closed) return null;
                const url = typeof approvalUrl === 'string' ? URL.parse(approvalUrl) : null;
                const match = url && approvalPath.exec(url.pathname);
                if (!url || url.origin !== bffOrigin || url.username || url.password || url.search || url.hash ||
                    !match || match[1] !== intent.id) throw new Error('PUBLICATION_APPROVAL_URL');
                popup.location.replace(url.href);
                const {id, remote, repositoryId} = intent;
                const deadline = Date.now() + 10 * 60_000;
                while (current() && Date.now() < deadline) {
                    const latest = await status({id, remote, repositoryId});
                    if (latest.approval === 'approved') return latest.job;
                    // GitHub's OAuth navigation may sever the popup handle while consent is in progress.
                    if (latest.approval === 'expired' || latest.approval === 'missing') return null;
                    await delay(1500);
                }
                return null;
            } finally {
                popup.close();
            }
        },
        async advance(target) {
            const session = await sessionFor(target.remote);
            const job = await post<PublicationJob>('/jobs/advance', target.remote, target, session);
            if (job.awaitingPush) pushSessions.set(job, {remote: target.remote, session});
            return job;
        },
        bindPushSession(job) {
            const authorized = pushSessions.get(job);
            pushSessions.delete(job);
            if (!authorized) throw new Error('SESSION_REQUIRED');
            return pinPublicationPushSession(getSession, authorized.remote, authorized.session);
        }
    };
}
