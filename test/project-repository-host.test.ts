import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bindProjectRepositoryCreation} from '../dist/project-repository-host.js';
import type {ProjectRepositoryHostServices} from '../dist/project-repository-host.js';

const draft = {account: 'octocat', owner: 'octocat', name: 'example', visibility: 'private' as const, title: 'Example',
    topics: [], description: 'About', license: null as string | null};
const connection = {mode: 'desktop'} as never;

/** A window with just what binding checks for; IndexedDB is opened only when the workflow runs. */
const view = (extra: Record<string, unknown> = {}) => ({
    indexedDB: {} as IDBFactory,
    navigator: {locks: {request: (_name: string, run: () => unknown) => run()}},
    crypto: {subtle: {}},
    showDirectoryPicker: async () => emptyFolder(),
    setTimeout, clearTimeout,
    ...extra
}) as never;

const emptyFolder = (entries: string[] = []) => ({
    async *values() {for (const name of entries) yield {name};}
}) as unknown as FileSystemDirectoryHandle;

function services(overrides: Partial<ProjectRepositoryHostServices> = {}) {
    const calls: {seed?: unknown[]; clients: unknown[]} = {clients: []};
    const value: ProjectRepositoryHostServices = {
        createRepositoryClient(options) {
            calls.clients.push(options);
            return {connectForCreation: async () => null, createRepository: async () => { throw new Error('unused'); },
                setRepositoryTopics: async () => {}} as never;
        },
        composeRepositorySeed(...args) {
            calls.seed = args;
            throw Object.assign(new Error('stop'), {name: 'SeedStop'});
        },
        prepareInitialRepository: async () => ({oid: 'a'.repeat(40)}),
        pushInitialRepository: async () => ({oid: 'a'.repeat(40)}),
        sb3ToolchainVersion: '0.28.1',
        licenses: [{id: 'MIT', text: 'MIT text'}],
        ...overrides
    };
    return {value, calls};
}

const desktop = {
    getConnection: async () => connection,
    begin: async () => ({verificationUri: 'https://github.com/login/device', userCode: 'ABCD-1234', expiresAt: Date.now() + 60_000}),
    finish: async () => null,
    getGrant: async () => null,
    authorizeInitialPush: async () => null,
    inspectUnknown: async () => null,
    adoptUnknown: async () => null,
    disconnect: async () => {}
};

const bind = (svc: ProjectRepositoryHostServices, extra: Record<string, unknown> = {}) => bindProjectRepositoryCreation({
    view: view(), desktop, locale: 'ja', services: svc,
    author: async () => undefined,
    prepareSource: async () => new Map([['project.json', new Uint8Array([1])]]),
    openProject: async () => true,
    ...extra
} as never);

test('creation is unavailable unless the host supplies every service it needs', () => {
    assert.ok(bind(services().value));
    for (const missing of ['createRepositoryClient', 'composeRepositorySeed', 'prepareInitialRepository', 'pushInitialRepository'] as const) {
        assert.equal(bind({...services().value, [missing]: undefined} as never), undefined, missing);
    }
    assert.equal(bind(services({sb3ToolchainVersion: null}).value), undefined);
    // The browser path needs the Cloudflare authorizations as well.
    const cloudflare = {bffOrigin: 'https://bff.example', proxyOrigin: 'https://proxy.example'};
    assert.equal(bind(services().value, {desktop: undefined, cloudflare}), undefined);
    assert.ok(bind(services({createCloudflareRepositoryAuth: () => ({connection, authorize: async () => null, disconnect: async () => {}}),
        createCloudflareGitAuth: () => ({}) as never}).value, {desktop: undefined, cloudflare}));
    assert.equal(bind(services().value, {view: view({indexedDB: undefined})}), undefined);
});

test('the selectable licenses come from the host', () => {
    assert.deepEqual(bind(services().value)!.licenses, [{id: 'MIT', label: 'MIT'}]);
    assert.deepEqual(bind(services({licenses: undefined}).value)!.licenses, []);
});

test('the seed records the project, its metadata, the chosen license and the toolchain version', async () => {
    const {value, calls} = services();
    const host = bind(value)!;
    const signal = new AbortController().signal;
    await assert.rejects(host.start({...draft, license: 'MIT'}, async () => new Uint8Array(), () => true, signal, emptyFolder()),
        {name: 'SeedStop'});
    const [project, metadata, version] = calls.seed!;
    assert.ok((project as Map<string, Uint8Array>).has('project.json'));
    assert.deepEqual(metadata, {title: 'Example', description: 'About', language: 'ja', license: {name: 'MIT', text: 'MIT text'}});
    assert.equal(version, '0.28.1');
    await assert.rejects(bind(value, {locale: 'en'})!.start(draft, async () => new Uint8Array(), () => true, signal, emptyFolder()),
        {name: 'SeedStop'});
    assert.equal((calls.seed![1] as {language: string}).language, 'en');
});

test('a folder that is not empty or an unknown license stops before anything is created', async () => {
    const {value, calls} = services();
    const host = bind(value)!;
    const signal = new AbortController().signal;
    await assert.rejects(host.start(draft, async () => new Uint8Array(), () => true, signal, emptyFolder(['project.json'])),
        {code: 'directoryNotEmpty'});
    await assert.rejects(host.start({...draft, license: 'GPL'}, async () => new Uint8Array(), () => true, signal, emptyFolder()),
        {code: 'invalidRequest'});
    assert.equal(calls.seed, undefined);
    // A project that is no longer current, or a cancelled picker, ends quietly.
    assert.equal(await host.start(draft, async () => new Uint8Array(), () => false, signal, emptyFolder()), null);
    assert.equal(await bind(value, {view: view({showDirectoryPicker: async () => {
        throw Object.assign(new Error('cancel'), {name: 'AbortError'});
    }})})!.start(draft, async () => new Uint8Array(), () => true, signal), null);
});

test('Desktop connects through one client and refuses a device code that is not GitHub\'s', async () => {
    let client!: {authorize(signal?: AbortSignal): Promise<unknown>};
    const {value, calls} = services({createRepositoryClient(options) {
        client = options;
        return {connectForCreation: async () => null, createRepository: async () => { throw new Error('unused'); },
            setRepositoryTopics: async () => {}} as never;
    }});
    const shown: unknown[] = [];
    const bad = {...desktop, begin: async () => ({verificationUri: 'https://evil.example/device', userCode: 'ABCD-1234',
        expiresAt: Date.now() + 60_000})};
    const host = bind(value, {desktop: bad})!;
    const controls = {signal: new AbortController().signal, deviceCode: (code: unknown) => shown.push(code)};
    assert.equal(await host.connect(controls as never), null);
    await host.connect(controls as never);
    assert.equal(calls.clients.length, 0);
    await assert.rejects(client.authorize(), {code: 'denied'});
    assert.deepEqual(shown, []);
    // An existing grant is used without starting a new device flow.
    const grant = {scope: 'repository-creation'};
    const reuse = bind(services({createRepositoryClient(options) {
        client = options;
        return {connectForCreation: async () => null} as never;
    }}).value, {desktop: {...desktop, getGrant: async () => grant, begin: async () => { throw new Error('no device flow'); }}})!;
    await reuse.connect(controls as never);
    assert.equal(await client.authorize(), grant);
});
