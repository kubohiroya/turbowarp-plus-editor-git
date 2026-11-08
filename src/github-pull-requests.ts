import {createProjectSourceDiff, isRecord} from './project-source-patch.js';
import type {ProjectSourceReviewFile} from './project-source-review.js';

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

async function readText(response: Response, limit: number) {
    if (Number(response.headers.get('Content-Length')) > limit || !response.body) throw invalidResponse();
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    const chunks: string[] = [];
    let length = 0;
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) return chunks.join('') + decoder.decode();
            length += value.byteLength;
            if (length > limit) throw invalidResponse();
            chunks.push(decoder.decode(value, {stream: true}));
        }
    } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
    }
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
                    files.push({path: file.path, previousPath: file.previous, patch: createProjectSourceDiff(before, after)});
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
