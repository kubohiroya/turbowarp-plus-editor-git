import React, {useEffect, useRef, useState} from 'react';
import type {GitAuthState, GitConnectionMode as Mode} from '@kubohiroya/turbowarp-plus-editor-auth';
import type {GetRemoteSession, RemoteOperation} from './remote-operations.js';
import {reviewLabelsFor} from './messages.js';

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
    connect(remote: string, write?: boolean, review?: boolean): Promise<void>;
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
    const [error, setError] = useState<'error' | 'invalid' | null>(null);
    const active = useRef(true);
    useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
    const run = async (action: () => Promise<void>) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {await action();} catch (failure) {
            if (active.current) setError((failure as Error).message === 'INVALID_REMOTE' ? 'invalid' : 'error');
        } finally {
            if (active.current) {setBusy(false); update(value => value + 1);}
        }
    };
    const {mode, state, proxyOrigin, authorization, write} = settings.getView();
    const connect = () => run(async () => {
        const remote = await readOrigin?.();
        if (!remote) throw new Error('INVALID_REMOTE');
        await (allowReview ? settings.connect(remote, allowPush, true) : settings.connect(remote, allowPush));
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
            {mode && <>
                {runOperation && <label><input type="checkbox" checked={allowPush}
                    disabled={busy || state.status === 'connecting' || state.status === 'connected'}
                    onChange={event => setAllowPush(event.currentTarget.checked)}/> {labels.allowPush}</label>}
                <label><input type="checkbox" data-git-allow-review="" checked={allowReview}
                    disabled={busy || state.status === 'connecting' || state.status === 'connected'}
                    onChange={event => setAllowReview(event.currentTarget.checked)}/> {reviewLabelsFor(locale).allowReview}</label>
                <button disabled={busy || !readOrigin || state.status === 'connecting' || state.status === 'connected'}
                    onClick={connect}>{labels.connect}</button>
                {authorization && <p>{authorization.userCode && <code>{authorization.userCode} </code>}
                    <a href={authorization.url} target="_blank" rel="noopener noreferrer">{labels.open}</a></p>}
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
