import React, {useEffect, useRef, useState} from 'react';
import type {GitAuthState, GitConnectionMode as Mode} from '@kubohiroya/turbowarp-plus-editor-auth';
import type {GetRemoteSession, RemoteOperation} from './remote-operations.js';
import {reviewLabelsFor} from './messages.js';

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
    title: 'GitHub connection', mode: 'Connection mode', select: 'Choose a connection',
    desktop: 'Desktop local', cloudflare: 'Cloudflare', proxy: 'Proxy', account: 'Account',
    'disconnected': 'Disconnected', 'connecting': 'Waiting for GitHub', 'connected': 'Connected',
    'reauth-required': 'Sign in again', connect: 'Connect to GitHub', open: 'Open GitHub authorization',
    check: 'Check connection', disconnect: 'Disconnect', noRemote: 'Choose a repository with a GitHub HTTPS origin.',
    unavailable: 'No GitHub connection is configured.', changed: 'Switching disconnects the current session.',
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
    allowPush: 'Allow sending to GitHub (push)', fetch: 'Check GitHub (fetch)', pull: 'Get from GitHub (pull)', push: 'Send to GitHub (push)'
};
const ja: typeof en = {
    title: 'GitHub 接続', mode: '接続方式', select: '接続方式を選択',
    desktop: 'Desktop ローカル', cloudflare: 'Cloudflare', proxy: 'プロキシ', account: 'アカウント',
    'disconnected': '未接続', 'connecting': 'GitHub の認証待ち', 'connected': '接続済み',
    'reauth-required': '再認証が必要', connect: 'GitHub に接続', open: 'GitHub の認証を開く',
    check: '接続を確認', disconnect: '切断', noRemote: 'GitHub の HTTPS リモート origin があるリポジトリを選択してください。',
    unavailable: 'GitHub 接続先が設定されていません。', changed: '方式を切り替えると現在のセッションを切断します。',
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
    allowPush: 'GitHub に送ることを許可する（push）', fetch: 'GitHub と確かめる（fetch）', pull: 'GitHub から取り込む（pull）', push: 'GitHub に送る（push）'
};

export function ConnectionSettings({settings, locale, readOrigin, runOperation}: {
    settings: GitConnectionSettings; locale: string; readOrigin?: () => Promise<string | undefined>;
    runOperation?: (operation: RemoteOperation) => Promise<void>;
}) {
    const labels = locale.startsWith('ja') ? ja : en;
    const [, update] = useState(0);
    const [busy, setBusy] = useState(false);
    const [allowPush, setAllowPush] = useState(false);
    const [allowReview, setAllowReview] = useState(false);
    const [error, setError] = useState<'error' | 'invalid' | 'noSaved' | null>(null);
    const [methods, setMethods] = useState<readonly DesktopAuthMethod[] | null>(null);
    const [method, setMethod] = useState<DesktopAuthMethod>('github-app');
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
            if (active.current) {setBusy(false); update(value => value + 1);}
        }
    };
    const {mode, state, proxyOrigin, authorization, write} = settings.getView();
    useEffect(() => {
        if (mode !== 'desktop') return;
        let current = true;
        setMethods(null);
        async function load() {
            const remote = await readOrigin?.();
            const available: readonly DesktopAuthMethod[] = settings.getDesktopAuthMethods ?
                await settings.getDesktopAuthMethods(remote) : ['github-app'];
            if (!current) return;
            setMethods(available);
            setMethod(choice => available.includes(choice) ? choice : available[0] ?? 'github-app');
        }
        void load().catch(() => {
            if (current) {
                setMethods([]);
                setError('error');
            }
        });
        return () => {current = false;};
    }, [mode, readOrigin, settings]);

    const auth: DesktopAuthOptions = method === 'fine-grained-pat' ? {method, remember} :
        method === 'git-credential-helper' ? {method, login: login.trim()} : {method};
    const locked = busy || state.status === 'connecting' || state.status === 'connected';
    const desktopReady = mode !== 'desktop' || !!methods?.includes(method);
    const connect = () => run(async () => {
        const remote = await readOrigin?.();
        if (!remote) throw new Error('INVALID_REMOTE');
        if (mode === 'desktop') await settings.connect(remote, allowPush, allowReview, auth);
        else await (allowReview ? settings.connect(remote, allowPush, true) : settings.connect(remote, allowPush));
    });
    const restore = () => run(async () => {
        const remote = await readOrigin?.();
        if (!remote) throw new Error('INVALID_REMOTE');
        await (allowReview ? settings.restoreDesktop?.(remote, allowPush, true) : settings.restoreDesktop?.(remote, allowPush));
    });
    const connected = !!mode && state.status === 'connected';
    // Sync sits beside the GitHub status; the settings open over the list instead of pushing it down.
    return <>
        {runOperation && connected && <span className="twgit-sync">{(['fetch', 'pull', 'push'] as const).map(operation =>
            <button key={operation} disabled={busy || !readOrigin || (operation === 'push' && !write)}
                onClick={() => void run(() => runOperation(operation))}>{labels[operation]}</button>)}</span>}
    <details className="twgit-connection">
        <summary>{labels.title}</summary>
        <div className="twgit-connection-body">
        {!settings.modes.length ? <p>{labels.unavailable}</p> : <>
            <label>{labels.mode} <select value={mode ?? ''} disabled={busy}
                onChange={event => {const choice = event.currentTarget.value as Mode; void run(() => settings.select(choice));}}>
                <option value="" disabled>{labels.select}</option>
                {settings.modes.map(choice => <option key={choice} value={choice}>{labels[choice]}</option>)}
            </select></label>
            <p>{labels.changed}</p>
            <p data-git-connection-state="" role="status">{labels[state.status]}</p>
            {proxyOrigin && <p>{labels.proxy} · <code>{proxyOrigin}</code></p>}
            {state.status === 'connected' && <p>{labels.account} · {state.account.login}</p>}
            {!readOrigin && <p>{labels.noRemote}</p>}
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
                {runOperation && <label><input type="checkbox" checked={allowPush}
                    disabled={locked}
                    onChange={event => setAllowPush(event.currentTarget.checked)}/> {labels.allowPush}</label>}
                <label><input type="checkbox" data-git-allow-review="" checked={allowReview}
                    disabled={locked}
                    onChange={event => setAllowReview(event.currentTarget.checked)}/> {reviewLabelsFor(locale).allowReview}</label>
                <button disabled={locked || !readOrigin || !desktopReady ||
                    (mode === 'desktop' && auth.method === 'git-credential-helper' && !auth.login)}
                    onClick={connect}>{labels.connect}</button>
                {mode === 'desktop' && settings.canRestoreDesktop && !connected &&
                    <button disabled={locked || !readOrigin} onClick={restore}>{labels.restore}</button>}
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
        </div>
    </details>
        {error && <p className="twgit-error" role="alert">{labels[error]}</p>}
    </>;
}
