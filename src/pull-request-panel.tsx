import React, {useEffect, useMemo, useState} from 'react';
import {createGitHubPullRequests, gitHubRepositoryFromOrigin, PullRequestError} from './github-pull-requests.js';
import type {GitHubPullRequests} from './github-pull-requests.js';
import {ProjectSourceReview} from './project-source-review.js';
import type {ProjectBlockRenderer} from './scratch-block-diff-renderer.js';
import type {Repository} from './repository.js';
import type {ProjectBlockLocator} from './block-diff-location.js';
import {readProjectSourceDiff} from './project-source-patch.js';
import type {ProjectSourceTabsFile} from './project-source-tabs.js';

type OpenTabs = (key: string, files: readonly ProjectSourceTabsFile[], rememberAs?: string) => number;

const en = {
    title: 'Pull requests', number: 'Pull request number', openNumber: 'Open pull request',
    open: 'Open', closed: 'Closed', merged: 'Merged', draft: 'Draft',
    prev: 'Previous page', next: 'Next page', empty: 'No pull requests on this page.',
    loading: 'Reading GitHub…', select: 'Select a pull request to review its changes.', onGitHub: 'Open on GitHub',
    noOrigin: 'Choose a repository whose origin is on GitHub.',
    unavailable: 'GitHub could not read this repository or pull request. The panel supports public repositories.',
    rateLimit: 'The public GitHub API rate limit was reached. Try again after the limit resets.',
    failed: 'Could not read GitHub. Try again.', changed: 'The pull request changed while it was being read. Open it again.',
    tooManyFiles: 'GitHub only returns the first 3,000 changed files. This pull request exceeds that limit.',
    openTabs: 'Open as tabs'
};
const ja: typeof en = {
    title: 'プルリクエスト', number: 'プルリクエスト番号', openNumber: 'PR を開く',
    open: 'オープン', closed: 'クローズ済み', merged: 'マージ済み', draft: 'ドラフト',
    prev: '前のページ', next: '次のページ', empty: 'このページにプルリクエストはありません。',
    loading: 'GitHub から取得中…', select: 'プルリクエストを選ぶと差分内容を確認できます。', onGitHub: 'GitHub で開く',
    noOrigin: 'GitHub のリポジトリを origin に設定した作業フォルダを選んでください。',
    unavailable: 'GitHub のリポジトリまたは PR を取得できません。公開リポジトリに対応しています。',
    rateLimit: '公開 GitHub API の利用上限に達しました。上限の解除後に再試行してください。',
    failed: 'GitHub から取得できませんでした。再試行してください。',
    changed: '取得中にプルリクエストが更新されました。もう一度開いてください。',
    tooManyFiles: '変更ファイルが GitHub API の取得上限である 3,000 件を超えています。',
    openTabs: 'タブで開く'
};

function errorMessage(error: unknown, labels: typeof en) {
    return error instanceof PullRequestError ? labels[error.code] : labels.failed;
}

type Result<T> = {data: T; error?: never} | {data?: never; error: string};
type Listing = Awaited<ReturnType<GitHubPullRequests['list']>>;
type Pull = Awaited<ReturnType<GitHubPullRequests['load']>>;

function PullRequests({name, labels, locale, renderBlock, locateFor, openTabs}: {
    name: string; labels: typeof en; locale: string; renderBlock: ProjectBlockRenderer;
    locateFor?(path: string, headSha: string): ProjectBlockLocator | undefined;
    openTabs?: OpenTabs;
}) {
    const client = useMemo(() => createGitHubPullRequests(name), [name]);
    const [page, setPage] = useState(1);
    const [listing, setListing] = useState<{page: number; result: Result<Listing>}>();
    const [input, setInput] = useState('');
    const [selection, setSelection] = useState<{number: number}>();
    const [loaded, setLoaded] = useState<{selection: NonNullable<typeof selection>; result: Result<Pull>}>();
    const list = listing?.page === page ? listing.result : undefined;
    const detail = loaded?.selection === selection ? loaded?.result : undefined;
    useEffect(() => {
        const controller = new AbortController();
        setListing(undefined);
        void client.list(page, controller.signal).then(data => {
            if (!controller.signal.aborted) setListing({page, result: {data}});
        }, error => {
            if (!controller.signal.aborted) setListing({page, result: {error: errorMessage(error, labels)}});
        });
        return () => controller.abort();
    }, [client, page, labels]);
    useEffect(() => {
        if (!selection) return;
        const controller = new AbortController();
        void client.load(selection.number, controller.signal).then(data => {
            if (!controller.signal.aborted) setLoaded({selection, result: {data}});
        }, error => {
            if (!controller.signal.aborted) setLoaded({selection, result: {error: errorMessage(error, labels)}});
        });
        return () => controller.abort();
    }, [client, selection, labels]);
    const choose = (number: number) => {
        if (!Number.isSafeInteger(number) || number < 1) return;
        setSelection({number});
        setInput(String(number));
    };
    const pr = detail?.data;
    return <div className="twgit-content">
        <aside>
            <h3>{labels.title}</h3>
            <p>{name}</p>
            <form className="twgit-pr-number" onSubmit={event => {event.preventDefault(); choose(Number(input));}}>
                <label>{labels.number}<input type="number" required min={1} max={Number.MAX_SAFE_INTEGER}
                    value={input} onChange={event => setInput(event.currentTarget.value)}/></label>
                <button type="submit">{labels.openNumber}</button>
            </form>
            {!list && <p role="status">{labels.loading}</p>}
            {list?.error && <p role="alert">{list.error}</p>}
            {list?.data && <>
                {!list.data.items.length && <p>{labels.empty}</p>}
                <ul>{list.data.items.map(item => <li key={item.number}>
                    <button className="twgit-file" type="button" aria-pressed={selection?.number === item.number}
                        onClick={() => choose(item.number)}>#{item.number} {item.title}</button>
                </li>)}</ul>
                <div className="twgit-pr-paging">
                    <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>{labels.prev}</button>
                    <button type="button" disabled={!list.data.more} onClick={() => setPage(page + 1)}>{labels.next}</button>
                </div>
            </>}
        </aside>
        <main className="twgit-diff">
            {!selection && <p>{labels.select}</p>}
            {selection && !detail && <p role="status">{labels.loading}</p>}
            {detail?.error && <p role="alert">{detail.error}</p>}
            {pr && <>
                <p className="twgit-pr-revision">
                    <strong>#{pr.number} · {labels[pr.state]}</strong>
                    {pr.author && <span>{pr.author}</span>}
                    <code title={pr.head.sha}>{pr.head.ref} → {pr.base.ref}</code>
                    <a href={pr.url} target="_blank" rel="noreferrer">{labels.onGitHub}</a>
                    {openTabs && <button type="button" data-git-open-tabs="" onClick={() => openTabs(`${name}#${pr.number}@${pr.head.sha}`,
                        pr.files.flatMap(file => {
                            if (!('patch' in file)) return [];
                            let projects;
                            try {
                                projects = readProjectSourceDiff(file.patch, file.beforeSource);
                            } catch {
                                return [];
                            }
                            return projects ? [{path: file.path, before: projects[0], after: projects[1], loadAsset: file.loadAsset,
                                locateBlock: locateFor?.(file.path, pr.head.sha)}] : [];
                        }), `${name}#${pr.number}`)}>{labels.openTabs}</button>}
                </p>
                <ProjectSourceReview title={pr.title} description={pr.description} files={locateFor ? pr.files.map(file => 'patch' in file ? {...file, locateBlock: locateFor(file.path, pr.head.sha)} : file) : pr.files}
                    renderBlock={renderBlock} locale={locale} rememberAs={`${name}#${pr.number}`}/>
            </>}
        </main>
    </div>;
}

export function PullRequestReviewPanel({repository, locale, renderBlock, locateFor, openTabs}: {
    repository: Repository; locale: string; renderBlock: ProjectBlockRenderer;
    /** Opens a pull request's project changes as tabs of the host's layout. */
    openTabs?: OpenTabs;
    /** Returns a locator for a project file whose PR head matches the open project, or `undefined`. */
    locateFor?(path: string, headSha: string): ProjectBlockLocator | undefined;
}) {
    const labels = locale.startsWith('ja') ? ja : en;
    const [origin, setOrigin] = useState<{repository: Repository; name: string | null; failed?: boolean}>();
    useEffect(() => {
        let active = true;
        void repository.readOrigin().then(value => {
            if (active) setOrigin({repository, name: gitHubRepositoryFromOrigin(value)});
        }, () => {
            if (active) setOrigin({repository, name: null, failed: true});
        });
        return () => {active = false;};
    }, [repository]);
    if (origin?.repository !== repository) return <p role="status" className="twgit-context">{labels.loading}</p>;
    if (!origin.name) return <p className="twgit-context" role="status">{origin.failed ? labels.failed : labels.noOrigin}</p>;
    return <PullRequests key={origin.name} name={origin.name} labels={labels} locale={locale} renderBlock={renderBlock} locateFor={locateFor} openTabs={openTabs}/>;
}
