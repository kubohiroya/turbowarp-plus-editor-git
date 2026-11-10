import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {openRepository} from '../dist/repository.js';
import {directoryHandle} from './directory.js';

// A history with branches, a merge, origin refs, a tag-only commit, and committer times that can be set per commit.
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twgit-history-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    let clock = 1_700_000_000;
    const git = (args, time) => execFileSync('git', args, {cwd: root, encoding: 'utf8', env: {...process.env,
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid', ...(time ? {GIT_AUTHOR_DATE: `@${time} +0000`, GIT_COMMITTER_DATE: `@${time} +0000`} : {})}}).trimEnd();
    const commit = async (message, time = clock += 60) => {
        await fs.writeFile(path.join(root, 'notes.txt'), message + '\n');
        git(['add', '.']);
        git(['commit', '-qm', message + '\n\nBody line'], time);
        return git(['rev-parse', 'HEAD']);
    };
    git(['init', '-q', '-b', 'main']);
    const c = {};
    c.a = await commit('a');
    c.b = await commit('b');
    git(['switch', '-q', '-c', 'feature']);
    c.f1 = await commit('f1');
    c.f2 = await commit('f2');
    git(['switch', '-q', 'main']);
    c.c = await commit('c');
    git(['merge', '-q', '--no-ff', '-X', 'theirs', '-m', 'merge feature', 'feature'], clock += 60);
    c.m = git(['rev-parse', 'HEAD']);
    // topic starts from a; its second commit's committer time runs a little backwards.
    git(['switch', '-q', '-c', 'topic', c.a]);
    c.t1 = await commit('t1');
    c.t2 = await commit('t2', clock - 600);
    // Only origin/extra reaches x; only a tag reaches the tagged commit; nothing reaches the dangling one.
    git(['switch', '-q', '-c', 'temporary', c.b]);
    c.x = await commit('x');
    git(['update-ref', 'refs/remotes/origin/extra', c.x]);
    c.tagged = await commit('tagged');
    git(['tag', 'only-a-tag', c.tagged]);
    git(['switch', '-q', 'main']);
    git(['branch', '-q', '-D', 'temporary']);
    git(['update-ref', 'refs/remotes/origin/main', c.c]);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    return {root, git, c, repository: await openRepository(directoryHandle(root))};
}
const readAll = async (repository, limit) => {
    const pages = [];
    let cursor;
    do {
        const page = await repository.history({limit, after: cursor});
        pages.push(page.commits);
        cursor = page.cursor;
    } while (cursor);
    return pages;
};
const assertTopological = commits => {
    const row = new Map(commits.map((commit, index) => [commit.oid, index]));
    for (const commit of commits) for (const parent of commit.parents) {
        if (row.has(parent)) assert.ok(row.get(parent) > row.get(commit.oid), `${commit.message} is above its parent`);
    }
};

test('history lists every commit reachable from the branches, origin and HEAD once, children above parents', async t => {
    const {git, c, repository} = await fixture(t);
    const [commits] = await readAll(repository, 100);
    const expected = git(['rev-list', '--branches', '--remotes=origin', 'HEAD']).split('\n').sort();
    assert.deepEqual(commits.map(commit => commit.oid).sort(), expected);
    assert.equal(new Set(commits.map(commit => commit.oid)).size, commits.length);
    // `--all` also reaches the tag-only commit, which the history leaves out on purpose.
    assert.deepEqual(git(['log', '--all', '--format=%H']).split('\n').filter(oid => !expected.includes(oid)), [c.tagged]);
    assertTopological(commits);
    // Newest committer time first, except that t2, whose time runs backwards, still comes above its parent t1.
    assert.deepEqual(commits.map(commit => commit.message), ['x', 'merge feature', 'c', 'f2', 'f1', 'b', 't2', 't1', 'a']);
    const byOid = new Map(commits.map(commit => [commit.oid, commit]));
    assert.deepEqual(byOid.get(c.m).parents, [c.c, c.f2]);
    assert.equal(byOid.get(c.m).message, 'merge feature');
    assert.equal(byOid.get(c.a).message, 'a', 'only the first line of the message');
    assert.equal(byOid.get(c.a).author, 'Fixture');
    assert.deepEqual(byOid.get(c.a).parents, []);
    assert.equal(byOid.get(c.b).timestamp, Number(git(['log', '-1', '--format=%at', c.b])));
    const refs = oid => byOid.get(oid).refs.map(ref => `${ref.kind}:${ref.name}${ref.current ? '*' : ''}`);
    assert.deepEqual(refs(c.m), ['branch:main*']);
    assert.deepEqual(refs(c.f2), ['branch:feature']);
    assert.deepEqual(refs(c.t2), ['branch:topic']);
    assert.deepEqual(refs(c.c), ['remote:origin/main']);
    assert.deepEqual(refs(c.x), ['remote:origin/extra']);
    assert.deepEqual(refs(c.b), []);
});

test('history pages return the rest without duplicates and keep children above parents across pages', async t => {
    const {git, repository} = await fixture(t);
    const pages = await readAll(repository, 2);
    const all = pages.flat();
    assert.ok(pages.length >= 5);
    assert.ok(pages.slice(0, -1).every(page => page.length === 2));
    assert.equal(new Set(all.map(commit => commit.oid)).size, all.length);
    assert.deepEqual(all.map(commit => commit.oid).sort(), git(['rev-list', '--branches', '--remotes=origin', 'HEAD']).split('\n').sort());
    assertTopological(all);
    // A cursor continues once.
    const first = await repository.history({limit: 2});
    await repository.history({after: first.cursor});
    await assert.rejects(repository.history({after: first.cursor}), {code: 'changed'});
});

test('a detached HEAD is listed and marked, and an unborn repository has no history', async t => {
    const {git, c, repository} = await fixture(t);
    git(['switch', '-q', '--detach', c.f1]);
    git(['branch', '-q', '-D', 'feature']);
    const [commits] = await readAll(repository, 100);
    const head = commits.find(commit => commit.oid === c.f1);
    assert.deepEqual(head.refs, [{kind: 'head', name: 'HEAD', current: true}]);
    assert.ok(commits.some(commit => commit.oid === c.f2), 'f2 is still reachable through the merge');
    assert.deepEqual(commits.map(commit => commit.oid).sort(), git(['rev-list', '--branches', '--remotes=origin', 'HEAD']).split('\n').sort());
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twgit-history-empty-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    execFileSync('git', ['init', '-q', '-b', 'main'], {cwd: root});
    assert.deepEqual(await (await openRepository(directoryHandle(root))).history(), {commits: [], cursor: null});
});
