import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {JSDOM} from 'jsdom';
import {renderProjectPublicationDialog} from '../dist/project-publication-dialog.js';
import {createCloudflarePublicationBridge} from '../dist/cloudflare-publication.js';
import {bindDesktopPublicationPushSession, createProjectPublication, type DesktopPublicationBridge, type PublicationIntent,
    type PublicationJob, type PublicationPushSession} from '../dist/project-publication.js';

const remote = 'https://github.com/Octocat/Project';
const commit = {id: '67b0c99f-ab7f-4b48-b0d5-43fb009985d6', message: 'Save project', commitOid: 'a'.repeat(40)};
const baseOid = 'b'.repeat(40);
const head = 'tw-plus/pr-' + commit.id;
const inspect = async () => ({remote, defaultBranch: 'main', branches: [{name: 'main', oid: baseOid},
    {name: 'develop', oid: 'c'.repeat(40)}, {name: 'same', oid: commit.commitOid}]});
const capabilities = async () => ['pulls-read', 'pulls-write', 'issues-read', 'issues-write', 'checks-read', 'merge'];

test('publication approval queues the exact saved commit and drives the host independently of its view', async () => {
    let job: PublicationJob | null = null;
    let allow = false;
    let pushed = false;
    let calls = 0;
    const poll = Promise.withResolvers<void>();
    const bridge: DesktopPublicationBridge = {
        capabilities,
        async repository(url) {assert.equal(url, remote); return {repositoryId: 17};},
        async enqueue(intent) {
            assert.equal(intent.commitOid, commit.commitOid);
            assert.equal(intent.baseOid, baseOid);
            assert.equal(intent.head, head);
            return allow ? job = {intent, status: 'queued'} : null;
        },
        async get() {return job;},
        async advance() {
            calls++;
            assert.ok(job);
            switch (job.status) {
            case 'queued': return pushed ? job = {...job, status: 'pushed'} : {...job, awaitingPush: true};
            case 'pushed': return job = {...job, status: 'waiting', pullNumber: 5};
            case 'waiting': return job = {...job, status: 'done', mergeOid: 'd'.repeat(40)};
            default: assert.fail('The completed job should not be advanced');
            }
        }
    };
    const options = {bridge, inspect, guard() {}, async push(target) {
        assert.deepEqual(target, {remote, oid: commit.commitOid, ref: 'refs/heads/' + head});
        assert.equal(allow, true);
        pushed = true;
    }, async delay(ms: number) {assert.equal(ms, 30_000); await poll.promise;}};
    const port = createProjectPublication(options);
    const prepared = await port.prepare(commit);
    const draft = {base: 'main', title: 'One change', body: '', goal: 'merge'} as const;
    assert.equal(await prepared.submit(draft, () => false), false);
    assert.equal(await prepared.submit(draft, () => true), false);
    assert.equal(calls, 0);
    allow = true;
    assert.equal(await prepared.submit(draft, () => true), true);
    await setImmediate();
    const sameView = await port.prepare(commit);
    assert.equal(sameView.progress().running, true);
    assert.equal(sameView.progress().job?.pullNumber, 5);
    sameView.resume();
    assert.equal(calls, 3);
    poll.resolve();
    await setImmediate();
    const restored = await createProjectPublication(options).prepare(commit);
    assert.equal(restored.progress().job?.status, 'done');
    restored.resume();
    assert.equal(calls, 4);
});

test('dialog shows exact refs, keeps merge unchecked and restores progress with the selected issue', async t => {
    const dom = new JSDOM('<body></body>');
    t.after(() => dom.window.close());
    const {document} = dom.window;
    let intent: PublicationIntent;
    let saved: PublicationJob | null = null;
    const resumes: boolean[] = [];
    const bridge: DesktopPublicationBridge = {
        capabilities,
        async repository() {return {repositoryId: 17};},
        async enqueue(approved) {
            intent = approved;
            return saved = {intent, status: 'queued'};
        },
        async get() {return saved;},
        async advance({retryRejectedMerge}) {
            resumes.push(Boolean(retryRejectedMerge));
            assert.ok(saved);
            return saved = {...saved, status: 'waiting', pause: 'mergeRejected', pullNumber: 3, issueNumber: 19};
        }
    };
    const options = {bridge, inspect, guard() {}, async push() {assert.fail('No push was requested');}};
    const open = () => {
        const view = renderProjectPublicationDialog(document, 'en', createProjectPublication(options), commit, () => {}, () => {});
        document.body.append(view.element);
        return view;
    };
    const view = open();
    await setImmediate();
    const field = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(name: string) =>
        view.element.querySelector<T>(`[name="${name}"]`)!;
    assert.match(view.element.querySelector('dl')!.textContent!, new RegExp(baseOid));
    assert.match(view.element.querySelector('dl')!.textContent!, new RegExp(commit.commitOid));
    assert.equal(field<HTMLInputElement>('pr-merge').checked, false);
    field<HTMLInputElement>('pr-merge').checked = true;
    field<HTMLInputElement>('pr-title').value = 'Review this change';
    field<HTMLTextAreaElement>('pr-body').value = 'Details';
    const mode = field<HTMLSelectElement>('pr-issue-mode');
    mode.value = 'existing';
    mode.dispatchEvent(new dom.window.Event('change'));
    field<HTMLInputElement>('pr-issue-number').value = '19';
    field<HTMLInputElement>('pr-issue-close').checked = true;
    view.element.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await setImmediate();
    assert.deepEqual(intent!, {id: commit.id, remote, repositoryId: 17, base: 'main', baseOid, head, commitOid: commit.commitOid,
        goal: 'merge', title: 'Review this change', body: 'Details', issue: {number: 19, closeAfterMerge: true}});
    view.dispose();
    view.element.remove();
    const restored = open();
    await setImmediate();
    assert.equal(restored.element.querySelector('a')?.href, 'https://github.com/Octocat/Project/pull/3');
    const retry = [...restored.element.querySelectorAll('button')].find(button => button.textContent === 'Retry merge');
    assert.ok(retry && !retry.hidden);
    retry.click();
    await setImmediate();
    assert.deepEqual(resumes, [false, true]);
    restored.dispose();
});

test('stacking is opt-in, and the dialog queues the verified parent branch and commit', async t => {
    const dom = new JSDOM('<body></body>');
    t.after(() => dom.window.close());
    const {document} = dom.window;
    const parent = {number: 21, head: 'feature/parent', headOid: 'd'.repeat(40), targetBase: 'main'};
    let saved: PublicationJob | null = null;
    const poll = Promise.withResolvers<void>();
    const bridge: DesktopPublicationBridge = {
        async capabilities() {return [...await capabilities(), 'stacks'];},
        async repository() {return {repositoryId: 17};},
        async stackParent(url, number) {
            assert.equal(url, remote);
            assert.equal(number, parent.number);
            return parent;
        },
        async get() {return saved;},
        async enqueue(intent) {return saved = {intent, status: 'queued'};},
        async advance() {
            assert.ok(saved);
            return saved = saved.status === 'queued' ? {...saved, status: 'waitingForParent', pullNumber: 22, stackNumber: 2} :
                {...saved, status: 'done'};
        }
    };
    const port = createProjectPublication({bridge, async inspect() {
        const repo = await inspect();
        return {...repo, branches: [...repo.branches, {name: parent.head, oid: parent.headOid}]};
    }, guard() {}, async push() {assert.fail('No push was requested');}, async delay() {await poll.promise;}});
    const view = renderProjectPublicationDialog(document, 'en', port, commit, () => {}, () => {});
    t.after(() => {view.dispose(); poll.resolve();});
    document.body.append(view.element);
    await setImmediate();
    const toggle = view.element.querySelector<HTMLInputElement>('[name=pr-stack]')!;
    const number = view.element.querySelector<HTMLInputElement>('[name=pr-stack-parent]')!;
    const submit = view.element.querySelector<HTMLButtonElement>('button[type=submit]')!;
    assert.equal(toggle.checked, false);
    assert.ok(number.closest('div')?.hidden);
    toggle.click();
    assert.ok(submit.disabled);
    number.value = String(parent.number);
    number.dispatchEvent(new dom.window.Event('input'));
    const verify = [...view.element.querySelectorAll('button')].find(button => button.textContent === 'Verify parent pull request')!;
    verify.click();
    await setImmediate();
    assert.equal(submit.disabled, false);
    assert.match(view.element.querySelector('dl')!.textContent!, new RegExp(parent.headOid));
    submit.click();
    await setImmediate();
    assert.deepEqual(saved?.intent.stackParent, parent);
    assert.equal(saved?.intent.base, parent.head);
    assert.equal(saved?.intent.baseOid, parent.headOid);
    assert.match(view.element.textContent!, /Waiting for the parent pull request to merge/u);
    assert.equal([...view.element.querySelectorAll('a')].find(a => a.textContent === 'Parent PR #21')?.href,
        'https://github.com/Octocat/Project/pull/21');
});

test('Cloudflare grants a job only after BFF approval and never navigates to another origin', async () => {
    const bffOrigin = 'https://bff.example.invalid';
    const proxyOrigin = 'https://proxy.example.invalid';
    const target = {id: commit.id, remote, repositoryId: 17};
    const intent: PublicationIntent = {...target, base: 'main', baseOid, head, commitOid: commit.commitOid,
        title: 'Publish this', body: '', goal: 'pr'};
    const approvalUrl = bffOrigin + '/v1/github-publication/approval/' + 'a'.repeat(64) +
        '/' + target.id + '/' + 'k'.repeat(43);
    const bearer = 'a'.repeat(43) + '.' + 'b'.repeat(43);
    const job: PublicationJob = {intent, status: 'queued'};
    const calls: string[] = [];
    let popupOpen = false;
    let didApprove = false;
    let validOrigin = true;
    let statusPolls = 0;
    const bridge = createCloudflarePublicationBridge({
        view: {open(url) {
            assert.equal(url, 'about:blank');
            popupOpen = true;
            let detached = false;
            return {opener: {}, get closed() {return detached;}, location: {replace(url: string) {
                assert.equal(url, approvalUrl);
                detached = true;
            }},
                close() {popupOpen = false;}} as Window;
        }},
        bffOrigin, proxyOrigin,
        async getSession(url, write) {
            assert.equal(url, remote);
            assert.equal(write, true);
            return {connection: {mode: 'cloudflare', proxyOrigin}, account: {login: 'Octocat'}, bearer,
                expiresAt: Date.now() + 60_000};
        },
        async delay() {didApprove = true;},
        async send(input, init) {
            const url = new URL(String(input));
            assert.equal(url.origin, bffOrigin);
            assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + bearer);
            calls.push(url.pathname);
            if (url.pathname.endsWith('/jobs')) {
                assert.ok(popupOpen);
                assert.deepEqual(JSON.parse(String(init?.body)), {intent});
                return Response.json({approvalUrl: validOrigin ? approvalUrl : approvalUrl.replace(bffOrigin, proxyOrigin), job: null});
            }
            statusPolls++;
            return didApprove ? Response.json({approval: 'approved', job}) :
                Response.json({approval: 'pending', intent, job: null});
        }
    });
    assert.deepEqual(await bridge.get(target), {job: null, approvalIntent: intent});
    assert.deepEqual(await bridge.enqueue(intent), job);
    assert.equal(statusPolls, 3);
    assert.equal(popupOpen, false);
    validOrigin = false;
    await assert.rejects(bridge.enqueue(intent), {message: 'PUBLICATION_APPROVAL_URL'});
    assert.equal(popupOpen, false);
    assert.equal(calls.filter(route => route.endsWith('/advance')).length, 0);
});

test('reopening approval keeps the original base commit when the remote branch has moved', async () => {
    const intent: PublicationIntent = {id: commit.id, remote: remote.toLowerCase() + '.git', repositoryId: 17,
        base: 'main', baseOid, head, commitOid: commit.commitOid, title: 'Keep this approval', body: '', goal: 'pr'};
    const submissions: PublicationIntent[] = [];
    const port = createProjectPublication({
        bridge: {
            approval: 'browser',
            async repository() {return {repositoryId: 17, capabilities: await capabilities()};},
            async get() {return {job: null, approvalIntent: intent};},
            async enqueue(value) {submissions.push(value); return null;},
            async advance() {assert.fail('An unapproved job must not advance');}
        },
        async inspect() {return {remote, defaultBranch: 'main', branches: [{name: 'main', oid: 'e'.repeat(40)}]};},
        async push() {assert.fail('An unapproved branch must not be pushed');},
        guard() {}
    });
    const restored = await port.prepare(commit);
    assert.equal(restored.progress().approvalIntent, intent);
    assert.equal(await restored.approvePending?.(() => true), false);
    assert.deepEqual(submissions, [{...intent, remote}]);
});

test('Cloudflare refuses a push after the session used to advance was switched or revoked', async () => {
    const bffOrigin = 'https://bff.example.invalid';
    const proxyOrigin = 'https://proxy.example.invalid';
    const target = {id: commit.id, remote, repositoryId: 17};
    const intent: PublicationIntent = {...target, base: 'main', baseOid, head, commitOid: commit.commitOid,
        title: 'Publish this', body: '', goal: 'pr'};
    const first = {connection: {mode: 'cloudflare', proxyOrigin}, account: {login: 'Octocat'},
        bearer: 'a'.repeat(43) + '.' + 'b'.repeat(43), expiresAt: Date.now() + 60_000};
    let active: PublicationPushSession | null = first;
    const second = {...first, account: {login: 'Other'}, bearer: 'c'.repeat(43) + '.' + 'd'.repeat(43)};
    let changeDuringAdvance = true;
    const bridge = createCloudflarePublicationBridge({
        view: {open() {assert.fail('An approved job does not need a popup to advance');}}, bffOrigin, proxyOrigin,
        async getSession() {return active;},
        async send(input, init) {
            assert.equal(String(input), bffOrigin + '/v1/github-publication/jobs/advance');
            assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + first.bearer);
            if (changeDuringAdvance) active = second;
            return Response.json({intent, status: 'queued', awaitingPush: true});
        }
    });
    const switched = await bridge.advance(target);
    assert.equal(JSON.stringify(switched).includes(first.bearer), false);
    assert.throws(() => bridge.bindPushSession({...switched}), {message: 'SESSION_REQUIRED'});
    assert.equal(await bridge.bindPushSession(switched)(remote, true), null);

    changeDuringAdvance = false;
    active = first;
    const approved = bridge.bindPushSession(await bridge.advance(target));
    assert.equal(await approved(remote, true), first);
    active = {...first, bearer: second.bearer};
    assert.equal(await approved(remote, true), null);
    active = null;
    assert.equal(await approved(remote, true), null);
});

test('Desktop requires the exact authenticated account and write session that advanced the job', async () => {
    const first = {connection: {mode: 'desktop', proxyOrigin: 'http://127.0.0.1:1234'}, account: {login: 'Octocat'},
        bearer: 'a'.repeat(43), expiresAt: Date.now() + 60_000};
    const otherAccount = {...first, account: {login: 'Other'}};
    const newSession = {...first, bearer: 'b'.repeat(43)};
    const target = {id: commit.id, remote, repositoryId: 17};
    const intent: PublicationIntent = {...target, base: 'main', baseOid, head, commitOid: commit.commitOid,
        title: 'Publish this', body: '', goal: 'pr'};
    const job: PublicationJob = {intent, status: 'queued', awaitingPush: true, pushAccount: 'octocat',
        pushSessionId: createHash('sha256').update(first.bearer).digest('hex')};
    let active = otherAccount;
    const getSession = async () => active;
    await assert.rejects(bindDesktopPublicationPushSession(getSession, remote, job), {message: 'SESSION_REQUIRED'});
    active = newSession;
    await assert.rejects(bindDesktopPublicationPushSession(getSession, remote, job), {message: 'SESSION_REQUIRED'});
    active = first;
    const approved = await bindDesktopPublicationPushSession(getSession, remote, job);
    assert.equal(await approved(remote, true), first);
    active = newSession;
    assert.equal(await approved(remote, true), null);
});

test('a push session change stops publication before a second advance can use the new connection', async () => {
    let advances = 0;
    let job: PublicationJob;
    const bridge: DesktopPublicationBridge = {
        capabilities,
        async repository() {return {repositoryId: 17};},
        async enqueue(intent) {return job = {intent, status: 'queued'};},
        async get() {return null;},
        async advance() {advances++; return {...job, awaitingPush: true};}
    };
    const port = createProjectPublication({bridge, inspect, guard() {},
        async push() {throw new Error('SESSION_REQUIRED');}});
    const prepared = await port.prepare(commit);
    assert.ok(await prepared.submit({base: 'main', title: 'Record this', body: '', goal: 'pr'}, () => true));
    await setImmediate();
    assert.equal(advances, 1);
    assert.equal(prepared.progress().running, false);
    assert.match(String(prepared.progress().error), /SESSION_REQUIRED/u);
});
