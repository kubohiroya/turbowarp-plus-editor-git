import type {HttpClient} from 'isomorphic-git';

export const MAX_GIT_REQUEST_BYTES = 32 * 1024 * 1024;

type Connection = Readonly<{mode: 'desktop' | 'cloudflare'; proxyOrigin: string}>;
type Session = Readonly<{connection: Connection; bearer: string; expiresAt: number}>;

export interface GitSmartHttpOptions {
    readonly remote: string;
    readonly connection: Connection;
    readonly getSession: () => Promise<Session | null>;
    readonly maxRequestBytes?: number;
    readonly signal?: AbortSignal;
    readonly fetch?: typeof fetch;
}

type Request = {
    url: string;
    method?: string;
    body?: AsyncIterable<Uint8Array>;
    signal?: AbortSignal;
};

const proxyCodes = {
    400: ['BAD_REQUEST'],
    401: ['SESSION_REQUIRED', 'SESSION_EXPIRED', 'REAUTH_REQUIRED'],
    403: ['FORBIDDEN'],
    409: ['REDIRECT_REJECTED'],
    411: ['LENGTH_REQUIRED'],
    413: ['PAYLOAD_TOO_LARGE'],
    429: ['RATE_LIMITED'],
    502: ['UPSTREAM_FAILURE'],
    504: ['UPSTREAM_TIMEOUT']
} as const;

type ProxyErrorCode = (typeof proxyCodes)[keyof typeof proxyCodes][number];
export type GitSmartHttpErrorCode = ProxyErrorCode | 'INVALID_REMOTE' | 'INVALID_REQUEST' |
    'INVALID_CONNECTION' | 'INVALID_SESSION' | 'SESSION_UNAVAILABLE' | 'ABORTED' | 'NETWORK_ERROR' |
    'INVALID_RESPONSE' | 'PUSH_OUTCOME_UNKNOWN';

export class GitSmartHttpError extends Error {
    constructor(readonly code: GitSmartHttpErrorCode, readonly statusCode?: number, readonly requestId?: string) {
        super(code);
        this.name = 'GitSmartHttpError';
    }
}

function remoteUrl(remote: string) {
    // Validate the raw URL before a URL parser can discard dot segments, whitespace, or a default port.
    const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(remote);
    if (!match || match[0] !== remote || ['.', '..', '.git'].includes(match[2].toLowerCase())) {
        throw new GitSmartHttpError('INVALID_REMOTE');
    }
    return `https://github.com/${match[1]}/${match[2]}.git`;
}

function checkConnection({mode, proxyOrigin}: Connection) {
    const url = URL.parse(proxyOrigin);
    if (!url || url.origin !== proxyOrigin ||
        (mode === 'desktop' ? !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(proxyOrigin) :
            mode !== 'cloudflare' || url.protocol !== 'https:')) {
        throw new GitSmartHttpError('INVALID_CONNECTION');
    }
}

function checkAbort(signal?: AbortSignal) {
    if (signal?.aborted) throw new GitSmartHttpError('ABORTED');
}

async function boundedBody(source: AsyncIterable<Uint8Array>, limit: number, signal?: AbortSignal) {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    for await (const bytes of source) {
        checkAbort(signal);
        size += bytes.byteLength;
        if (size > limit) throw new GitSmartHttpError('PAYLOAD_TOO_LARGE');
        parts.push(bytes.slice());
    }
    return new Blob(parts);
}

async function* responseBytes(body: ReadableStream<Uint8Array>, code: GitSmartHttpErrorCode, signal?: AbortSignal) {
    const reader = body.getReader();
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) return;
            yield value;
        }
    } catch {
        if (code !== 'PUSH_OUTCOME_UNKNOWN') checkAbort(signal);
        throw new GitSmartHttpError(code);
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

async function proxyError(response: Response, writing: boolean) {
    const status = response.status;
    const allowed: readonly ProxyErrorCode[] | undefined = proxyCodes[status as keyof typeof proxyCodes];
    let code: GitSmartHttpErrorCode = allowed?.[0] ?? 'INVALID_RESPONSE';
    let requestId: string | undefined;
    if (response.body && response.headers.get('content-type')?.split(';')[0] === 'application/json') {
        try {
            const body = await boundedBody(responseBytes(response.body, 'INVALID_RESPONSE'), 4096);
            const parsed = JSON.parse(await body.text());
            if (writing && status === 409 && parsed?.code === 'PUSH_DUPLICATE') code = 'PUSH_OUTCOME_UNKNOWN';
            else if (allowed?.includes(parsed?.code)) code = parsed.code;
            if (typeof parsed?.requestId === 'string' &&
                /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(parsed.requestId)) {
                requestId = parsed.requestId;
            }
        } catch {
            // Untrusted error bodies never become part of a client error.
        }
    } else {
        await response.body?.cancel().catch(() => {});
    }
    if (writing && (!allowed || status >= 500)) code = 'PUSH_OUTCOME_UNKNOWN';
    return new GitSmartHttpError(code, status, requestId);
}

export function createGitSmartHttp(options: GitSmartHttpOptions) {
    const url = remoteUrl(options.remote);
    const connection = {...options.connection};
    checkConnection(connection);
    const {getSession, maxRequestBytes = MAX_GIT_REQUEST_BYTES, signal: operationSignal, fetch: send = fetch} = options;
    if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0 || maxRequestBytes > MAX_GIT_REQUEST_BYTES) {
        throw new GitSmartHttpError('INVALID_CONNECTION');
    }
    const proxyPath = connection.proxyOrigin + '/v1/git' + url.slice('https://github.com'.length);
    const request = async ({url: requested, method = 'GET', body, signal}: Request) => {
        const path = requested.startsWith(url + '/') ? requested.slice(url.length) : '';
        const discovery = method === 'GET' && !body;
        const rpc = method === 'POST' && Boolean(body);
        const service = ['git-upload-pack', 'git-receive-pack'].find(name =>
            (discovery && path === `/info/refs?service=${name}`) || (rpc && path === `/${name}`));
        if (!service) throw new GitSmartHttpError('INVALID_REQUEST');

        const abort = signal && operationSignal ? AbortSignal.any([signal, operationSignal]) : signal ?? operationSignal;
        checkAbort(abort);
        const payload = body ? await boundedBody(body, maxRequestBytes, abort) : undefined;
        checkAbort(abort);
        let session: Session | null;
        try {
            session = await getSession();
        } catch {
            checkAbort(abort);
            throw new GitSmartHttpError('SESSION_UNAVAILABLE');
        }
        checkAbort(abort);
        if (!session) throw new GitSmartHttpError('SESSION_REQUIRED');
        if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
            throw new GitSmartHttpError('SESSION_EXPIRED');
        }
        if (session.connection?.mode !== connection.mode || session.connection.proxyOrigin !== connection.proxyOrigin ||
            typeof session.bearer !== 'string' || !/^[A-Za-z0-9._~+\/-]+=*$/u.test(session.bearer)) {
            throw new GitSmartHttpError('INVALID_SESSION');
        }
        const contentType = `application/x-${service}-${discovery ? 'advertisement' : 'result'}`;
        const headers = new Headers({Authorization: `Bearer ${session.bearer}`, Accept: contentType});
        if (payload) headers.set('Content-Type', `application/x-${service}-request`);
        const writing = rpc && service === 'git-receive-pack';
        if (writing) headers.set('Git-Push-Id', crypto.randomUUID());

        let response: Response;
        try {
            response = await send(proxyPath + path, {
                method, headers, body: payload, signal: abort, credentials: 'omit', redirect: 'error', cache: 'no-store',
                referrerPolicy: 'no-referrer'
            });
        } catch {
            if (writing) throw new GitSmartHttpError('PUSH_OUTCOME_UNKNOWN');
            checkAbort(abort);
            throw new GitSmartHttpError('NETWORK_ERROR');
        }
        if (response.status !== 200) throw await proxyError(response, writing);
        if (!response.body || response.headers.get('content-type') !== contentType) {
            await response.body?.cancel().catch(() => {});
            throw new GitSmartHttpError(writing ? 'PUSH_OUTCOME_UNKNOWN' : 'INVALID_RESPONSE');
        }
        return {
            url: requested, method, headers: {'content-type': contentType},
            statusCode: 200, statusMessage: 'OK',
            body: responseBytes(response.body, writing ? 'PUSH_OUTCOME_UNKNOWN' : 'NETWORK_ERROR', abort)
        };
    };
    return {url, corsProxy: '' as const, http: {request} satisfies HttpClient};
}
