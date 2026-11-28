import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import * as git from 'isomorphic-git';
import {isRepositoryName, readOriginUrl, renameRemoteRepository, writeOriginUrl} from '@kubohiroya/turbowarp-plus-editor-git/repository-rename';
import {directoryHandle} from './directory.js';

const proxyOrigin = 'http://127.0.0.1:4567';
const bearer = 'r'.repeat(43);
const remote = 'https://github.com/fixture/work.git';
const session = (patch = {}) => ({connection: {mode: 'desktop', proxyOrigin}, account: {login: 'owner'}, bearer,
    expiresAt: Date.now() + 60_000, ...patch});
const json = (status, value) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

function client(respond, current = session()) {
    const requests = [];
    const sessions = [];
    const rename = name => renameRemoteRepository({remote, name, getSession: async (...args) => {
        sessions.push(args);
        return current;
    }, fetch: async (url, init) => {
        requests.push({url, init});
        return respond(url, init);
    }});
    return {rename, requests, sessions};
}

test('accepts only names GitHub accepts for a repository', () => {
    for (const name of ['my-urashima', 'a', 'A_b.c-1', 'a'.repeat(100)]) assert.equal(isRepositoryName(name), true, name);
    for (const name of ['', '.', '..', 'x.git', 'X.GIT', 'a b', '浦島', 'a/b', 'a'.repeat(101)])
        assert.equal(isRepositoryName(name), false, name);
});

test('sends only the new name to the proxy with the write session and returns the new remote', async () => {
    const {rename, requests, sessions} = client(() => json(200, {owner: 'fixture', repo: 'renamed', repositoryId: 7}));
    assert.deepEqual(await rename('renamed'),
        {remote: 'https://github.com/fixture/renamed.git', owner: 'fixture', repo: 'renamed', repositoryId: 7});
    assert.deepEqual(sessions, [[remote, true]]);
    const [{url, init}] = requests;
    assert.equal(url, proxyOrigin + '/v1/github/fixture/work/name');
    assert.equal(init.body, JSON.stringify({name: 'renamed'}));
    assert.deepEqual(init.headers, {Authorization: 'Bearer ' + bearer, Accept: 'application/json',
        'Content-Type': 'application/json'});
    assert.deepEqual([init.method, init.credentials, init.redirect, init.cache, init.referrerPolicy],
        ['POST', 'omit', 'error', 'no-store', 'no-referrer']);
});

test('reads the proxy error codes and marks an uncertain outcome', async () => {
    for (const [status, code, unknown] of [
        [409, 'REPOSITORY_NAME_UNAVAILABLE', false],
        [403, 'ADMINISTRATION_PERMISSION_REQUIRED', false],
        [403, 'FORBIDDEN', false],
        [404, 'GITHUB_API_UNAVAILABLE', false],
        [504, 'UPSTREAM_TIMEOUT', true]
    ]) {
        const {rename} = client(() => json(status, {code, message: 'secret upstream text'}));
        await assert.rejects(rename('renamed'), error => {
            assert.equal(error.code, code);
            assert.equal(error.unknown, unknown);
            assert.doesNotMatch(error.message + JSON.stringify(error.options), /secret/u);
            return true;
        });
    }
    // An unnamed 404 means the proxy has no rename route.
    await assert.rejects(client(() => new Response(null, {status: 404})).rename('renamed'), {code: 'GITHUB_API_UNAVAILABLE'});
    await assert.rejects(client(() => {throw new TypeError('offline');}).rename('renamed'),
        error => error.code === 'NETWORK_ERROR' && error.unknown);
});

test('rejects an invalid name, a missing session and a response for another repository before trusting it', async () => {
    const {rename, requests} = client(() => json(200, {owner: 'fixture', repo: 'other', repositoryId: 7}));
    await assert.rejects(rename('浦島'), {code: 'INVALID_NAME'});
    assert.equal(requests.length, 0);
    await assert.rejects(rename('renamed'), {code: 'INVALID_RESPONSE'});
    await assert.rejects(client(() => json(200, {}), null).rename('renamed'), {code: 'SESSION_REQUIRED'});
    await assert.rejects(client(() => json(200, {}), session({expiresAt: 0})).rename('renamed'), {code: 'SESSION_EXPIRED'});
    await assert.rejects(client(() => json(200, {}), session({connection: {mode: 'cloudflare', proxyOrigin: 'http://x.test'}}))
        .rename('renamed'), {code: 'INVALID_CONNECTION'});
});

async function repository(origin) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repository-rename-'));
    await git.init({fs, dir, defaultBranch: 'main'});
    await git.setConfig({fs, dir, path: 'user.name', value: 'Fixture'});
    if (origin) await git.addRemote({fs, dir, remote: 'origin', url: origin});
    return dir;
}

test('rewrites only remote.origin.url in .git/config', async () => {
    const dir = await repository('https://github.com/fixture/work.git');
    const before = await fs.readFile(path.join(dir, '.git', 'config'), 'utf8');
    assert.equal(await readOriginUrl(directoryHandle(dir)), 'https://github.com/fixture/work.git');
    await writeOriginUrl(directoryHandle(dir), {from: remote, to: 'https://github.com/fixture/renamed.git'});
    assert.equal(await readOriginUrl(directoryHandle(dir)), 'https://github.com/fixture/renamed.git');
    const after = await fs.readFile(path.join(dir, '.git', 'config'), 'utf8');
    assert.equal(after, before.replace('https://github.com/fixture/work.git', 'https://github.com/fixture/renamed.git'));
    assert.equal(await git.getConfig({fs, dir, path: 'user.name'}), 'Fixture');
    assert.equal(await git.getConfig({fs, dir, path: 'remote.origin.fetch'}), '+refs/heads/*:refs/remotes/origin/*');
});

test('leaves a different origin alone', async () => {
    const dir = await repository('https://github.com/fixture/other.git');
    const before = await fs.readFile(path.join(dir, '.git', 'config'), 'utf8');
    await assert.rejects(writeOriginUrl(directoryHandle(dir), {from: remote, to: 'https://github.com/fixture/renamed.git'}),
        {code: 'ORIGIN_CHANGED'});
    assert.equal(await readOriginUrl(directoryHandle(await repository())), undefined);
    await assert.rejects(writeOriginUrl(directoryHandle(await repository()), {from: remote,
        to: 'https://github.com/fixture/renamed.git'}), {code: 'ORIGIN_CHANGED'});
    await assert.rejects(writeOriginUrl(directoryHandle(dir), {from: remote, to: 'https://example.test/x.git'}),
        {code: 'INVALID_REMOTE'});
    assert.equal(await fs.readFile(path.join(dir, '.git', 'config'), 'utf8'), before);
});
