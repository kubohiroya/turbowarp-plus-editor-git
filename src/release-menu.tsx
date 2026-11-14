import React, {useEffect, useRef, useState} from 'react';
import {CloseButton} from './close-button.js';
import {PanelIcon} from './panel-navigation.js';
import type {Repository} from './repository.js';
import {inspectPublicationRepository, pushReleaseTag, validReleaseTag} from './publish-ref.js';
import type {PublicationRepository} from './publish-ref.js';
import {MAX_PAGES_HTML_BYTES, publishPagesHtml} from './publish-pages.js';
import type {PagesFolder} from './publish-pages.js';
import type {GitConnectionSettings} from './connection-settings.js';
import {GitPanelError} from './filesystem.js';
import {gitHubRepositoryFromOrigin} from './github-pull-requests.js';

const ja = {
    title: 'リリース', close: '閉じる', npm: 'npm パッケージを公開', tag: 'GitHub にリビジョンタグを作成',
    pages: 'GitHub Pages に HTML を公開', release: 'GitHub Releases を開く', settings: 'Pages の公開設定を開く', files: 'GitHub でファイルを追加',
    export: 'Packager で HTML を書き出す', tagName: 'タグ名', target: '対象コミット',
    npmHelp: '公開するパッケージのディレクトリで、認証済みの端末から順に実行します。dry run で公開対象のファイルを確認できます。',
    copyDryRun: '確認コマンドをコピー', copyPublish: '公開コマンドをコピー', copied: 'コピーしました。',
    copyFailed: 'コピーできませんでした。コマンドを選択してコピーしてください。',
    tagHelp: '選択中のリポジトリの現在のコミットにタグを付けます。',
    tagInvalid: 'タグ名には英数字、ピリオド、ハイフン、アンダースコアを使えます。例 v1.0.0',
    pagesHelp: 'Packager で単一の HTML に書き出します。Pages の設定で公開元を確認し、そのブランチとフォルダに index.html として送ります。',
    loadBranches: '公開先のブランチを取得', chooseBranch: 'ブランチを選択', sourceBranch: '公開先のブランチ',
    sourceFolder: '公開先のフォルダ', htmlFile: '書き出した HTML', chooseHtml: 'HTML ファイルを選択…', sendHtml: 'HTML を GitHub に送る',
    confirmHtml: 'この HTML で公開先の index.html を更新しますか？',
    branchesFailed: 'ブランチを取得できませんでした。GitHub 接続設定を確認してください。',
    htmlInvalid: '31 MB 以下の HTML ファイルを選んでください。',
    htmlDone: 'HTML を送信しました。公開状況は GitHub の Pages 設定で確認できます。',
    htmlChanged: '公開先が更新されました。ブランチを取り直してから送信してください。',
    htmlAuthor: 'コミットに使う user.name と user.email を、このリポジトリの Git 設定に登録してください。',
    htmlUnsupported: '公開先のパスにファイルを書き込めません。既存の index.html と公開先フォルダを確認してください。',
    htmlFailed: 'HTML の送信を確認できませんでした。GitHub で公開先のブランチを確認してください。',
    noRemote: 'GitHub のリモートがあるリポジトリを選んでください。',
    noHead: 'タグの対象にできるコミットがありません。',
    loading: '対象コミットを取得中…', pushTag: 'タグを GitHub に送る',
    confirmTag: 'このコミットにタグを付けて GitHub に送りますか？',
    tagDone: 'GitHub にタグを作成しました。', tagConflict: 'このタグ名は別のコミットに使われています。',
    tagFailed: 'タグの送信を確認できませんでした。GitHub でタグを確認してください。',
    writeNeeded: 'Editor から送るには、GitHub 接続設定で push を許可してください。'
};
const en: typeof ja = {
    title: 'Release', close: 'Close', npm: 'Publish an npm package', tag: 'Create a GitHub revision tag',
    pages: 'Publish HTML to GitHub Pages', release: 'Open GitHub Releases', settings: 'Open Pages publishing settings', files: 'Add files on GitHub',
    export: 'Export HTML with Packager', tagName: 'Tag name', target: 'Target commit',
    npmHelp: 'Run these commands in the package directory from an authenticated terminal. The dry run lists the files to publish.',
    copyDryRun: 'Copy dry-run command', copyPublish: 'Copy publish command', copied: 'Copied.',
    copyFailed: 'Could not copy. Select the command and copy it manually.',
    tagHelp: 'Tag the selected repository’s current commit.',
    tagInvalid: 'Use letters, digits, periods, hyphens or underscores in the tag name. Example v1.0.0',
    pagesHelp: 'Export a single HTML file with Packager. Check the publishing source in Pages settings, then send the file as index.html to that branch and folder.',
    loadBranches: 'Load publishing branches', chooseBranch: 'Choose a branch', sourceBranch: 'Publishing branch',
    sourceFolder: 'Publishing folder', htmlFile: 'Exported HTML', chooseHtml: 'Choose HTML file…', sendHtml: 'Send HTML to GitHub',
    confirmHtml: 'Update index.html at the publishing destination with this HTML file?',
    branchesFailed: 'Could not load branches. Check your GitHub connection settings.',
    htmlInvalid: 'Choose an HTML file of up to 31 MB.',
    htmlDone: 'HTML sent. Check Pages settings on GitHub for the deployment status.',
    htmlChanged: 'The destination changed. Reload the branches before sending.',
    htmlAuthor: 'Set user.name and user.email in this repository’s Git configuration for the commit.',
    htmlUnsupported: 'Could not write to the destination path. Check the existing index.html and publishing folder.',
    htmlFailed: 'Could not confirm the HTML push. Check the publishing branch on GitHub.',
    noRemote: 'Choose a repository with a GitHub remote.', noHead: 'There is no commit to tag.',
    loading: 'Reading the target commit…', pushTag: 'Send tag to GitHub',
    confirmTag: 'Create a tag for this commit on GitHub?',
    tagDone: 'The tag is available on GitHub.', tagConflict: 'This tag already points to another commit.',
    tagFailed: 'The tag could not be confirmed. Check the tags on GitHub.',
    writeNeeded: 'Allow push in GitHub connection settings to send a tag from the Editor.'
};

export function ReleaseDialog({locale, repository, onClose, exportProject, github, connection}: {
    locale: string; repository: Repository | null; onClose(): void; exportProject?: () => void; github: string | null; connection?: GitConnectionSettings;
}) {
    const labels = locale.startsWith('ja') ? ja : en;
    const dialog = useRef<HTMLDialogElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const [tag, setTag] = useState('');
    const [busy, setBusy] = useState(false);
    const [copyStatus, setCopyStatus] = useState<'copied' | 'copyFailed'>();
    const [status, setStatus] = useState<'tagDone' | 'tagConflict' | 'tagFailed'>();
    const [pages, setPages] = useState<PublicationRepository>();
    const [branch, setBranch] = useState('');
    const [folder, setFolder] = useState<PagesFolder>('/');
    const [html, setHtml] = useState<File>();
    const [pagesStatus, setPagesStatus] = useState<
        'branchesFailed' | 'htmlInvalid' | 'htmlDone' | 'htmlChanged' | 'htmlAuthor' | 'htmlUnsupported' | 'htmlFailed'>();
    const canPush = !!connection?.getSession && connection.getView().state.status === 'connected' && connection.getView().write === true;
    const [head, setHead] = useState<string | null | undefined>(repository ? undefined : null);
    useEffect(() => {
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, []);
    useEffect(() => {
        if (!repository) return;
        let current = true;
        void repository.readHead().then(value => {
            if (current) setHead(value.head);
        }, () => {if (current) setHead(null);});
        return () => {current = false;};
    }, [repository]);
    const validTag = validReleaseTag(tag);
    const copyCommand = async (command: string) => {
        try {
            await navigator.clipboard.writeText(command);
            setCopyStatus('copied');
        } catch {setCopyStatus('copyFailed');}
    };
    const base = pages?.branches.find(ref => ref.name === branch)?.oid;
    const loadBranches = async () => {
        if (!canPush || busy || !repository || !github || !connection?.getSession) return;
        setBusy(true);
        setPagesStatus(undefined);
        setPages(undefined);
        setBranch('');
        try {
            const result = await inspectPublicationRepository({root: repository.root, getSession: connection.getSession});
            if ('https://github.com/' + gitHubRepositoryFromOrigin(result.remote) !== github || !result.branches.length)
                throw new GitPanelError('changed');
            setPages(result);
        } catch {
            setPagesStatus('branchesFailed');
        } finally {setBusy(false);}
    };
    const sendHtml = async () => {
        if (!canPush || busy || !repository || !github || !connection?.getSession || !pages || !base || !html) return;
        const path = folder === '/' ? 'index.html' : 'docs/index.html';
        if (!dialog.current?.ownerDocument.defaultView?.confirm([labels.confirmHtml, github, branch + ':' + path, html.name].join('\n'))) return;
        setBusy(true);
        setPagesStatus(undefined);
        try {
            const tip = await publishPagesHtml({root: repository.root, remote: pages.remote, branch, base, folder,
                html: new Uint8Array(await html.arrayBuffer()), getSession: connection.getSession});
            setPages({...pages, branches: pages.branches.map(ref => ref.name === branch ? {...ref, oid: tip} : ref)});
            setPagesStatus('htmlDone');
        } catch (error) {
            const code = error instanceof GitPanelError ? error.code : undefined;
            if (code === 'changed') {
                setPages(undefined);
                setBranch('');
            }
            setPagesStatus(code === 'changed' ? 'htmlChanged' : code === 'author' ? 'htmlAuthor' :
                code === 'unsupported' ? 'htmlUnsupported' : 'htmlFailed');
        } finally {setBusy(false);}
    };
    const pushTag = async () => {
        if (!canPush || busy || !repository || !github || !head || !validTag || !connection?.getSession) return;
        if (!dialog.current?.ownerDocument.defaultView?.confirm([labels.confirmTag, github, tag, head].join('\n'))) return;
        setBusy(true);
        setStatus(undefined);
        try {
            const remote = await repository.readOrigin();
            if (!remote || 'https://github.com/' + gitHubRepositoryFromOrigin(remote) !== github) throw new GitPanelError('changed');
            await pushReleaseTag({root: repository.root, remote, oid: head, tag, getSession: connection.getSession});
            setStatus('tagDone');
        } catch (error) {
            setStatus(error instanceof GitPanelError && error.code === 'diverged' ? 'tagConflict' : 'tagFailed');
        } finally {setBusy(false);}
    };
    return <dialog className="twgit-panel twgit-connection-dialog twgit-release-dialog" ref={dialog} aria-label={labels.title} onCancel={event => {if (busy) event.preventDefault();}} onClose={onClose}>
        <header>
            <PanelIcon name="tag"/><h2>{labels.title}</h2>
            {!busy && <CloseButton label={labels.close} onClick={onClose}/>}
        </header>
        <div className="twgit-connection-body">
            <section>
                <h3>{labels.npm}</h3>
                <p>{labels.npmHelp}</p>
                <pre>npm publish --dry-run{'\n'}npm publish</pre>
                <div className="twgit-release-links">
                    <button type="button" onClick={() => void copyCommand('npm publish --dry-run')}>{labels.copyDryRun}</button>
                    <button type="button" onClick={() => void copyCommand('npm publish')}>{labels.copyPublish}</button>
                </div>
                {copyStatus && <p role="status">{labels[copyStatus]}</p>}
            </section>
            <section>
                <h3>{labels.tag}</h3>
                <p>{github ? labels.tagHelp : labels.noRemote}</p>
                {github && <>
                    {head === undefined ? <p role="status">{labels.loading}</p> : head ? <>
                        <p>{labels.target} <code>{head.slice(0, 12)}</code></p>
                        <label>{labels.tagName} <input value={tag} placeholder="v1.0.0" maxLength={100} disabled={busy}
                            onChange={event => {setTag(event.currentTarget.value); setStatus(undefined);}}/></label>
                        {tag && !validTag && <p role="status">{labels.tagInvalid}</p>}
                        {canPush ? <p><button type="button" className="twgit-primary" disabled={!validTag || busy || status === 'tagDone'}
                            onClick={() => void pushTag()}>{labels.pushTag}</button></p> : <p>{labels.writeNeeded}</p>}
                        {status && <p role="status">{labels[status]}</p>}
                        {!canPush && validTag && <pre>{'git push origin ' + head + ':refs/tags/' + tag}</pre>}
                    </> : <p>{labels.noHead}</p>}
                    <a href={github + '/releases'} target="_blank" rel="noreferrer">{labels.release}</a>
                </>}
            </section>
            <section>
                <h3>{labels.pages}</h3>
                <p>{labels.pagesHelp}</p>
                {exportProject && <button type="button" disabled={busy} onClick={() => {onClose(); exportProject();}}>{labels.export}</button>}
                {github && <div className="twgit-release-links">
                    <a href={github + '/settings/pages'} target="_blank" rel="noreferrer">{labels.settings}</a>
                    {!canPush && <a href={github} target="_blank" rel="noreferrer">{labels.files}</a>}
                </div>}
                {github && canPush && <div className="twgit-release-pages">
                    <button type="button" disabled={busy} onClick={() => void loadBranches()}>{labels.loadBranches}</button>
                    {pages && <>
                        <label>{labels.sourceBranch} <select value={branch} disabled={busy}
                            onChange={event => {setBranch(event.currentTarget.value); setPagesStatus(undefined);}}>
                            <option value="">{labels.chooseBranch}</option>
                            {pages.branches.map(ref => <option key={ref.name}>{ref.name}</option>)}
                        </select></label>
                        <label>{labels.sourceFolder} <select value={folder} disabled={busy}
                            onChange={event => {setFolder(event.currentTarget.value === '/docs' ? '/docs' : '/'); setPagesStatus(undefined);}}>
                            <option value="/">/</option><option value="/docs">/docs</option>
                        </select></label>
                        <div className="twgit-release-html">
                            <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>{labels.chooseHtml}</button>
                            <span>{html?.name}</span>
                            <input hidden ref={fileInput} type="file" aria-label={labels.htmlFile} accept=".html,.htm,text/html"
                                disabled={busy} onChange={event => {
                                    const file = event.currentTarget.files?.[0];
                                    const valid = file && /\.html?$/iu.test(file.name) && file.size > 0 && file.size <= MAX_PAGES_HTML_BYTES;
                                    setHtml(valid ? file : undefined);
                                    setPagesStatus(file && !valid ? 'htmlInvalid' : undefined);
                                }}/>
                        </div>
                        <button type="button" className="twgit-primary" disabled={!base || !html || busy || pagesStatus === 'htmlDone'}
                            onClick={() => void sendHtml()}>{labels.sendHtml}</button>
                    </>}
                    {pagesStatus && <p role="status">{labels[pagesStatus]}</p>}
                </div>}
            </section>
        </div>
    </dialog>;
}
