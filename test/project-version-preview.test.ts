import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {openProjectVersionPreview, projectVersionPreviewMessages, PROJECT_VERSION_PREVIEW_PROJECT,
    PROJECT_VERSION_PREVIEW_READY} from '../dist/project-version-preview.js';

function fixture() {
    const dom = new JSDOM('<body></body>', {url: 'https://editor.test/app/index.html'});
    const window = dom.window;
    window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    window.HTMLDialogElement.prototype.close = function () {
        this.removeAttribute('open');
        this.dispatchEvent(new window.Event('close'));
    };
    return {window, document: window.document, close: () => window.close()};
}

test('the dialog names the version and opens the player page with the locale and the host flags', t => {
    const {document, close} = fixture();
    t.after(close);
    const dialog = openProjectVersionPreview(document, '0123456789abcdef0123', new ArrayBuffer(4), 'ja',
        {page: 'git-project-preview.html', params: {twPlusLocalGit: '0'}});
    assert.equal(dialog.getAttribute('aria-label'), '作品の過去版 · 0123456789ab');
    const frame = dialog.querySelector('iframe')!;
    const url = new URL(frame.src);
    assert.equal(url.pathname, '/app/git-project-preview.html');
    assert.equal(url.searchParams.get('lang'), 'ja');
    assert.equal(url.searchParams.get('twPlusLocalGit'), '0');
    assert.equal(frame.title, dialog.getAttribute('aria-label'));
    const button = dialog.querySelector('button')!;
    assert.equal(button.textContent, '閉じる');
    button.click();
    assert.equal(document.querySelector('dialog'), null);
});

test('the archive goes only to the player frame, once, after it is ready', t => {
    const {window, document, close} = fixture();
    t.after(close);
    const archive = new ArrayBuffer(8);
    const dialog = openProjectVersionPreview(document, 'a'.repeat(40), archive, 'en', {page: 'preview.html'});
    const frame = dialog.querySelector('iframe')!;
    const sent: unknown[] = [];
    const target = {postMessage: (message: unknown, origin: string) => sent.push([message, origin])};
    Object.defineProperty(frame, 'contentWindow', {value: target});
    const post = (source: unknown, origin: string, data: unknown) =>
        window.dispatchEvent(new window.MessageEvent('message', {source: source as Window, origin, data}));
    post({}, 'https://editor.test', PROJECT_VERSION_PREVIEW_READY);
    post(target, 'https://other.test', PROJECT_VERSION_PREVIEW_READY);
    assert.deepEqual(sent, []);
    post(target, 'https://editor.test', PROJECT_VERSION_PREVIEW_READY);
    post(target, 'https://editor.test', PROJECT_VERSION_PREVIEW_READY);
    assert.deepEqual(sent, [[{kind: PROJECT_VERSION_PREVIEW_PROJECT, archive}, 'https://editor.test']]);
});

test('reports a structural conflict before opening a playtest', t => {
    const {document, close} = fixture();
    t.after(close);
    const dialog = openProjectVersionPreview(document, 'a'.repeat(40), new ArrayBuffer(0), 'ja', {
        page: 'preview.html', playtest: {conflicts: [], blocking: ['Walker · costumes']}
    });
    assert.match(dialog.querySelector('[role="alert"]')!.textContent!, /試遊の前に.*構造上の競合/);
    assert.equal(dialog.querySelector('li')!.textContent, 'Walker · costumes');
    assert.equal(dialog.querySelector('iframe'), null);
});

test('the words follow the locale', () => {
    assert.equal(projectVersionPreviewMessages('ja-JP').loadFailed, 'この版の作品を読み込めませんでした。');
    assert.equal(projectVersionPreviewMessages(null).loadFailed, 'This version could not be loaded.');
    assert.equal(projectVersionPreviewMessages('en').title, 'Project version');
});
