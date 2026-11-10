import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Git's detached auto maintenance can repack loose objects while the code under test is reading them.
const gitEnv = {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0'};
const backend = join(execFileSync('git', ['--exec-path'], {encoding: 'utf8'}).trim(), 'git-http-backend');
export const remote = 'https://github.com/fixture/work.git';
export const readDiscovery = '/info/refs?service=git-upload-pack';
export const writeDiscovery = '/info/refs?service=git-receive-pack';
const routePrefix = '/v1/git/fixture/work.git';
const maxBody = 1024 * 1024;
const pushIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function git(dir, ...args) {
    return execFileSync('git', args, {cwd: dir, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

export function commit(dir, message) {
    git(dir, 'add', 'project.txt');
    git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message);
    return git(dir, 'rev-parse', 'HEAD');
}

export async function startFixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'tw-git-http-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    await mkdir(join(root, 'fixture'));
    const bare = join(root, 'fixture/work.git');
    const seed = join(root, 'seed');
    const client = join(root, 'client');
    git(root, 'init', '-q', '--bare', '-b', 'main', bare);
    git(bare, 'config', 'http.receivepack', 'true');
    git(root, 'init', '-q', '-b', 'main', seed);
    await writeFile(join(seed, 'project.txt'), 'initial\n');
    commit(seed, 'initial');
    git(seed, 'push', bare, 'main');
    git(root, 'clone', '-q', bare, client);
    git(client, 'remote', 'set-url', 'origin', remote);
    git(client, 'config', 'http.corsProxy', 'https://rejected.example.invalid');

    const origins = new Set(['https://editor.example.invalid']);
    const sessions = new Map([
        ['fixture-read', {write: false, mode: 'desktop'}],
        ['fixture-write', {write: true, mode: 'desktop'}],
        ['fixture-expired', {expires: true}],
        ['fixture-cloudflare', {write: true, mode: 'cloudflare'}]
    ]);
    const requests = [];
    const upstream = [];
    const pushIds = new WeakMap();
    const fixture = {root, bare, seed, client, origins, sessions, requests, upstream, redirect: false, dropPush: false};
    const reply = (res, status, code) => {
        res.writeHead(status, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({code, requestId: randomUUID()}));
    };

    async function handle(req, res) {
        const {url, method, headers} = req;
        requests.push({url, method, headers});
        if (headers.host !== new URL(fixture.origin).host || req.socket.remoteAddress !== '127.0.0.1' ||
            !origins.has(headers.origin)) return reply(res, 403, 'FORBIDDEN');

        res.setHeader('Access-Control-Allow-Origin', headers.origin);
        res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
        res.setHeader('Cache-Control', 'no-store');
        const effectiveMethod = method === 'OPTIONS' ? headers['access-control-request-method'] : method;
        const path = url.startsWith(routePrefix + '/') ? url.slice(routePrefix.length) : '';
        const service = ['git-upload-pack', 'git-receive-pack'].find(service =>
            (effectiveMethod === 'GET' && path === '/info/refs?service=' + service) ||
            (effectiveMethod === 'POST' && path === '/' + service));
        if (!service) return reply(res, 400, 'BAD_REQUEST');
        const push = effectiveMethod === 'POST' && service === 'git-receive-pack';
        const requestType = 'application/x-' + service + '-request';
        if (method === 'OPTIONS') {
            const allowed = effectiveMethod === 'GET' ? ['authorization'] : ['authorization', 'content-type'];
            if (push) allowed.push('git-push-id');
            const asked = (headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(name => name.trim());
            if (asked.some(name => !allowed.includes(name))) return reply(res, 403, 'FORBIDDEN');
            res.writeHead(204, {'Access-Control-Allow-Methods': effectiveMethod, 'Access-Control-Allow-Headers': allowed.join(', ')});
            return res.end();
        }
        const session = headers.authorization?.startsWith('Bearer ') && sessions.get(headers.authorization.slice(7));
        if (!session) return reply(res, 401, 'SESSION_REQUIRED');
        if (session.expires) return reply(res, 401, 'SESSION_EXPIRED');
        if (session.mode !== 'desktop' || (service === 'git-receive-pack' && !session.write)) return reply(res, 403, 'FORBIDDEN');
        if (fixture.redirect) {
            if (fixture.redirect === 'upstream') return reply(res, 409, 'REDIRECT_REJECTED');
            res.writeHead(307, {Location: fixture.origin + '/redirect-target'});
            return res.end();
        }

        let input;
        if (method === 'POST') {
            if (headers['content-type'] !== requestType) return reply(res, 400, 'BAD_REQUEST');
            if (!/^\d+$/u.test(headers['content-length'] ?? '')) return reply(res, 411, 'LENGTH_REQUIRED');
            const expected = Number(headers['content-length']);
            if (expected > maxBody) return reply(res, 413, 'PAYLOAD_TOO_LARGE');
            let size = 0;
            const chunks = [];
            for await (const chunk of req) {
                size += chunk.length;
                if (size > expected) return reply(res, 400, 'BAD_REQUEST');
                chunks.push(chunk);
            }
            if (size !== expected) return reply(res, 400, 'BAD_REQUEST');
            input = Buffer.concat(chunks);
        }
        const pushId = headers['git-push-id'];
        if (push ? !pushIdPattern.test(pushId ?? '') || req.headersDistinct['git-push-id']?.length !== 1 :
            pushId !== undefined) return reply(res, 400, 'BAD_REQUEST');
        if (push) {
            let claimed = pushIds.get(session);
            if (!claimed) {
                claimed = new Set();
                pushIds.set(session, claimed);
            }
            if (claimed.has(pushId)) return reply(res, 409, 'PUSH_DUPLICATE');
            claimed.add(pushId);
        }

        const [pathInfo, query = ''] = ('/fixture/work.git' + path).split('?');
        // Model the credential boundary and invoke Git's CGI backend locally.
        const authorization = 'Basic ' + Buffer.from('x-access-token:fixture-upstream-token').toString('base64');
        upstream.push({method, path: pathInfo, query, authorization});
        const output = execFileSync(backend, [], {
            input,
            env: {...gitEnv, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: method,
                PATH_INFO: pathInfo, QUERY_STRING: query, REMOTE_USER: 'fixture-user',
                CONTENT_TYPE: headers['content-type'] ?? '', CONTENT_LENGTH: headers['content-length'] ?? '0'}
        });
        const dropPush = fixture.dropPush && method === 'POST' && service === 'git-receive-pack';
        if (dropPush && fixture.dropPush !== 'after-headers') {
            res.destroy();
            return;
        }
        const end = output.indexOf('\r\n\r\n');
        if (end < 0) throw new Error('Git CGI response had no header boundary');
        const lines = output.subarray(0, end).toString().split('\r\n');
        const statusLine = lines.find(line => line.startsWith('Status: '));
        const contentType = lines.find(line => line.startsWith('Content-Type: '));
        if (contentType) res.setHeader('Content-Type', contentType.slice(14));
        if (dropPush) {
            res.setHeader('Content-Length', output.length - end - 3);
            res.setHeader('Connection', 'close');
        }
        res.writeHead(statusLine ? Number(statusLine.slice(8, 11)) : 200);
        res.end(output.subarray(end + 4));
    }

    const server = createServer((req, res) => {
        handle(req, res).catch(() => {
            if (!res.headersSent) reply(res, 502, 'UPSTREAM_FAILURE');
            else res.destroy();
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => {server.close(resolve); server.closeAllConnections();}));
    fixture.origin = 'http://127.0.0.1:' + server.address().port;
    return fixture;
}

export const proxyPath = path => routePrefix + path;

export function adapterOptions(fixture, bearer = 'fixture-write') {
    const connection = {mode: 'desktop', proxyOrigin: fixture.origin};
    return {
        remote, connection,
        getSession: async () => ({connection, bearer, expiresAt: Date.now() + 60_000}),
        fetch: (url, init) => fetch(url, {...init, headers: {...Object.fromEntries(init.headers), Origin: 'https://editor.example.invalid'}})
    };
}

/**
 * Publishes a pull request the way GitHub exposes it on the base repository: `refs/pull/<number>/head` points at the
 * head commit. With `fork`, the head is committed in a separate clone and pushed only to that ref, so no branch of the
 * base repository contains it.
 */
export async function publishPullRequest(fixture, number, {fork = false, branch = 'feature', from, edit}) {
    const dir = from ?? join(fixture.root, fork ? `fork-${number}` : `branch-${number}`);
    if (!from) {
        git(fixture.root, 'clone', '-q', fixture.bare, dir);
        if (!fork) git(dir, 'switch', '-q', '-c', branch);
    }
    await edit(dir);
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=Contributor', '-c', 'user.email=contributor@example.invalid', 'commit', '-qm', `pull request ${number}`);
    const head = git(dir, 'rev-parse', 'HEAD');
    if (!fork) git(dir, 'push', '-q', '--force', fixture.bare, branch);
    git(dir, 'push', '-q', fixture.bare, `+HEAD:refs/pull/${number}/head`);
    return {dir, head};
}
