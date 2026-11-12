import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createGitHubPullRequests, gitHubRepositoryFromOrigin, PullRequestError, pullRequestPageSize} from './github-pull-requests.js';
import type {GitHubPullRequests, PullRequestListItem, PullRequestStatus} from './github-pull-requests.js';
import {ProjectSourceReview} from './project-source-review.js';
import type {ProjectBlockRenderer} from './scratch-block-diff-renderer.js';
import type {Repository} from './repository.js';
import type {ProjectBlockLocator} from './block-diff-location.js';
import {readProjectSourceDiff} from './project-source-patch.js';
import type {ProjectSourceTabsFile} from './project-source-tabs.js';
import {GitPanelError} from './filesystem.js';
import type {GetRemoteSession} from './remote-operations.js';
import {listPullRequestRefs} from './remote-operations.js';
import type {ProjectSourceReviewFile} from './project-source-review.js';
import {pullRequestBranch} from './local-operations.js';
import {createGitHubReviewApi, GitHubReviewError} from './github-review-api.js';
import {PullRequestReviewComposer} from './review-composer.js';
import {reviewLabelsFor} from './messages.js';

type OpenTabs = (key: string, files: readonly ProjectSourceTabsFile[], rememberAs?: string) => number;

const en = {
    choose: 'Choose a pull request',
    open: 'Open', closed: 'Closed', merged: 'Merged', draft: 'Draft',
    mergeable: 'Ready to merge', conflicting: 'Merge conflicts', blocked: 'Merge blocked', unknown: 'Status unavailable',
    mergeUnknown: 'Merge status unavailable', page: 'Page {page}',
    prev: 'Previous page', next: 'Next page', empty: 'No pull requests on this page.',
    loading: 'Reading GitHub…', select: 'Select a pull request to review its changes.', onGitHub: 'Open on GitHub',
    noOrigin: 'Choose a repository whose origin is on GitHub.',
    unavailable: 'GitHub could not read this repository or pull request. The panel supports public repositories.',
    rateLimit: 'The public GitHub API rate limit was reached. Try again after the limit resets.',
    failed: 'Could not read GitHub. Try again.', changed: 'The pull request changed while it was being read. Open it again.',
    tooManyFiles: 'GitHub only returns the first 3,000 changed files. This pull request exceeds that limit.',
    openTabs: 'Open as tabs',
    session: 'Connect to GitHub again (GitHub connection) to read this pull request.',
    forbidden: 'The GitHub connection is not allowed to read this repository.',
    pullRequestNotFound: 'This repository has no pull request with this number.',
    network: 'Could not reach GitHub through the connection. Check the network and try again.',
    remoteFailed: 'Could not read the pull request through the GitHub connection. Try again.',
    baseMissing: 'The base branch is not on GitHub. Choose another base branch.',
    viaConnection: 'Read through the GitHub connection.',
    noMetadata: 'The title and base branch are unavailable. Choose the base branch to compare with.',
    base: 'Base branch', pullRequest: 'Pull request',
    openLocally: 'Open here as {branch}',
    openLocallyHint: 'Creates the local branch {branch} at this version, switches to it and opens the project, so it can be run. Unsaved edits and unrecorded changes stop it. Switch back in Local changes.'
};
const ja: typeof en = {
    choose: 'PR を選ぶ',
    open: 'オープン', closed: 'クローズ済み', merged: 'マージ済み', draft: 'ドラフト',
    mergeable: 'マージ可能', conflicting: '競合あり', blocked: 'マージ条件未達', unknown: '状態未確認',
    mergeUnknown: 'マージ可否未確認', page: '{page} ページ目',
    prev: '前のページ', next: '次のページ', empty: 'このページにプルリクエストはありません。',
    loading: 'GitHub から取得中…', select: 'プルリクエストを選ぶと差分内容を確認できます。', onGitHub: 'GitHub で開く',
    noOrigin: 'GitHub のリポジトリを origin に設定した作業フォルダを選んでください。',
    unavailable: 'GitHub のリポジトリまたは PR を取得できません。公開リポジトリに対応しています。',
    rateLimit: '公開 GitHub API の利用上限に達しました。上限の解除後に再試行してください。',
    failed: 'GitHub から取得できませんでした。再試行してください。',
    changed: '取得中にプルリクエストが更新されました。もう一度開いてください。',
    tooManyFiles: '変更ファイルが GitHub API の取得上限である 3,000 件を超えています。',
    openTabs: 'タブで開く',
    session: 'この PR を読むには、GitHub 接続でもう一度接続してください。',
    forbidden: 'GitHub 接続に、このリポジトリを読む権限がありません。',
    pullRequestNotFound: 'このリポジトリに、この番号のプルリクエストはありません。',
    network: 'GitHub 接続で GitHub に届きませんでした。ネットワークを確認して、もう一度試してください。',
    remoteFailed: 'GitHub 接続でプルリクエストを読めませんでした。もう一度試してください。',
    baseMissing: 'ベースのブランチが GitHub にありません。別のベースを選んでください。',
    viaConnection: 'GitHub 接続で取得しました。',
    noMetadata: '題名とベースのブランチを取得できませんでした。比べるベースのブランチを選んでください。',
    base: 'ベースのブランチ', pullRequest: 'プルリクエスト',
    openLocally: '{branch} として手元で開く',
    openLocallyHint: 'この版にローカルブランチ {branch} を作って切り替え、作品を開き直して実行できるようにします。保存していない編集や記録していない変更があるときは行いません。元に戻すときは「ローカルの変更」で切り替えてください。'
};

const gitErrors = ['session', 'forbidden', 'pullRequestNotFound', 'network', 'remoteFailed', 'baseMissing', 'changed'] as const;
function errorMessage(error: unknown, labels: typeof en) {
    if (error instanceof PullRequestError) return labels[error.code];
    if (error instanceof GitPanelError) {
        const code = gitErrors.find(code => code === error.code);
        return code ? labels[code] : labels.failed;
    }
    return labels.failed;
}

/**
 * Opens a pull request version fetched over the connection in the work tree: the host creates (or reuses) the local
 * branch `pullRequestBranch(number)` at `head` and switches to it. `busy` disables the button.
 */
export interface PullRequestOpenLocally {
    open(number: number, head: string): unknown;
    busy: boolean;
}

/** The person's GitHub connection: while it is connected, pull request contents are read over Git Smart HTTP. */
export interface PullRequestConnection {
    getSession: GetRemoteSession;
    connected(): boolean;
    /** Whether the connection was made with the grant to send reviews; then a review can be sent through it. */
    reviewGranted?(): boolean;
}

type Result<T> = {data: T; error?: never} | {data?: never; error: string};
type ListSource = 'public' | 'connection' | 'refs';
type Listing = {items: PullRequestListItem[]; more: boolean; source: ListSource; remaining?: string | null};
type Metadata = Awaited<ReturnType<GitHubPullRequests['metadata']>>;

function PullRequestIcon({status}: {status: PullRequestStatus}) {
    const mark = {
        mergeable: 'M4.5 8.5 7 11l4.5-5',
        merged: 'M5 4v8m0-6c0 3 2 4 6 4m-2-2 2 2-2 2',
        conflicting: 'M8 4.5v4m0 2.5v.5',
        blocked: 'M6.5 5v6m3-6v6',
        closed: 'm5.5 5.5 5 5m0-5-5 5',
        draft: 'M6 4.5h2m2 0h.5V6m0 2v1.5m0 2H9m-2 0H5.5V10m0-2V6.5',
        open: 'M5.5 6.5v5m5-4v4m0-4c0-2-1-3-3-3m0 0 1.5-1.5M7.5 4.5 9 6',
        unknown: 'M6.5 6a1.5 1.5 0 1 1 2.6 1c-.7.6-1.1 1-1.1 1.5m0 2.5v.5'
    }[status];
    return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35"
        strokeLinecap="round" strokeLinejoin="round"><path d={mark}/></svg>;
}

/** A pull request to show: from the public API, or from Git objects fetched over the connection. */
type Pull = {
    number: number; title: string; description: string; author?: string; state?: Metadata['state'];
    head: {sha: string; ref: string}; base: {ref: string | null; sha: string};
    files: readonly ProjectSourceReviewFile[]; url: string;
    /** Set when the contents came over the connection: the branches to compare with, when the API gave no base. */
    git?: {branches: readonly string[] | null};
};

function PullRequests({name, remote, labels, locale, renderBlock, locateFor, openTabs, repository, connection, openLocally}: {
    name: string; remote?: string; labels: typeof en; locale: string; renderBlock: ProjectBlockRenderer;
    locateFor?(path: string, headSha: string): ProjectBlockLocator | undefined;
    openTabs?: OpenTabs; repository: Repository; connection?: PullRequestConnection; openLocally?: PullRequestOpenLocally;
}) {
    const client = useMemo(() => createGitHubPullRequests(name), [name]);
    // Reviews go through the connection's proxy, which keeps the GitHub token.
    const reviewApi = useMemo(() => {
        if (!remote || !connection) return null;
        try {
            return createGitHubReviewApi({remote, getSession: connection.getSession});
        } catch {
            return null;
        }
    }, [remote, connection]);
    const [page, setPage] = useState(1);
    const [listing, setListing] = useState<{page: number; result: Result<Listing>}>();
    const [selection, setSelection] = useState<{number: number; source: ListSource; base?: string}>();
    const [loaded, setLoaded] = useState<{selection: NonNullable<typeof selection>; result: Result<Pull>}>();
    const list = listing?.page === page ? listing.result : undefined;
    const listed = list?.data;
    const connected = connection?.connected() === true;
    const detail = loaded?.selection === selection ? loaded?.result : undefined;
    useEffect(() => {
        const controller = new AbortController();
        const {signal} = controller;
        setListing(undefined);
        const load = async (): Promise<Listing> => {
            try {
                return {...await client.list(page, signal), source: 'public'};
            } catch (error) {
                if (!connected || !remote || !connection) throw error;
                signal.throwIfAborted();
            }
            if (reviewApi) {
                try {
                    return {...await reviewApi.pullRequests(page, signal), source: 'connection'};
                } catch {
                    signal.throwIfAborted();
                }
            }
            const refs = await listPullRequestRefs(remote, connection.getSession, signal);
            const end = page * pullRequestPageSize;
            const items: PullRequestListItem[] = refs.slice(end - pullRequestPageSize, end)
                .map(ref => ({...ref, title: labels.pullRequest, base: undefined, status: 'unknown'}));
            return {source: 'refs', items, more: refs.length > end};
        };
        void load().then(async data => {
            if (signal.aborted) return;
            setListing({page, result: {data}});
            // Leave requests for opening a diff and for other public API reads.
            let budget = data.remaining == null ? pullRequestPageSize : Math.max(0, Number(data.remaining) - 12);
            for (const item of data.items) {
                if (signal.aborted || budget <= 0) break;
                if (item.status !== 'open' || !item.head || !item.base) continue;
                try {
                    budget--;
                    const {head, base, status} = data.source === 'connection' && reviewApi ?
                        await reviewApi.pullRequestStatus(item.number, signal) : await client.listItemStatus(item.number, signal);
                    if (signal.aborted || item.head !== head || item.base !== base || status === item.status) continue;
                    setListing(previous => previous?.page === page && previous.result.data ?
                        {page, result: {data: {...previous.result.data, items: previous.result.data.items
                            .map(row => row.number === item.number ? {...row, status} : row)}}} : previous);
                } catch (error) {
                    if ((error instanceof PullRequestError && error.code === 'rateLimit') ||
                        (error instanceof GitHubReviewError && error.code !== 'PULL_REQUEST_NOT_FOUND')) break;
                }
            }
        }, error => {
            if (!signal.aborted) setListing({page, result: {error: errorMessage(error, labels)}});
        });
        return () => controller.abort();
    }, [client, page, labels, connected, reviewApi, remote, connection]);
    useEffect(() => {
        if (!selection) return;
        const controller = new AbortController();
        const load = (): Promise<Pull> => connected ?
            loadThroughConnection(selection, controller.signal) : client.load(selection.number, controller.signal);
        void load().then(data => {
            if (!controller.signal.aborted) setLoaded({selection, result: {data}});
        }, error => {
            if (!controller.signal.aborted) setLoaded({selection, result: {error: errorMessage(error, labels)}});
        });
        return () => controller.abort();
    }, [client, selection, labels, connected, reviewApi, repository, connection]);
    const fetched = useRef<{number: number; head: string; branches: readonly string[]; defaultBranch: string | null}>();
    /**
     * Fetches `refs/pull/<number>/head` and the branches over Git Smart HTTP and compares them from local objects. The
     * listing's metadata source supplies the title, description and base when available.
     */
    const loadThroughConnection = async ({number, source, base: chosenBase}: NonNullable<typeof selection>, signal: AbortSignal): Promise<Pull> => {
        const guard = () => {if (signal.aborted) throw new GitPanelError('changed');};
        let head: string, branches: readonly string[], defaultBranch: string | null;
        let metadata: Omit<Metadata, 'url'> | null = null;
        if (chosenBase !== undefined && fetched.current?.number === number) {
            ({head, branches, defaultBranch} = fetched.current);
        } else {
            if (source !== 'refs') {
                const readMetadata = source === 'connection' && reviewApi ?
                    reviewApi.pullRequest(number, signal) : client.metadata(number, signal);
                metadata = await readMetadata.catch(error => {
                    if (signal.aborted) throw error;
                    return null;
                });
            }
            const result = await repository.fetchPullRequest(number, connection!.getSession, guard, signal);
            if (metadata && metadata.head.sha !== result.head) throw new PullRequestError('changed');
            ({head, branches, defaultBranch} = result);
            fetched.current = {number, head, branches, defaultBranch};
        }
        const branch = chosenBase ?? metadata?.base.ref ?? defaultBranch ?? branches[0];
        const read = await repository.readPullRequest(head, {sha: metadata?.base.sha, branch});
        guard();
        return {number, title: metadata?.title ?? `${labels.pullRequest} #${number}`, description: metadata?.description ?? '',
            author: metadata?.author, state: metadata?.state, head: {sha: head, ref: metadata?.head.ref ?? `pull/${number}/head`},
            base: read.base, files: read.files, url: 'https://github.com/' + name + '/pull/' + number,
            git: {branches: metadata ? null : branches}};
    };
    const pr = detail?.data;
    // A review is written and sent for contents read over the connection, when it was made with the review grant.
    const reviewing = !!pr?.git && !!reviewApi && !!connection?.connected() && !!connection.reviewGranted?.();
    return <div className="twgit-content twgit-pr-content">
        <aside className="twgit-pr-picker" aria-label={labels.choose}>
            <h3>{labels.choose}</h3>
            <p className="twgit-pr-repository">{name}</p>
            {!list && <p role="status">{labels.loading}</p>}
            {list?.error && <p role="alert">{list.error}</p>}
            {listed && <>
                {!listed.items.length && <p>{labels.empty}</p>}
                {!!listed.items.length && <ul className="twgit-pr-list">{listed.items.map(item => <li key={item.number}>
                    <button className="twgit-pr-option" type="button" data-status={item.status}
                        aria-pressed={selection?.number === item.number}
                        onClick={() => setSelection({number: item.number, source: listed.source})}>
                        <span className="twgit-pr-icon"><PullRequestIcon status={item.status}/></span>
                        <span className="twgit-pr-item">
                            <span className="twgit-pr-item-title"><strong>#{item.number}</strong> {item.title}</span>
                            <span className="twgit-pr-item-status">{item.status === 'open' ? labels.mergeUnknown : labels[item.status]}</span>
                        </span>
                    </button>
                </li>)}</ul>}
            </>}
            {(page > 1 || listed?.more) && <div className="twgit-pr-paging">
                <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>{labels.prev}</button>
                <span>{labels.page.replace('{page}', String(page))}</span>
                <button type="button" disabled={!listed?.more} onClick={() => setPage(page + 1)}>{labels.next}</button>
            </div>}
        </aside>
        <main className="twgit-diff">
            {!selection && <p>{labels.select}</p>}
            {selection && !detail && <p role="status">{labels.loading}</p>}
            {detail?.error && <p role="alert">{detail.error}</p>}
            {pr && <>
                <p className="twgit-pr-revision">
                    <strong>#{pr.number}{pr.state && <> · {labels[pr.state]}</>}</strong>
                    {pr.author && <span>{pr.author}</span>}
                    <code title={pr.head.sha}>{pr.head.ref} → {pr.base.ref ?? pr.base.sha.slice(0, 12)}</code>
                    {pr.git?.branches && <label>{labels.base} <select data-git-pr-base="" value={pr.base.ref ?? ''}
                        onChange={event => setSelection({...selection!, base: event.currentTarget.value})}>
                        {pr.git.branches.map(branch => <option key={branch} value={branch}>{branch}</option>)}
                    </select></label>}
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
                    {pr.git && openLocally && <button type="button" data-git-open-pr-locally="" disabled={openLocally.busy}
                        title={labels.openLocallyHint.replace('{branch}', pullRequestBranch(pr.number))}
                        onClick={() => void openLocally.open(pr.number, pr.head.sha)}>
                        {labels.openLocally.replace('{branch}', pullRequestBranch(pr.number))}</button>}
                </p>
                {pr.git && <p className="twgit-context" role="status">{labels.viaConnection}{pr.git.branches && <> {labels.noMetadata}</>}</p>}
                {pr.git && connection?.connected() && !connection.reviewGranted?.() &&
                    <p className="twgit-context" role="status">{reviewLabelsFor(locale).needsGrant}</p>}
                <ProjectSourceReview title={pr.title} description={pr.description} files={locateFor ? pr.files.map(file => 'patch' in file ? {...file, locateBlock: locateFor(file.path, pr.head.sha)} : file) : pr.files}
                    renderBlock={renderBlock} locale={locale} rememberAs={`${name}#${pr.number}`}
                    commentAs={reviewing ? `${name}#${pr.number}` : undefined}/>
                {reviewing && reviewApi && <PullRequestReviewComposer key={`${name}#${pr.number}`} api={reviewApi} name={`${name}#${pr.number}`}
                    number={pr.number} head={pr.head.sha} changedFiles={pr.files.map(file => file.path)} url={pr.url} locale={locale}/>}
            </>}
        </main>
    </div>;
}

export function PullRequestReviewPanel({repository, locale, renderBlock, locateFor, openTabs, connection, openLocally}: {
    repository: Repository; locale: string; renderBlock: ProjectBlockRenderer;
    /**
     * While connected, pull request contents are fetched over Git Smart HTTP (`refs/pull/<number>/head`) and compared
     * from local Git objects, so private repositories can be reviewed. Without it, the public GitHub API is read.
     */
    connection?: PullRequestConnection;
    /**
     * Offers to open a pull request read over the connection in the work tree, on the branch `pr/<number>`. Pull
     * requests read from the public API have no local objects, so the button is not shown for them.
     */
    openLocally?: PullRequestOpenLocally;
    /** Opens a pull request's project changes as tabs of the host's layout. */
    openTabs?: OpenTabs;
    /** Returns a locator for a project file whose PR head matches the open project, or `undefined`. */
    locateFor?(path: string, headSha: string): ProjectBlockLocator | undefined;
}) {
    const labels = locale.startsWith('ja') ? ja : en;
    const [origin, setOrigin] = useState<{repository: Repository; name: string | null; remote?: string; failed?: boolean}>();
    useEffect(() => {
        let active = true;
        void repository.readOrigin().then(value => {
            if (active) setOrigin({repository, name: gitHubRepositoryFromOrigin(value), remote: value});
        }, () => {
            if (active) setOrigin({repository, name: null, failed: true});
        });
        return () => {active = false;};
    }, [repository]);
    if (origin?.repository !== repository) return <p role="status" className="twgit-context">{labels.loading}</p>;
    if (!origin.name) return <p className="twgit-context" role="status">{origin.failed ? labels.failed : labels.noOrigin}</p>;
    return <PullRequests key={origin.name} name={origin.name} remote={origin.remote} labels={labels} locale={locale} renderBlock={renderBlock} locateFor={locateFor} openTabs={openTabs}
        repository={repository} connection={connection} openLocally={openLocally}/>;
}
