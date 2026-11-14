import React, {useEffect, useRef, useState} from 'react';
import type {GitAuthState, GitConnectionMode as Mode} from '@kubohiroya/turbowarp-plus-editor-auth';
import type {GetRemoteSession, RemoteOperation} from './remote-operations.js';
import {reviewLabelsFor} from './messages.js';
import {gitHubRepositoryFromOrigin} from './github-pull-requests.js';
import {PanelIcon} from './panel-navigation.js';
import {CloseButton} from './close-button.js';

type DesktopAuthOptions =
    | {method: 'github-app'}
    | {method: 'fine-grained-pat'; remember: boolean}
    | {method: 'git-credential-helper'; login: string};
type DesktopAuthMethod = DesktopAuthOptions['method'];

export interface GitConnectionSettings {
    modes: readonly Mode[];
    getView(): {
        mode: Mode | null;
        state: GitAuthState;
        proxyOrigin?: string;
        write?: boolean;
        /** Whether the connection was made with the grant to send pull request reviews. */
        review?: boolean;
        authorization?: {url: string; userCode?: string};
    };
    select(mode: Mode): Promise<void>;
    connect(remote: string, write?: boolean, review?: boolean, auth?: DesktopAuthOptions): Promise<void>;
    getDesktopAuthMethods?(remote?: string): Promise<readonly DesktopAuthMethod[]>;
    canRestoreDesktop?: boolean;
    restoreDesktop?(remote: string, write?: boolean, review?: boolean): Promise<void>;
    refresh(): Promise<void>;
    disconnect(): Promise<void>;
    getSession?: GetRemoteSession;
}

const en = {
    title: 'GitHub connection settings', repositoryTitle: 'Repository GitHub connection', mode: 'Default connection mode',
    repositoryMode: 'Connection mode', repository: 'Repository', nextConnection: 'Applies the next time you connect.',
    desktop: 'Desktop local', cloudflare: 'Cloudflare', proxy: 'Proxy', account: 'Account',
    'disconnected': 'Disconnected', 'connecting': 'Waiting for GitHub', 'connected': 'Connected',
    'reauth-required': 'Sign in again', connect: 'Connect to GitHub', open: 'Open GitHub authorization',
    check: 'Check connection', disconnect: 'Disconnect', noRemote: 'Choose a repository with a GitHub HTTPS origin.',
    unavailable: 'No GitHub connection is configured.',
    error: 'GitHub connection failed. Retry using the selected connection.',
    invalid: 'The selected repository needs a GitHub HTTPS origin.',
    authMethod: 'Authentication method', 'github-app': 'GitHub App (device code)',
    'fine-grained-pat': 'Fine-grained personal access token', 'git-credential-helper': 'Saved Git credentials',
    noDesktopMethod: 'No Desktop authentication method is available for this repository.',
    login: 'GitHub account name', remember: 'Save the token on this device',
    tokenHelp: 'Create a fine-grained token', nativeToken: 'Enter the token in the Desktop dialog.',
    restore: 'Restore saved Desktop connection', noSaved: 'There is no saved Desktop connection.',
    deviceCodeHelp: 'Only enter the code shown here. Never enter a code someone sent you.',
    revokeApp: 'Manage GitHub App authorizations',
    pullHint: 'Apply GitHub changes to the current local branch and working files.',
    allowPush: 'Allow sending to GitHub (push)', sync: 'Sync with GitHub', localBranch: 'Current local branch', detached: 'Detached HEAD', fetch: 'Update remote refs (fetch)', pull: 'Update local branch and files (pull)', push: 'Send current branch (push)'
};
const ja: typeof en = {
    title: 'GitHub 接続設定', repositoryTitle: 'リポジトリの GitHub 接続', mode: '既定の接続方式',
    repositoryMode: '接続方式', repository: 'リポジトリ', nextConnection: '次回の接続から適用します。',
    desktop: 'Desktop ローカル', cloudflare: 'Cloudflare', proxy: 'プロキシ', account: 'アカウント',
    'disconnected': '未接続', 'connecting': 'GitHub の認証待ち', 'connected': '接続済み',
    'reauth-required': '再認証が必要', connect: 'GitHub に接続', open: 'GitHub の認証を開く',
    check: '接続を確認', disconnect: '切断', noRemote: 'GitHub の HTTPS リモート origin があるリポジトリを選択してください。',
    unavailable: 'GitHub 接続先が設定されていません。',
    error: 'GitHub 接続に失敗しました。選択中の方式で再試行してください。',
    invalid: '選択したリポジトリには GitHub の HTTPS リモート origin が必要です。',
    authMethod: '認証方式', 'github-app': 'GitHub App（デバイスコード）',
    'fine-grained-pat': 'Fine-grained 個人アクセストークン', 'git-credential-helper': '手元の Git の認証情報',
    noDesktopMethod: 'このリポジトリで利用できる Desktop の認証方式がありません。',
    login: 'GitHub アカウント名', remember: 'この端末にトークンを保存する',
    tokenHelp: 'Fine-grained トークンを作成する', nativeToken: 'トークンは Desktop のダイアログに入力します。',
    restore: '保存済みの Desktop 接続を復元', noSaved: '保存済みの Desktop 接続がありません。',
    deviceCodeHelp: 'この画面に表示されたコードだけを入力してください。他人から届いたコードは入力しないでください。',
    revokeApp: 'GitHub App の承認を管理',
    pullHint: 'GitHub の変更を、現在のローカルブランチと作業ファイルに反映します。',
    allowPush: 'GitHub に送ることを許可する（push）', sync: 'GitHub と同期', localBranch: '現在のローカルブランチ', detached: 'ブランチ未選択', fetch: 'リモートの情報を更新（fetch）', pull: '手元のブランチとファイルを更新（pull）', push: '現在のブランチを送る（push）'
};

const preferenceKey = 'tw-plus-github-connection-mode';
const temporaryModes = new WeakMap<Window, Mode>();

function preferredMode(view: Window, modes: readonly Mode[]): Mode | undefined {
    let saved = temporaryModes.get(view);
    if (saved === undefined) {
        try {
            const value = view.localStorage.getItem(preferenceKey);
            if (value === 'desktop' || value === 'cloudflare') saved = value;
        } catch {
            // Storage can be unavailable on the host origin.
        }
    }
    return saved && modes.includes(saved) ? saved : modes[0];
}

function useModal() {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, []);
    return dialog;
}

export function GitConnectionPreferences({view, modes, locale, onClose}: {
    view: Window; modes: readonly Mode[]; locale: string; onClose(): void;
}) {
    const labels = locale.startsWith('ja') ? ja : en;
    const dialog = useModal();
    const [mode, setMode] = useState(() => preferredMode(view, modes));
    return <dialog className="twgit-panel twgit-connection-dialog" ref={dialog} aria-label={labels.title} onClose={onClose}>
        <header>
            <PanelIcon name="globe"/><h2>{labels.title}</h2>
            <CloseButton label={locale.startsWith('ja') ? '閉じる' : 'Close'} onClick={() => dialog.current?.close()}/>
        </header>
        <div className="twgit-connection-body">
            {mode ? <>
                <label>{labels.mode} <select value={mode} onChange={event => {
                    const choice = event.currentTarget.value as Mode;
                    setMode(choice);
                    try {
                        view.localStorage.setItem(preferenceKey, choice);
                        temporaryModes.delete(view);
                    } catch {
                        temporaryModes.set(view, choice);
                    }
                }}>
                    {modes.map(choice => <option key={choice} value={choice}>{labels[choice]}</option>)}
                </select></label>
                <p>{labels.nextConnection}</p>
            </> : <p>{labels.unavailable}</p>}
        </div>
    </dialog>;
}

export function ConnectionSettings({view, settings, locale, readOrigin, busy, setBusy, onChange, onClose}: {
    view: Window; settings: GitConnectionSettings; locale: string; readOrigin?: () => Promise<string | undefined>;
    busy: boolean; setBusy(busy: boolean): void; onChange(): void; onClose(): void;
}) {
    const labels = locale.startsWith('ja') ? ja : en;
    const dialog = useModal();
    const [allowPush, setAllowPush] = useState(false);
    const [allowReview, setAllowReview] = useState(false);
    const [error, setError] = useState<'error' | 'invalid' | 'noSaved' | null>(null);
    const [methods, setMethods] = useState<readonly DesktopAuthMethod[] | null>(null);
    const [method, setMethod] = useState<DesktopAuthMethod>('github-app');
    const [origin, setOrigin] = useState<string | null | undefined>(undefined);
    const [login, setLogin] = useState('');
    const [remember, setRemember] = useState(false);
    const active = useRef(true);
    useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
    const run = async (action: () => Promise<void>) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {await action();} catch (failure) {
            const code = (failure as Error).message;
            if (active.current) setError(code === 'INVALID_REMOTE' ? 'invalid' : code === 'NO_SAVED_CONNECTION' ? 'noSaved' : 'error');
        } finally {
            setBusy(false);
            onChange();
        }
    };
    const {mode: sessionMode, state, proxyOrigin, authorization} = settings.getView();
    const mode = state.status === 'connected' || state.status === 'connecting' ? sessionMode : preferredMode(view, settings.modes);
    const repository = origin && gitHubRepositoryFromOrigin(origin);
    useEffect(() => {
        let current = true;
        setOrigin(undefined);
        void Promise.resolve(readOrigin?.()).then(remote => {
            if (current) setOrigin(remote?.startsWith('https://github.com/') ? remote : null);
        }, () => {if (current) setOrigin(null);});
        return () => {current = false;};
    }, [readOrigin]);
    useEffect(() => {
        if (mode !== 'desktop' || !origin) return;
        let current = true;
        setMethods(null);
        async function load(remote: string) {
            const available: readonly DesktopAuthMethod[] = settings.getDesktopAuthMethods ?
                await settings.getDesktopAuthMethods(remote) : ['github-app'];
            if (!current) return;
            setMethods(available);
            setMethod(choice => available.includes(choice) ? choice : available[0] ?? 'github-app');
        }
        void load(origin).catch(() => {
            if (current) {
                setMethods([]);
                setError('error');
            }
        });
        return () => {current = false;};
    }, [mode, origin, settings]);

    const auth: DesktopAuthOptions = method === 'fine-grained-pat' ? {method, remember} :
        method === 'git-credential-helper' ? {method, login: login.trim()} : {method};
    const locked = busy || state.status === 'connecting' || state.status === 'connected';
    const desktopReady = mode !== 'desktop' || !!methods?.includes(method);
    const withRemote = (action: (remote: string) => Promise<void>) => run(async () => {
        const remote = await readOrigin?.();
        if (!remote || remote !== origin) throw new Error('INVALID_REMOTE');
        if (mode && sessionMode !== mode) await settings.select(mode);
        await action(remote);
    });
    const connect = () => withRemote(async remote => {
        if (mode === 'desktop') await settings.connect(remote, allowPush, allowReview, auth);
        else await (allowReview ? settings.connect(remote, allowPush, true) : settings.connect(remote, allowPush));
    });
    const restore = () => withRemote(async remote => {
        await (allowReview ? settings.restoreDesktop?.(remote, allowPush, true) : settings.restoreDesktop?.(remote, allowPush));
    });
    const connected = !!mode && state.status === 'connected';
    return <dialog className="twgit-panel twgit-connection-dialog" ref={dialog} aria-label={labels.repositoryTitle} onClose={onClose}>
        <header>
            <PanelIcon name="globe"/><h2>{labels.repositoryTitle}</h2>
            <CloseButton label={locale.startsWith('ja') ? '閉じる' : 'Close'} onClick={() => dialog.current?.close()}/>
        </header>
        <div className="twgit-connection-body">
            {!settings.modes.length ? <p>{labels.unavailable}</p> : <>
                {repository && <p>{labels.repository} · <strong>{repository}</strong></p>}
                {mode && <p>{labels.repositoryMode} · {labels[mode]}</p>}
                <p data-git-connection-state="" role="status">{labels[state.status]}</p>
                {sessionMode === mode && proxyOrigin && <p>{labels.proxy} · <code>{proxyOrigin}</code></p>}
                {state.status === 'connected' && <p>{labels.account} · {state.account.login}</p>}
                {origin === null && <p>{labels.noRemote}</p>}
                {mode === 'desktop' && methods && <>
                    {methods.length === 0 && <p>{labels.noDesktopMethod}</p>}
                    {methods.length > 0 && (methods.length > 1 || methods[0] !== 'github-app') &&
                        <label>{labels.authMethod} <select value={method} disabled={locked}
                            onChange={event => setMethod(event.currentTarget.value as DesktopAuthMethod)}>
                            {methods.map(choice => <option key={choice} value={choice}>{labels[choice]}</option>)}
                        </select></label>}
                    {methods.includes(method) && method === 'fine-grained-pat' && !connected && <>
                        <p>{labels.nativeToken} <a href="https://github.com/settings/personal-access-tokens/new" target="_blank"
                            rel="noopener noreferrer">{labels.tokenHelp}</a></p>
                        <label><input type="checkbox" checked={remember} disabled={locked}
                            onChange={event => setRemember(event.currentTarget.checked)}/> {labels.remember}</label>
                    </>}
                    {methods.includes(method) && method === 'git-credential-helper' && !connected &&
                        <label>{labels.login} <input type="text" value={login} maxLength={100} autoComplete="off"
                            disabled={locked} onChange={event => setLogin(event.currentTarget.value)}/></label>}
                </>}
                {mode && <>
                    {settings.getSession && <label><input type="checkbox" checked={allowPush}
                        disabled={locked}
                        onChange={event => setAllowPush(event.currentTarget.checked)}/> {labels.allowPush}</label>}
                    <label><input type="checkbox" data-git-allow-review="" checked={allowReview}
                        disabled={locked}
                        onChange={event => setAllowReview(event.currentTarget.checked)}/> {reviewLabelsFor(locale).allowReview}</label>
                    <button disabled={locked || !repository || !desktopReady ||
                        (mode === 'desktop' && auth.method === 'git-credential-helper' && !auth.login)}
                        onClick={connect}>{labels.connect}</button>
                    {mode === 'desktop' && settings.canRestoreDesktop && !connected &&
                        <button disabled={locked || !repository} onClick={restore}>{labels.restore}</button>}
                    {authorization && <>
                        <p>{authorization.userCode && <code>{authorization.userCode} </code>}
                            <a href={authorization.url} target="_blank" rel="noopener noreferrer">{labels.open}</a></p>
                        {authorization.userCode && <p>{labels.deviceCodeHelp} <a href="https://github.com/settings/apps/authorizations"
                            target="_blank" rel="noopener noreferrer">{labels.revokeApp}</a></p>}
                    </>}
                    {state.status !== 'disconnected' && <button disabled={busy}
                        onClick={() => void run(settings.refresh)}>{labels.check}</button>}
                    <button disabled={busy} onClick={() => void run(settings.disconnect)}>{labels.disconnect}</button>
                </>}
            </>}
            {error && <p className="twgit-error" role="alert">{labels[error]}</p>}
        </div>
    </dialog>;
}

export function GitHubSync({settings, locale, branch, busy, runOperation, syncStatus}: {
    settings: GitConnectionSettings; locale: string; branch: string | null | undefined; busy: boolean;
    runOperation(operation: RemoteOperation): Promise<void>;
    syncStatus?: {state: string; text: string; title: string};
}) {
    const {mode, state, write} = settings.getView();
    if (!settings.getSession || !mode || state.status !== 'connected') return null;
    const labels = locale.startsWith('ja') ? ja : en;
    return <div className="twgit-sync" role="group" aria-label={labels.sync}><strong>{labels.sync}</strong>
        <span className="twgit-sync-branch">{labels.localBranch}: {branch ? <code>{branch}</code> : labels.detached}</span>
        {(['fetch', 'pull', 'push'] as const).map(operation =>
        <button key={operation} type="button" title={operation === 'pull' ? labels.pullHint : undefined} disabled={busy || (operation === 'push' && !write)}
            onClick={() => void runOperation(operation)}>{labels[operation]}</button>)}
        {syncStatus && <span data-git-upstream={syncStatus.state} title={syncStatus.title}>{syncStatus.text}</span>}
    </div>;
}
