import {createProjectSourceDiff, isRecord} from './project-source-patch.js';
import type {ProjectSourceReviewFile} from './project-source-review.js';
import {assetLimit, assetsDirectoryParts, folderSettingsLimit, isAssetName} from './project-asset-paths.js';
import type {ProjectAssetLoader, ProjectVersion} from './project-assets.js';
import type {FileVersion, MergedFileVersions} from './change-marks.js';

type ErrorCode = 'unavailable' | 'rateLimit' | 'failed' | 'changed' | 'tooManyFiles';
export class PullRequestError extends Error {
    constructor(readonly code: ErrorCode) {super(code);}
}

const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const validRepository = (value: unknown): value is string => typeof value === 'string' &&
    repositoryName.test(value) && value.split('/').every(segment => segment !== '.' && segment !== '..');
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);

export function gitHubRepositoryFromOrigin(origin: string | undefined) {
    const name = origin?.trim().match(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/?#]+\/[^/?#]+)\/?$/i)?.[1];
    const repository = name?.replace(/\.git$/i, '');
    return validRepository(repository) ? repository : null;
}

function repoPath(repository: string) {
    return '/repos/' + repository.split('/').map(encodeURIComponent).join('/');
}
const invalidResponse = () => new PullRequestError('failed');
const emptyProject = '{"targets":[]}\n';
const sourceLimit = 1024 * 1024;

async function readBody(response: Response, limit: number, chunk: (value: Uint8Array) => void) {
    if (Number(response.headers.get('Content-Length')) > limit || !response.body) throw invalidResponse();
    const reader = response.body.getReader();
    let length = 0;
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) return;
            length += value.byteLength;
            if (length > limit) throw invalidResponse();
            chunk(value);
        }
    } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
    }
}

async function readText(response: Response, limit: number) {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    const chunks: string[] = [];
    await readBody(response, limit, value => chunks.push(decoder.decode(value, {stream: true})));
    return chunks.join('') + decoder.decode();
}

function readSummary(value: unknown) {
    if (!isRecord(value) || !Number.isSafeInteger(value.number) || Number(value.number) < 1 ||
        typeof value.title !== 'string') throw invalidResponse();
    return {number: Number(value.number), title: value.title};
}

function readRevision(value: unknown) {
    if (!isRecord(value) || !isSha(value.sha) || typeof value.ref !== 'string') throw invalidResponse();
    const repository = isRecord(value.repo) ? value.repo.full_name : null;
    if (repository !== null && !validRepository(repository)) throw invalidResponse();
    return {sha: value.sha, ref: value.ref, repository};
}

function readPullRequest(value: unknown) {
    const summary = readSummary(value);
    if (!isRecord(value) || (value.state !== 'open' && value.state !== 'closed') ||
        !Number.isSafeInteger(value.changed_files) || Number(value.changed_files) < 0) throw invalidResponse();
    const author = isRecord(value.user) && typeof value.user.login === 'string' ? value.user.login : undefined;
    const description = typeof value.body_text === 'string' ? value.body_text : typeof value.body === 'string' ? value.body : '';
    const state: 'open' | 'closed' | 'merged' | 'draft' = value.merged_at ? 'merged' : value.draft ? 'draft' : value.state;
    return {...summary, author, description, base: readRevision(value.base), head: readRevision(value.head), state,
        changedFiles: Number(value.changed_files)};
}

function readFile(value: unknown) {
    if (!isRecord(value) || typeof value.filename !== 'string' || typeof value.status !== 'string') throw invalidResponse();
    return {path: value.filename, previous: typeof value.previous_filename === 'string' ? value.previous_filename : undefined,
        status: value.status};
}

function contentPath(path: string) {
    const parts = path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) throw invalidResponse();
    return parts.map(encodeURIComponent).join('/');
}

/** One version of a project file on GitHub: the repository and commit, and the project file's path. */
interface ProjectLocation {repository: string; sha: string; path: string}

/**
 * Reads the assets of both versions of a project file from raw.githubusercontent.com, which does not count against the
 * API rate limit. Each version's sb3-source.json names its assets directory. Every read is capped, honors both its own
 * signal and the pull request's, and resolves `null` on any failure.
 */
function rawAssetLoader(versions: Record<ProjectVersion, ProjectLocation | null>, send: typeof fetch, review: AbortSignal): ProjectAssetLoader {
    const directories = new Map<ProjectVersion, Promise<string[] | null>>();
    const get = (url: string, signal: AbortSignal) => send(url, {credentials: 'omit', redirect: 'error', signal});
    const folderUrl = ({repository, sha, path}: ProjectLocation) => 'https://raw.githubusercontent.com/' +
        repository.split('/').map(encodeURIComponent).join('/') + '/' + sha + '/' +
        contentPath(path).split('/').slice(0, -1).map(part => part + '/').join('');
    const readDirectory = async (folder: string, signal: AbortSignal) => {
        let settings: string | null = null;
        try {
            const response = await get(folder + 'sb3-source.json', signal);
            if (response.ok) settings = await readText(response, folderSettingsLimit);
            else void response.body?.cancel().catch(() => {});
        } catch (error) {
            // A missing or unreadable file falls back to `assets`; a cancelled read is retried by the next request.
            if (signal.aborted) throw error;
        }
        return assetsDirectoryParts(settings);
    };
    return async ({version, md5ext, signal: own}) => {
        const location = versions[version];
        if (!location || !isAssetName(md5ext)) return null;
        try {
            const signal = AbortSignal.any([own, review]);
            if (signal.aborted) return null;
            const folder = folderUrl(location);
            let directory = directories.get(version);
            if (!directory) {
                directory = readDirectory(folder, signal);
                directories.set(version, directory);
                const pending = directory;
                pending.catch(() => {if (directories.get(version) === pending) directories.delete(version);});
            }
            const parts = await directory;
            if (!parts || signal.aborted) return null;
            const response = await get(folder + parts.map(encodeURIComponent).join('/') + '/' + md5ext, signal);
            if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                return null;
            }
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            await readBody(response, assetLimit, value => chunks.push(value as Uint8Array<ArrayBuffer>));
            return signal.aborted ? null : new Blob(chunks);
        } catch {
            return null;
        }
    };
}

export function createGitHubPullRequests(repository: string, send: typeof fetch = fetch) {
    if (!validRepository(repository)) throw invalidResponse();
    const api = 'https://api.github.com';
    const repo = repoPath(repository);
    const request = async (path: string, signal: AbortSignal, accept = 'application/vnd.github+json') => {
        const response = await send(api + path, {headers: {Accept: accept}, credentials: 'omit', redirect: 'error', signal});
        if (!response.ok) {
            if (response.status === 429 || (response.status === 403 && (response.headers.get('X-RateLimit-Remaining') === '0' ||
                response.headers.has('Retry-After')))) throw new PullRequestError('rateLimit');
            if (response.status === 404 || response.status === 403) throw new PullRequestError('unavailable');
            throw invalidResponse();
        }
        return response;
    };
    const json = async (path: string, signal: AbortSignal, accept?: string): Promise<unknown> =>
        JSON.parse(await readText(await request(path, signal, accept), 12 * sourceLimit));
    const metadata = async (number: number, signal: AbortSignal) => readPullRequest(await json(
        repo + '/pulls/' + number, signal, 'application/vnd.github.text+json'));
    const source = async (name: string, path: string, revision: string, signal: AbortSignal) => readText(
        await request(repoPath(name) + '/contents/' + contentPath(path) + '?ref=' + revision, signal, 'application/vnd.github.raw+json'), sourceLimit);

    return {
        /** File versions actually integrated by a merged PR associated with one of the known commits. */
        async mergedFileVersions(sha: string, scope: string, signal: AbortSignal): Promise<MergedFileVersions> {
            if (!isSha(sha)) throw invalidResponse();
            const associated = await json(repo + '/commits/' + sha + '/pulls?per_page=10', signal);
            if (!Array.isArray(associated)) throw invalidResponse();
            const pulls = new Map<number, string>();
            for (const value of associated) {
                if (!isRecord(value) || typeof value.merged_at !== 'string' || !isSha(value.merge_commit_sha)) continue;
                const {number} = readSummary(value);
                const base = readRevision(value.base);
                if (base.repository?.toLowerCase() === repository.toLowerCase()) pulls.set(number, value.merge_commit_sha);
            }
            const versions = new Map<string, FileVersion[]>();
            for (const [number, merge] of pulls) {
                const commit = await json(repo + '/git/commits/' + merge, signal);
                const tree = isRecord(commit) ? commit.tree : null;
                if (!isRecord(tree) || !isSha(tree.sha)) throw invalidResponse();
                const result = await json(repo + '/git/trees/' + tree.sha + '?recursive=1', signal);
                if (!isRecord(result) || result.truncated !== false || !Array.isArray(result.tree)) continue;
                const entries = new Map<string, FileVersion>();
                for (const entry of result.tree) {
                    if (!isRecord(entry) || entry.type !== 'blob' || typeof entry.path !== 'string' || !isSha(entry.sha) ||
                        (entry.mode !== '100644' && entry.mode !== '100755') ||
                        (scope && !entry.path.startsWith(scope + '/'))) continue;
                    entries.set(entry.path, {oid: entry.sha, mode: parseInt(entry.mode, 8)});
                }
                for (let page = 1; page <= 30; page++) {
                    const files = await json(repo + '/pulls/' + number + '/files?per_page=100&page=' + page, signal);
                    if (!Array.isArray(files)) throw invalidResponse();
                    for (const file of files) {
                        if (!isRecord(file) || typeof file.filename !== 'string' || file.status === 'removed') continue;
                        const version = entries.get(file.filename);
                        // A merge may resolve a file differently from the PR. In that case its head version did not land.
                        if (!version || version.oid !== file.sha) continue;
                        const previous = versions.get(file.filename);
                        if (previous) previous.push(version);
                        else versions.set(file.filename, [version]);
                    }
                    if (files.length < 100) break;
                }
            }
            return versions;
        },
        /** Reads one pull request's title, description, state and both revisions, without its files (one request). */
        async metadata(number: number, signal: AbortSignal) {
            if (!Number.isSafeInteger(number) || number < 1) throw invalidResponse();
            const pr = await metadata(number, signal);
            if (pr.number !== number) throw invalidResponse();
            return {...pr, url: 'https://github.com/' + repository + '/pull/' + number};
        },
        async list(page: number, signal: AbortSignal) {
            const result = await json(repo + '/pulls?state=all&sort=updated&per_page=20&page=' + page, signal);
            if (!Array.isArray(result)) throw invalidResponse();
            return {items: result.map(readSummary), more: result.length === 20};
        },
        async load(number: number, signal: AbortSignal) {
            if (!Number.isSafeInteger(number) || number < 1) throw invalidResponse();
            const pr = await metadata(number, signal);
            if (pr.number !== number) throw invalidResponse();
            if (pr.changedFiles > 3000) throw new PullRequestError('tooManyFiles');
            const records: ReturnType<typeof readFile>[] = [];
            for (let page = 1; page <= Math.ceil(pr.changedFiles / 100); page++) {
                const result = await json(repo + '/pulls/' + number + '/files?per_page=100&page=' + page, signal);
                if (!Array.isArray(result)) throw invalidResponse();
                records.push(...result.map(readFile));
            }
            const current = await metadata(number, signal);
            if (current.base.sha !== pr.base.sha || current.head.sha !== pr.head.sha ||
                current.changedFiles !== pr.changedFiles || records.length !== pr.changedFiles) {
                throw new PullRequestError('changed');
            }
            let base: string | undefined;
            if (records.some(file => file.path.split('/').pop() === 'project.source.json' && file.status !== 'added' && file.status !== 'copied')) {
                try {
                    const comparison = await json(repo + '/compare/' + pr.base.sha + '...' + pr.head.sha + '?per_page=1', signal);
                    const merge = isRecord(comparison) ? comparison.merge_base_commit : null;
                    if (isRecord(merge) && isSha(merge.sha)) base = merge.sha;
                } catch (error) {
                    if (signal.aborted) throw error;
                }
            }

            const files: ProjectSourceReviewFile[] = [];
            for (const file of records) {
                const status = file.status === 'removed' ? 'removed' : file.status === 'added' || file.status === 'copied' ? 'added' : 'updated';
                const related = {path: file.path, status, previousPath: file.previous} as const;
                if (file.path.split('/').pop() !== 'project.source.json') {
                    files.push(related);
                    continue;
                }
                try {
                    if (status !== 'added' && !base) throw invalidResponse();
                    const [before, after] = await Promise.all([
                        status === 'added' ? emptyProject : source(repository, file.previous ?? file.path, base!, signal),
                        status === 'removed' ? emptyProject : source(pr.head.repository ?? repository, file.path, pr.head.sha, signal)
                    ]);
                    const loadAsset = rawAssetLoader({
                        before: status === 'added' ? null : {repository, sha: base!, path: file.previous ?? file.path},
                        after: status === 'removed' ? null : {repository: pr.head.repository ?? repository, sha: pr.head.sha, path: file.path}
                    }, send, signal);
                    files.push({path: file.path, previousPath: file.previous, patch: createProjectSourceDiff(before, after), loadAsset});
                } catch (error) {
                    if (signal.aborted) throw error;
                    files.push({...related, unavailable: true});
                }
            }
            return {...pr, files, url: 'https://github.com/' + repository + '/pull/' + number};
        }
    };
}

export type GitHubPullRequests = ReturnType<typeof createGitHubPullRequests>;
