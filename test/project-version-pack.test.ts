import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import {packProjectVersion, receiveProjectVersionPreview, PROJECT_VERSION_PREVIEW_PROJECT, PROJECT_VERSION_PREVIEW_READY}
    from '../dist/project-version-preview.js';

const text = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

/** Stands in for JSZip: records the entries and returns them as the "archive". */
class FakeZip {
    static last: FakeZip;
    entries = new Map<string, string | Uint8Array>();
    constructor() {FakeZip.last = this;}
    file(name: string, data: string | Uint8Array) {this.entries.set(name, data);}
    async generateAsync() {return new ArrayBuffer(this.entries.size);}
}

const source = () => new Map<string, Uint8Array>([
    ['sb3-source.json', text({project: 'src/project.json', embeddedExtensions: 'src/extensions.json',
        assetsDirectory: 'src/assets', archiveEntries: ['project.json', 'cat.svg']})],
    ['src/project.json', text({targets: [], extensionURLs: {kept: 'https://example.com/kept.js'}})],
    ['src/extensions.json', text({extensions: [
        {id: 'b64', path: 'src/b64.js', mediaType: 'text/javascript', parameters: ['charset=utf-8'], encoding: 'base64'},
        {id: 'pct', path: 'src/pct.js', mediaType: 'text/javascript', parameters: [], encoding: 'percent'}
    ]})],
    ['src/b64.js', text('ok()')],
    ['src/pct.js', text('a b')],
    ['src/assets/cat.svg', text('<svg/>')]
]);

test('a past version is validated first, then packed with its extensions embedded as data URLs', async () => {
    const files = source();
    const validated: unknown[] = [];
    const archive = await packProjectVersion(files, {validate: given => validated.push(given), zip: FakeZip});
    assert.deepEqual(validated, [files]);
    assert.equal(archive.byteLength, 2);
    const zip = FakeZip.last;
    assert.deepEqual([...zip.entries.keys()], ['project.json', 'cat.svg']);
    assert.equal(new TextDecoder().decode(zip.entries.get('cat.svg') as Uint8Array), '<svg/>');
    const project = JSON.parse(zip.entries.get('project.json') as string);
    assert.deepEqual(project.extensionURLs, {
        kept: 'https://example.com/kept.js',
        b64: `data:text/javascript;charset=utf-8;base64,${btoa('ok()')}`,
        pct: 'data:text/javascript,%61%20%62'
    });
});

test('a version that fails validation or lacks a file is not packed', async () => {
    await assert.rejects(packProjectVersion(source(), {validate: () => { throw new Error('not a project'); }, zip: FakeZip}),
        /not a project/);
    const missing = source();
    missing.delete('src/assets/cat.svg');
    await assert.rejects(packProjectVersion(missing, {validate() {}, zip: FakeZip}), /src\/assets\/cat\.svg/);
});

/** A player page inside a parent window, on one origin. */
function page(search = '?lang=ja') {
    const target = new EventTarget();
    const posted: unknown[] = [];
    const parent = {postMessage: (data: unknown, origin: string) => posted.push([data, origin])};
    const view = Object.assign(target, {parent, location: {origin: 'https://editor.example', search}}) as unknown as Window;
    const send = (data: unknown, {source = parent, origin = 'https://editor.example'} = {}) =>
        target.dispatchEvent(Object.assign(new Event('message'), {data, source, origin}));
    return {view, posted, send, parent};
}

test('the player announces itself and loads only the parent\'s archive, once', async () => {
    const {view, posted, send} = page();
    const steps: unknown[] = [];
    receiveProjectVersionPreview(view, {
        load: async archive => {steps.push(['load', archive.byteLength]);},
        loading: () => steps.push('loading'),
        loaded: success => steps.push(['loaded', success]),
        showError: message => steps.push(['error', message])
    });
    assert.deepEqual(posted, [[PROJECT_VERSION_PREVIEW_READY, 'https://editor.example']]);
    send({kind: PROJECT_VERSION_PREVIEW_PROJECT, archive: new ArrayBuffer(3)}, {source: {} as never});
    send({kind: PROJECT_VERSION_PREVIEW_PROJECT, archive: new ArrayBuffer(3)}, {origin: 'https://evil.example'});
    send({kind: 'other', archive: new ArrayBuffer(3)});
    send({kind: PROJECT_VERSION_PREVIEW_PROJECT, archive: 'not bytes'});
    await setImmediate();
    assert.deepEqual(steps, []);
    send({kind: PROJECT_VERSION_PREVIEW_PROJECT, archive: new ArrayBuffer(3)});
    send({kind: PROJECT_VERSION_PREVIEW_PROJECT, archive: new ArrayBuffer(4)});
    await setImmediate();
    assert.deepEqual(steps, ['loading', ['load', 3], ['loaded', true]]);
});

test('a version that cannot be loaded reports failure in the page\'s language', async () => {
    for (const [search, message] of [['?lang=ja', 'この版の作品を読み込めませんでした。'], ['?lang=en', 'This version could not be loaded.']]) {
        const {view, send} = page(search);
        const steps: unknown[] = [];
        receiveProjectVersionPreview(view, {
            load: async () => { throw new Error('broken'); },
            loaded: success => steps.push(['loaded', success]),
            showError: text => steps.push(['error', text])
        });
        send({kind: PROJECT_VERSION_PREVIEW_PROJECT, archive: new ArrayBuffer(1)});
        await setImmediate();
        assert.deepEqual(steps, [['loaded', false], ['error', message]]);
    }
});
