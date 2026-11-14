import * as git from 'isomorphic-git';
import {createTwoFilesPatch} from 'diff';
import {createReadOnlyFs, errorCode, GitPanelError, pathParts, readOptional, sameBytes} from './filesystem.js';
import {runPullRequestFetch, runRemoteOperation} from './remote-operations.js';
import {createProjectSourceDiff} from './project-source-patch.js';
import type {ProjectSourceReviewFile} from './project-source-review.js';
import {runLocalOperation} from './local-operations.js';
import type {LocalOperation} from './local-operations.js';
import type {GetRemoteSession, RemoteOperation} from './remote-operations.js';
import {assetLimit, assetsDirectoryParts, folderSettingsLimit, isAssetName} from './project-asset-paths.js';
import type {ProjectAssetLoader, ProjectVersion} from './project-assets.js';
import type {FileVersion} from './change-marks.js';
import {planProjectRestore, projectScope, projectVersionFile} from './project-version.js';

export {createReadOnlyFs, GitPanelError} from './filesystem.js';
export {pullRequestRef} from './remote-operations.js';
export type {PullRequestFetch} from './remote-operations.js';
export type ChangeGroup = 'staged' | 'unstaged' | 'untracked' | 'commit';
export interface FileChange {
    path: string;
    group: ChangeGroup;
    before: string | null;
    after: string | null;
    worktree: boolean;
    /** Compare the saved file with HEAD even when the index has a different version. */
    fromHead?: boolean;
    oldMode: number | null;
    newMode: number | null;
    /** For `commit` changes, the commit compared with its first parent. */
    commit?: string;
}
/** A version of the pull request's base to compare with: GitHub's base commit when known, else a branch on origin. */
export interface PullRequestBase {
    /** The base commit GitHub reported, used when the fetch brought it. */
    sha?: string;
    /** The base branch, read from `refs/remotes/origin/<branch>` when `sha` is missing or not local. */
    branch?: string;
}
export interface PullRequestFiles {
    /** The base that was compared: the branch it was named by, if any, and its commit. */
    base: {ref: string | null; sha: string};
    head: string;
    /** The merge base of `base.sha` and `head`, like GitHub's three-dot comparison; `null` for unrelated histories. */
    mergeBase: string | null;
    /** Every changed path from the merge base to the head, with project data as a project-source diff. */
    files: ProjectSourceReviewFile[];
}
export interface Commit {
    oid: string;
    message: string;
    author: string;
    timestamp: number;
}
type Entry = FileVersion;
/** Where one version of a file is read from: a commit or tree, the index, or the working tree. */
type Source = {kind: 'tree'; ref: string} | {kind: 'index'} | {kind: 'worktree'};
/**
 * Two versions of a project folder as a person sees them: the last commit and the working tree, so changes split
 * across the index and the working tree read as one; or one commit and its first parent.
 */
export type ProjectComparison = {kind: 'worktree'} | {kind: 'commit'; commit: string};
/** A ref drawn next to a commit in the history: a local branch, `origin/<name>`, or HEAD when it is detached. */
export interface HistoryRef {
    kind: 'branch' | 'remote' | 'head';
    /** The branch name; `origin/<name>` for remote branches; `HEAD` for a detached HEAD. */
    name: string;
    /** The branch HEAD is on, or the detached HEAD. */
    current: boolean;
}
export interface HistoryCommit {
    oid: string;
    parents: string[];
    /** The first line of the message. */
    message: string;
    author: string;
    /** Author time in seconds. */
    timestamp: number;
    refs: HistoryRef[];
}
/** Where `history` continues. It only works with the repository that returned it. */
export type HistoryCursor = {readonly continues: 'history'};
export interface HistoryPage {
    commits: HistoryCommit[];
    /** Pass as `after` to read the next page; `null` when every commit has been read. */
    cursor: HistoryCursor | null;
}
/** Commits read per history page unless asked otherwise. */
export const historyPageSize = 50;
const projectSourceLimit = 16 * 1024 * 1024;
type Metadata = Map<string, Uint8Array | null>;
/** The branch fields of a snapshot. */
export type BranchRefs = Pick<Snapshot, 'branch' | 'head' | 'branches' | 'remoteBranches'>;
export type HeadFile = Pick<BranchRefs, 'branch' | 'head'> & {bytes: Uint8Array | null};
export interface Snapshot {
    branch: string | undefined;
    head: string | null;
    branches: string[];
    /** Branches fetched from `origin` that have no local branch of the same name yet. */
    remoteBranches: string[];
    commits: Commit[];
    changes: FileChange[];
    trackedPaths: string[];
    headChanges: FileChange[];
    scope: string;
    metadata: Metadata;
    /** Size and time fingerprint taken before the read. Compare it with `probe(scope)` to see later changes. */
    probe: string;
    /**
     * How the current branch stands against `refs/remotes/origin/<branch>` as of the last fetch, from local refs only.
     * `unknown` when there is no current branch or no tracking ref yet.
     */
    upstream: UpstreamRelation;
}
export interface UpstreamRelation {
    state: 'same' | 'ahead' | 'behind' | 'diverged' | 'unknown';
    /**
     * Commits on the local branch that the tracking branch lacks, and the reverse. Zero when unknown. Counting reads at
     * most `upstreamWalkLimit` (1000) commits; past that, a side that has commits of its own reports exactly that limit,
     * meaning "this many or more". The state itself comes from the merge base and stays exact.
     */
    ahead: number;
    behind: number;
}
export interface FileDiff {
    binary: boolean;
    patch: string;
    /**
     * Both versions as text, for views that read the content instead of the patch. A missing version is empty.
     * Absent for binary content and above the text limit, except for project.source.json up to 16 MiB.
     */
    text?: {before: string; after: string};
    beforeSize: number;
    afterSize: number;
    tooLarge: boolean;
}
const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
const validBranch = (name: string) => /^[^\s~^:?*[\\]+$/u.test(name) && !name.startsWith('/') && !name.endsWith('/') &&
    !name.endsWith('.lock') && !name.includes('..') && !name.includes('//') && !name.includes('@{');
const textLimit = 1024 * 1024;
const inScope = (path: string, scope: string) => !scope || path === scope || path.startsWith(scope + '/');
// Above this many work-tree files, probes only watch Git metadata. Edits then need a manual refresh.
const probeLimit = 5000;
/** Most commits read to count how far a branch is ahead of or behind its tracking branch. */
export const upstreamWalkLimit = 1000;
const trackingRef = (branchRef: string) => 'refs/remotes/origin/' + branchRef.slice('refs/heads/'.length);
const sameMetadata = (a: Metadata, b: Metadata) => a.size === b.size && [...a].every(([path, bytes]) => sameBytes(bytes, b.get(path) ?? null));

export async function openRepository(root: FileSystemDirectoryHandle) {
    // Linked worktrees and submodules may point outside the granted directory.
    try {await root.getDirectoryHandle('.git');} catch (error) {
        if (['NotFoundError', 'TypeMismatchError'].includes((error as DOMException).name)) throw new GitPanelError('invalid');
        throw error;
    }
    const fs = createReadOnlyFs(root);
    let tail = Promise.resolve();
    const serial = <T>(operation: () => Promise<T>) => {
        const result = tail.then(operation);
        tail = result.then(() => {}, () => {});
        return result;
    };
    const options = {fs, dir: '/', gitdir: '/.git'};
    let cache = {};
    let pushNeedsFetch = false;
    const statusTrackingRef = async (branch: string, reader = fs) => {
        const remote = await git.getConfig({...options, fs: reader, path: 'branch.' + branch + '.remote'});
        if (remote && remote !== 'origin') return undefined;
        const merge = await git.getConfig({...options, fs: reader, path: 'branch.' + branch + '.merge'});
        if (!merge) return trackingRef('refs/heads/' + branch);
        if (merge.startsWith('refs/heads/') && validBranch(merge.slice('refs/heads/'.length))) return trackingRef(merge);
    };
    const metadata = async (includeConfiguredTracking = false): Promise<Metadata> => {
        const head = await readOptional(fs, '/.git/HEAD');
        if (!head) throw new GitPanelError('invalid');
        const text = new TextDecoder().decode(head).trim();
        const paths = ['/.git/HEAD', '/.git/index', '/.git/packed-refs', '/.git/shallow', '/.git/config'];
        if (text.startsWith('ref: refs/heads/')) {
            const ref = text.slice(5);
            pathParts(ref);
            paths.push('/.git/' + ref, '/.git/' + trackingRef(ref));
            const tracking = includeConfiguredTracking && await statusTrackingRef(ref.slice('refs/heads/'.length));
            if (tracking && tracking !== trackingRef(ref)) paths.push('/.git/' + tracking);
        } else if (!/^[0-9a-f]{40}$/.test(text)) throw new GitPanelError('invalid');
        const result: Metadata = new Map();
        for (const path of paths) {
            if (await readOptional(fs, path + '.lock')) throw new GitPanelError('changed');
            result.set(path, await readOptional(fs, path));
        }
        return result;
    };
    await metadata();

    const fileAt = async (parts: string[]) => {
        let directory = root;
        for (const name of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(name);
        return (await directory.getFileHandle(parts[parts.length - 1])).getFile();
    };
    const optionalFile = async (path: string) => {
        try {return await fileAt(pathParts(path));} catch (error) {
            if (['NotFoundError', 'TypeMismatchError'].includes((error as DOMException).name)) return null;
            throw error;
        }
    };
    const stamp = (file: File | null) => file ? `${file.size}:${file.lastModified}` : '-';
    /**
     * Fingerprints Git metadata and the work tree in `scope` from sizes and modification times, without
     * reading file contents other than HEAD and, when following the configured tracking ref, config.
     * Returns 'locked' while Git holds a lock on that metadata.
     */
    const probe = async (scope = '', includeConfiguredTracking = false): Promise<string> => {
        const parts = pathParts(scope);
        const headFile = await optionalFile('.git/HEAD');
        if (!headFile) return 'locked';
        const head = (await headFile.text()).trim();
        const paths = ['.git/HEAD', '.git/index', '.git/packed-refs', '.git/shallow', '.git/config'];
        if (head.startsWith('ref: refs/heads/')) {
            try {pathParts(head.slice(5));} catch {return 'locked';}
            const ref = head.slice(5);
            paths.push('.git/' + ref, '.git/' + trackingRef(ref));
            const tracking = includeConfiguredTracking &&
                await statusTrackingRef(ref.slice('refs/heads/'.length), createReadOnlyFs(root));
            if (tracking && tracking !== trackingRef(ref)) paths.push('.git/' + tracking);
        }
        const lines: string[] = [];
        for (const path of paths) {
            if (await optionalFile(path + '.lock')) return 'locked';
            lines.push(`${path} ${stamp(await optionalFile(path))}`);
        }
        let start: FileSystemDirectoryHandle | null = root;
        try {for (const name of parts) start = await start.getDirectoryHandle(name);} catch {start = null;}
        const files: string[] = [];
        const visit = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<boolean> => {
            const entries = (directory as FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>}).values();
            for await (const entry of entries) {
                const path = prefix + entry.name;
                if (path === '.git') continue;
                if (entry.kind === 'directory') {
                    if (!await visit(entry as FileSystemDirectoryHandle, path + '/')) return false;
                } else {
                    files.push(`${path} ${stamp(await (entry as FileSystemFileHandle).getFile())}`);
                    if (files.length > probeLimit) return false;
                }
            }
            return true;
        };
        const prefix = parts.length ? parts.join('/') + '/' : '';
        const complete = start ? await visit(start, prefix) : true;
        if (complete) lines.push(...files.sort());
        else lines.push('work tree not watched');
        return lines.join('\n');
    };

    const entries = async (ref: string | null, scope: string,
        include: (path: string) => boolean = () => true): Promise<Map<string, Entry>> => {
        const tree = ref === null ? git.STAGE() : git.TREE({ref});
        const result = await git.walk({
            ...options, cache, trees: [tree],
            map: async (path, [entry]) => {
                if (path !== '.' && !inScope(path, scope) && !scope.startsWith(path + '/')) return null;
                if (!entry || await entry.type() === 'tree' || !include(path)) return;
                const mode = await entry.mode();
                if (mode === 0o160000 || mode === 0o120000) throw new GitPanelError('unsupported');
                return {path, oid: await entry.oid(), mode};
            }
        }) as {path: string; oid: string; mode: number}[];
        return new Map(result.map(({path, oid, mode}) => [path, {oid, mode}]));
    };
    /**
     * Compares `refs/heads/<branch>` with `refs/remotes/origin/<branch>` from local refs only. Counts by painting
     * commits from both tips in committer-time order until every queued commit is reachable from both, like
     * `git rev-list --left-right --count`, reading at most `upstreamWalkLimit` commits.
     */
    const upstreamRelation = async (branch: string | undefined, head: string | null): Promise<UpstreamRelation> => {
        const unknown: UpstreamRelation = {state: 'unknown', ahead: 0, behind: 0};
        if (!branch || !head) return unknown;
        pathParts(trackingRef('refs/heads/' + branch));
        try {
            const remote = await git.resolveRef({...options, ref: trackingRef('refs/heads/' + branch)});
            if (remote === head) return {state: 'same', ahead: 0, behind: 0};
            const bases = await git.findMergeBase({...options, cache, oids: [head, remote]}) as string[];
            const hasAhead = !bases.includes(head), hasBehind = !bases.includes(remote);
            const local = 1, tracking = 2, both = 3;
            const flags = new Map<string, number>([[head, local], [remote, tracking]]);
            const time = async (oid: string) => (await git.readCommit({...options, cache, oid})).commit;
            const queue: {oid: string; time: number; parents: string[]}[] = [];
            const enqueue = async (oid: string) => {
                const commit = await time(oid);
                queue.push({oid, time: commit.committer.timestamp, parents: commit.parent});
            };
            await enqueue(head); await enqueue(remote);
            let read = 2;
            let complete = true;
            while (queue.some(item => flags.get(item.oid) !== both)) {
                if (read >= upstreamWalkLimit) {complete = false; break;}
                queue.sort((a, b) => b.time - a.time);
                const item = queue.shift()!;
                const flag = flags.get(item.oid)!;
                for (const parent of item.parents) {
                    const previous = flags.get(parent) ?? 0;
                    if ((previous | flag) === previous) continue;
                    flags.set(parent, previous | flag);
                    if (!queue.some(entry => entry.oid === parent)) {await enqueue(parent); read++;}
                }
            }
            let ahead = 0, behind = 0;
            for (const flag of flags.values()) {
                if (flag === local) ahead++;
                else if (flag === tracking) behind++;
            }
            if (!complete) {
                ahead = hasAhead ? upstreamWalkLimit : 0;
                behind = hasBehind ? upstreamWalkLimit : 0;
            }
            return {state: hasAhead && hasBehind ? 'diverged' : hasAhead ? 'ahead' : hasBehind ? 'behind' : 'same',
                ahead: hasAhead ? Math.max(ahead, 1) : 0, behind: hasBehind ? Math.max(behind, 1) : 0};
        } catch (error) {
            // No tracking ref yet, or history missing from a shallow clone.
            if (errorCode(error) === 'NotFoundError') return unknown;
            throw error;
        }
    };
    const assertSnapshot = async (snapshot: Snapshot) => {
        if (!sameMetadata(snapshot.metadata, await metadata())) throw new GitPanelError('changed');
    };
    const readHead = async (): Promise<Pick<BranchRefs, 'branch' | 'head'>> => {
        let head: string | null;
        try {head = await git.resolveRef({...options, ref: 'HEAD'});} catch (error) {
            if (errorCode(error) !== 'NotFoundError') throw error;
            head = null;
        }
        const branch = await git.currentBranch(options);
        return {branch: branch || undefined, head};
    };
    const readRefs = async (): Promise<BranchRefs> => {
        const {branch, head} = await readHead();
        const branches = await git.listBranches(options);
        const remoteBranches = (await git.listBranches({...options, remote: 'origin'}))
            .filter(name => name !== 'HEAD' && !branches.includes(name)).sort();
        return {branch, head, branches, remoteBranches};
    };
    const readHeadFile = async (path: string, limit: number): Promise<HeadFile> => {
        const parts = pathParts(path);
        const name = parts.pop();
        if (!name || [name, ...parts].includes('.git')) throw new GitPanelError('unsupported');
        fs.clearReads();
        const {head, branch} = await readHead();
        let bytes: Uint8Array | null = null;
        if (head) {
            let oid = head;
            for (const part of parts) {
                const {tree} = await git.readTree({...options, cache, oid});
                const entry = tree.find(item => item.path === part);
                oid = entry?.type === 'tree' ? entry.oid : '';
                if (!oid) break;
            }
            if (oid) {
                const {tree} = await git.readTree({...options, cache, oid});
                const entry = tree.find(item => item.path === name);
                if (entry && entry.type !== 'tree') {
                    if (entry.mode !== '100644' && entry.mode !== '100755') throw new GitPanelError('unsupported');
                    bytes = (await git.readBlob({...options, cache, oid: entry.oid})).blob;
                    if (bytes.byteLength > limit) throw new GitPanelError('large');
                }
            }
        }
        fs.clearReads();
        const current = await readHead();
        if (current.head !== head || current.branch !== branch) throw new GitPanelError('changed');
        return {head, branch, bytes};
    };
    const readRestorePlan = async (oid: string, folder: string) => {
        fs.clearReads();
        const before = await readHead();
        const plan = await planProjectRestore({...options, cache}, oid, folder);
        const after = await readHead();
        if (before.head !== plan.head || before.branch !== plan.branch ||
            after.head !== plan.head || after.branch !== plan.branch) throw new GitPanelError('changed');
        await fs.checkReads();
        return plan;
    };
    const readProjectVersion = async (oid: string, folder: string) => {
        const scope = projectScope(folder);
        if (!isSha(oid)) throw new GitPanelError('invalid');
        fs.clearReads();
        await git.readCommit({...options, cache, oid});
        const prefix = scope ? scope + '/' : '';
        const tracked = await entries(oid, scope, path => path.startsWith(prefix) &&
            projectVersionFile(path.slice(prefix.length)));
        if (!tracked.has(prefix + 'project.source.json')) throw new GitPanelError('versionMissing');
        const files = new Map<string, Uint8Array<ArrayBuffer>>();
        let total = 0;
        for (const [path, entry] of tracked) {
            const relative = path.slice(prefix.length);
            const {blob} = await git.readBlob({...options, cache, oid: entry.oid});
            total += blob.byteLength;
            if (total > 100 * 1024 * 1024 || files.size >= 20_000) throw new GitPanelError('large');
            files.set(relative, Uint8Array.from(blob));
        }
        await fs.checkReads();
        return files;
    };
    const read = async (scope = '', filepaths?: string[]): Promise<Snapshot> => {
        scope = pathParts(scope).join('/');
        fs.clearReads();
        cache = {};
        // Taken first, so a change during the read differs from the stored value and triggers another read.
        const fingerprint = await probe(scope);
        const before = await metadata();
        const {branch, head, branches, remoteBranches} = await readRefs();
        const commits = head ? (await git.log({...options, cache, ref: head, depth: 50})).map(({oid, commit}) => ({
            oid, message: commit.message, author: commit.author.name, timestamp: commit.author.timestamp
        })) : [];
        const upstream = await upstreamRelation(branch || undefined, head);
        const {changes, committed} = await readChanges(scope, head, filepaths);
        const headChanges = head ? await commitChanges(head, scope, committed) : [];
        if (!sameMetadata(before, await metadata())) throw new GitPanelError('changed');
        await fs.checkReads();
        return {branch, head, branches, remoteBranches, commits, changes, trackedPaths: [...committed.keys()], headChanges,
            scope, metadata: before, probe: fingerprint,
            upstream};
    };
    const readChanges = async (scope: string, head: string | null, filepaths?: string[]) => {
        const matrix = await git.statusMatrix({...options, cache, refresh: false,
            filepaths: filepaths ?? [scope || '.'], ignored: Boolean(filepaths)});
        const staged = await entries(null, scope);
        const committed = await entries(head || emptyTree, scope);
        const changes: FileChange[] = [];
        for (const [path, headState, workState, stageState] of matrix) {
            const previous = committed.get(path);
            const next = staged.get(path);
            if (headState !== stageState || previous?.mode !== next?.mode) {
                changes.push({path, group: 'staged', before: previous?.oid ?? null, after: next?.oid ?? null,
                    worktree: false, oldMode: previous?.mode ?? null, newMode: next?.mode ?? null});
            }
            if (workState !== stageState) {
                const bytes = workState ? await fs.promises.readFile('/' + path) as Uint8Array : null;
                const oid = bytes ? (await git.hashBlob({object: bytes})).oid : null;
                changes.push({path, group: !next && bytes ? 'untracked' : 'unstaged',
                    before: next?.oid ?? null, after: oid, worktree: true,
                    oldMode: next?.mode ?? null, newMode: bytes ? (next?.mode ?? 0o100644) : null});
            }
        }
        return {changes, committed};
    };
    const readFileStatus = async (scope: string, fingerprint: string, includeUpstream: boolean) => {
        fs.clearReads();
        cache = {};
        const before = await metadata(true);
        const {branch, head} = await readHead();
        const {changes, committed} = await readChanges(scope, head);
        const remote = includeUpstream ? await git.getConfig({...options, path: 'remote.origin.url'}) : undefined;
        let upstream = new Map<string, Entry>();
        let pushed: string | undefined;
        let upstreamBranch: string | undefined;
        if (remote && branch && !pushNeedsFetch) {
            const tracking = await statusTrackingRef(branch);
            if (tracking) {
                try {
                    const oid = await git.resolveRef({...options, ref: tracking});
                    upstream = oid === head ? committed : await entries(oid, scope);
                    pushed = oid;
                    upstreamBranch = tracking.slice('refs/remotes/origin/'.length);
                } catch {
                    // The tracking ref or some of its objects are not available locally.
                }
            }
        }
        if (!sameMetadata(before, await metadata(true))) throw new GitPanelError('changed');
        await fs.checkReads();
        if (fingerprint !== await probe(scope, true)) throw new GitPanelError('changed');
        return {changes, committed, upstream, branch, upstreamBranch, pushed, remote};
    };
    interface HistoryNode {commit: HistoryCommit; time: number; children: number; expanded: boolean}
    interface HistoryWalk {nodes: Map<string, HistoryNode>; pending: Set<HistoryNode>; frontier: Set<HistoryNode>}
    const walks = new WeakMap<HistoryCursor, HistoryWalk>();
    /**
     * Reads commits reachable from the local branches, `origin/*` and HEAD, newest committer time first, like
     * `git log --all --date-order` limited to those refs. A commit is listed only after every child read so far, and
     * only once no commit still to be read is newer, keeping a page's worth read ahead, so a child stays above its
     * parents unless committer times run backwards by more than that.
     */
    const history = async ({limit = historyPageSize, after}: {limit?: number; after?: HistoryCursor | null} = {}): Promise<HistoryPage> => {
        fs.clearReads();
        if (!(limit >= 1)) limit = historyPageSize;
        let walk = after ? walks.get(after) : undefined;
        // Each cursor continues once; the walk it names moves on.
        if (after && !walk) throw new GitPanelError('changed');
        if (after) walks.delete(after);
        const readNode = async (oid: string): Promise<HistoryNode | null> => {
            try {
                const {commit} = await git.readCommit({...options, cache, oid});
                return {commit: {oid, parents: commit.parent, message: commit.message.split('\n')[0], author: commit.author.name,
                    timestamp: commit.author.timestamp, refs: []}, time: commit.committer.timestamp, children: 0, expanded: false};
            } catch (error) {
                // A shallow clone stops before the parents it does not have.
                if (errorCode(error) === 'NotFoundError') return null;
                throw error;
            }
        };
        if (!walk) {
            walk = {nodes: new Map(), pending: new Set(), frontier: new Set()};
            const tips: {ref: string; label: HistoryRef}[] = [];
            const branch = await git.currentBranch(options);
            for (const name of (await git.listBranches(options)).sort()) {
                tips.push({ref: `refs/heads/${name}`, label: {kind: 'branch', name, current: name === branch}});
            }
            for (const name of (await git.listBranches({...options, remote: 'origin'})).sort()) {
                if (name !== 'HEAD') tips.push({ref: `refs/remotes/origin/${name}`, label: {kind: 'remote', name: `origin/${name}`, current: false}});
            }
            if (!branch) tips.push({ref: 'HEAD', label: {kind: 'head', name: 'HEAD', current: true}});
            for (const {ref, label} of tips) {
                let oid: string;
                try {oid = await git.resolveRef({...options, ref});} catch (error) {
                    if (errorCode(error) === 'NotFoundError') continue;
                    throw error;
                }
                let node = walk.nodes.get(oid);
                if (!node) {
                    const read = await readNode(oid);
                    if (!read) continue;
                    node = read;
                    walk.nodes.set(oid, node);
                    walk.pending.add(node);
                    walk.frontier.add(node);
                }
                node.commit.refs.push(label);
            }
        }
        const {nodes, pending, frontier} = walk;
        const expand = async (node: HistoryNode) => {
            frontier.delete(node);
            node.expanded = true;
            for (const parent of new Set(node.commit.parents)) {
                let next = nodes.get(parent);
                if (!next) {
                    const read = await readNode(parent);
                    if (!read) continue;
                    next = read;
                    nodes.set(parent, next);
                    pending.add(next);
                    frontier.add(next);
                }
                if (pending.has(node) && pending.has(next)) next.children++;
            }
        };
        const newer = (a: HistoryNode, b: HistoryNode) => a.time !== b.time ? a.time > b.time : a.commit.oid > b.commit.oid;
        const pick = (items: Iterable<HistoryNode>, accept: (node: HistoryNode) => boolean) => {
            let best: HistoryNode | null = null;
            for (const node of items) if (accept(node) && (!best || newer(node, best))) best = node;
            return best;
        };
        const commits: HistoryCommit[] = [];
        while (commits.length < limit) {
            let ready = pick(pending, node => node.children === 0);
            let latest = pick(frontier, () => true);
            // Read on while something unread may be newer than the next commit, keeping a page read ahead.
            while (latest && (!ready || !ready.expanded || latest.time >= ready.time || pending.size < limit * 2)) {
                await expand(latest);
                ready = pick(pending, node => node.children === 0);
                latest = pick(frontier, () => true);
            }
            if (!ready) break;
            pending.delete(ready);
            for (const parent of new Set(ready.commit.parents)) {
                const node = nodes.get(parent);
                if (node && pending.has(node) && ready.expanded) node.children--;
            }
            commits.push(ready.commit);
        }
        await fs.checkReads();
        if (!pending.size) return {commits, cursor: null};
        const cursor: HistoryCursor = Object.freeze({continues: 'history' as const});
        walks.set(cursor, walk);
        return {commits, cursor};
    };
    const commitChanges = async (oid: string, scope: string, after: Map<string, Entry>): Promise<FileChange[]> => {
        const {commit} = await git.readCommit({...options, cache, oid});
        let before: Map<string, Entry>;
        try {
            before = await entries(commit.parent[0] || emptyTree, scope);
        } catch (error) {
            // The first parent can be absent in a shallow repository.
            if (errorCode(error) === 'NotFoundError') return [];
            throw error;
        }
        const result: FileChange[] = [];
        for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
            const a = before.get(path), b = after.get(path);
            if (a?.oid !== b?.oid || a?.mode !== b?.mode) result.push({
                path, group: 'commit', before: a?.oid ?? null, after: b?.oid ?? null,
                oldMode: a?.mode ?? null, newMode: b?.mode ?? null, worktree: false, commit: oid
            });
        }
        return result;
    };
    const historyChanges = async (snapshot: Snapshot, oid: string): Promise<FileChange[]> => {
        fs.clearReads();
        await assertSnapshot(snapshot);
        const result = await commitChanges(oid, snapshot.scope, await entries(oid, snapshot.scope));
        await assertSnapshot(snapshot);
        await fs.checkReads();
        return result;
    };
    const readDiff = async (snapshot: Snapshot, change: FileChange, draft?: Uint8Array | null): Promise<FileDiff> => {
        fs.clearReads();
        await assertSnapshot(snapshot);
        pathParts(change.path);
        const before = change.before ? (await git.readBlob({...options, cache, oid: change.before})).blob : new Uint8Array();
        let after: Uint8Array = new Uint8Array();
        if (draft !== undefined) {
            after = draft ?? after;
        } else if (change.after) {
            if (change.worktree) {
                const bytes = await readOptional(fs, '/' + change.path);
                if (!bytes || (await git.hashBlob({object: bytes})).oid !== change.after) throw new GitPanelError('changed');
                after = bytes;
            } else after = (await git.readBlob({...options, cache, oid: change.after})).blob;
        } else if (change.worktree && await readOptional(fs, '/' + change.path)) throw new GitPanelError('changed');
        await assertSnapshot(snapshot);
        await fs.checkReads();
        const size = Math.max(before.byteLength, after.byteLength);
        const tooLarge = size > textLimit;
        const binary = before.includes(0) || after.includes(0);
        const base = {beforeSize: before.byteLength, afterSize: after.byteLength, binary, tooLarge};
        // Project sources are compared as blocks, which stays usable well past the text diff limit.
        const sourceLimit = change.path.split('/').pop() === 'project.source.json' ? 16 * 1024 * 1024 : textLimit;
        if (binary || size > sourceLimit) return {...base, patch: ''};
        const decoder = new TextDecoder('utf-8', {fatal: true});
        let oldText: string, newText: string;
        try {oldText = decoder.decode(before); newText = decoder.decode(after);} catch {
            return {...base, binary: true, patch: ''};
        }
        if ((change.worktree || draft !== undefined) && await git.getConfig({...options, path: 'core.autocrlf'}) === 'true') {
            newText = newText.replace(/\r\n/g, '\n');
        }
        const text = {before: oldText, after: newText};
        if (tooLarge) return {...base, patch: '', text};
        // The path is rendered separately, so newline characters cannot alter patch headers.
        const patch = createTwoFilesPatch(change.before ? 'a/file' : '/dev/null', change.after ? 'b/file' : '/dev/null',
            oldText, newText, undefined, undefined, {context: 3, timeout: 1000});
        return patch === undefined ? {...base, tooLarge: true, patch: '', text} :
            {...base, patch: 'diff --git a/file b/file\n' + patch.replace(/^=+\n/, ''), text};
    };
    const readUnsavedDiff = async (snapshot: Snapshot, path: string, draft: Uint8Array | null) => {
        const parts = pathParts(path);
        if (!parts.length || parts.join('/') !== path || parts.some(part => part.toLowerCase() === '.git') ||
            !inScope(path, snapshot.scope)) throw new GitPanelError('invalid');
        fs.clearReads();
        await assertSnapshot(snapshot);
        const entry = snapshot.head ? (await entries(snapshot.head, path)).get(path) : undefined;
        const change: FileChange = {path, group: entry ? 'unstaged' : 'untracked', before: entry?.oid ?? null,
            after: draft === null ? null : (await git.hashBlob({object: draft})).oid, worktree: false,
            oldMode: entry?.mode ?? null, newMode: draft === null ? null : entry?.mode ?? 0o100644};
        return {change, diff: await readDiff(snapshot, change, draft)};
    };
    const sourceOf = async (snapshot: Snapshot, change: FileChange, version: ProjectVersion): Promise<Source | null> => {
        if (change[version] === null) return null;
        if (change.fromHead && version === 'before') return snapshot.head ? {kind: 'tree', ref: snapshot.head} : null;
        switch (change.group) {
        case 'staged': return version === 'after' ? {kind: 'index'} : snapshot.head ? {kind: 'tree', ref: snapshot.head} : null;
        case 'unstaged': return version === 'after' ? {kind: 'worktree'} : {kind: 'index'};
        case 'untracked': return version === 'after' ? {kind: 'worktree'} : null;
        case 'commit': {
            if (!change.commit) return null;
            if (version === 'after') return {kind: 'tree', ref: change.commit};
            const parent = (await git.readCommit({...options, cache, oid: change.commit})).commit.parent[0];
            return parent ? {kind: 'tree', ref: parent} : null;
        }
        }
    };
    /** Reads one regular file of one version, or `null` when it is missing or larger than the limit. */
    const readVersion = async (source: Source, path: string, limit: number): Promise<Uint8Array | null> => {
        if (source.kind === 'worktree') {
            const stat = await fs.promises.stat('/' + path).catch(() => null);
            if (!stat?.isFile() || stat.size > limit) return null;
            const bytes = await readOptional(fs, '/' + path);
            return bytes && bytes.byteLength <= limit ? bytes : null;
        }
        const entry = (await entries(source.kind === 'tree' ? source.ref : null, path)).get(path);
        if (!entry || (entry.mode !== 0o100644 && entry.mode !== 0o100755)) return null;
        const {blob} = await git.readBlob({...options, cache, oid: entry.oid});
        return blob.byteLength <= limit ? blob : null;
    };
    const comparisonSource = async (snapshot: Snapshot, comparison: ProjectComparison, version: ProjectVersion): Promise<Source | null> => {
        if (comparison.kind === 'worktree') return version === 'after' ? {kind: 'worktree'} : snapshot.head ? {kind: 'tree', ref: snapshot.head} : null;
        if (version === 'after') return {kind: 'tree', ref: comparison.commit};
        const parent = (await git.readCommit({...options, cache, oid: comparison.commit})).commit.parent[0];
        return parent ? {kind: 'tree', ref: parent} : null;
    };
    const readAsset = (snapshot: Snapshot, change: FileChange, version: ProjectVersion, md5ext: string, signal: AbortSignal) =>
        readFolderAsset(snapshot, pathParts(change.path).slice(0, -1), () => sourceOf(snapshot, change, version), md5ext, signal);
    const readFolderAsset = async (snapshot: Snapshot, folder: string[], resolve: () => Promise<Source | null>, md5ext: string,
        signal: AbortSignal) => {
        if (signal.aborted) return null;
        fs.clearReads();
        await assertSnapshot(snapshot);
        const source = await resolve();
        if (!source) return null;
        const settings = await readVersion(source, [...folder, 'sb3-source.json'].join('/'), folderSettingsLimit);
        const directory = assetsDirectoryParts(settings && new TextDecoder().decode(settings));
        if (!directory || signal.aborted) return null;
        const bytes = await readVersion(source, [...folder, ...directory, md5ext].join('/'), assetLimit);
        await fs.checkReads();
        return bytes && !signal.aborted ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null;
    };
    /** Reads the project file and the assets directory of both versions of a project folder. */
    const readProject = async (snapshot: Snapshot, folder: string, comparison: ProjectComparison) => {
        fs.clearReads();
        await assertSnapshot(snapshot);
        const parts = pathParts(folder);
        const read = async (version: ProjectVersion) => {
            const source = await comparisonSource(snapshot, comparison, version);
            if (!source) return {source: null, assetsDirectory: 'assets'};
            const bytes = await readVersion(source, [...parts, 'project.source.json'].join('/'), projectSourceLimit);
            const settings = await readVersion(source, [...parts, 'sb3-source.json'].join('/'), folderSettingsLimit);
            const directory = assetsDirectoryParts(settings && new TextDecoder().decode(settings));
            let text: string | null = null;
            if (bytes) {
                try {text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);} catch {
                    throw new GitPanelError('unsupported');
                }
            }
            return {source: text, assetsDirectory: directory ? directory.join('/') : 'assets'};
        };
        const before = await read('before'), after = await read('after');
        await assertSnapshot(snapshot);
        await fs.checkReads();
        return {before: before.source, after: after.source, assetsDirectory: {before: before.assetsDirectory, after: after.assetsDirectory}};
    };
    const hasCommit = async (oid: string) => {
        try {
            await git.readCommit({...options, cache, oid});
            return true;
        } catch {
            return false;
        }
    };
    type TreeChange = {path: string; before: Entry | null; after: Entry | null};
    /** Lists the paths that differ between two trees, skipping subtrees with the same object. */
    const treeChanges = async (before: string, after: string): Promise<TreeChange[]> => {
        const file = async (entry: git.WalkerEntry | null) => entry && await entry.type() !== 'tree' ?
            {oid: await entry.oid(), mode: await entry.mode()} : null;
        const changes = await git.walk({...options, cache, trees: [git.TREE({ref: before}), git.TREE({ref: after})],
            map: async (path, [a, b]) => {
                if (path === '.') return;
                if (a && b && await a.oid() === await b.oid() && await a.mode() === await b.mode()) return null;
                const change = {path, before: await file(a), after: await file(b)};
                // A tree on either side is walked on; a file on the other side is a change of its own.
                return change.before || change.after ? change : undefined;
            }}) as TreeChange[];
        return changes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    };
    const readBlobText = async (entry: Entry | null) => {
        if (!entry) return '{"targets":[]}\n';
        if (entry.mode !== 0o100644 && entry.mode !== 0o100755) throw new GitPanelError('unsupported');
        const {blob} = await git.readBlob({...options, cache, oid: entry.oid});
        if (blob.byteLength > projectSourceLimit) throw new GitPanelError('large');
        return new TextDecoder('utf-8', {fatal: true}).decode(blob);
    };
    const readTreeAsset = async (ref: string, folder: string[], md5ext: string, signal: AbortSignal) => {
        if (signal.aborted) return null;
        const source: Source = {kind: 'tree', ref};
        const settings = await readVersion(source, [...folder, 'sb3-source.json'].join('/'), folderSettingsLimit);
        const directory = assetsDirectoryParts(settings && new TextDecoder().decode(settings));
        if (!directory || signal.aborted) return null;
        const bytes = await readVersion(source, [...folder, ...directory, md5ext].join('/'), assetLimit);
        return bytes && !signal.aborted ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null;
    };
    const pullRequestAssets = (versions: Record<ProjectVersion, {ref: string; path: string} | null>): ProjectAssetLoader =>
        ({version, md5ext, signal}) => {
            const location = versions[version];
            if (!location || !isAssetName(md5ext) || signal.aborted) return Promise.resolve(null);
            return serial(() => readTreeAsset(location.ref, pathParts(location.path).slice(0, -1), md5ext, signal)).catch(() => null);
        };
    /** Compares a fetched pull request head with its merge base, from local Git objects only. */
    const readPullRequest = async (head: string, base: PullRequestBase): Promise<PullRequestFiles> => {
        if (!isSha(head) || !await hasCommit(head)) throw new GitPanelError('pullRequestNotFound');
        let sha: string | undefined;
        if (isSha(base.sha) && await hasCommit(base.sha)) sha = base.sha;
        else if (base.branch !== undefined && validBranch(base.branch)) {
            try {
                sha = await git.resolveRef({...options, ref: 'refs/remotes/origin/' + base.branch});
            } catch {
                // Reported below.
            }
        }
        if (!sha || !await hasCommit(sha)) throw new GitPanelError('baseMissing');
        const [mergeBase = null] = await git.findMergeBase({...options, cache, oids: [sha, head]}) as string[];
        const changes = await treeChanges(mergeBase ?? emptyTree, head);
        // Pair a removed and an added file with the same content as a rename, like GitHub's exact renames.
        const added = new Map<string, TreeChange[]>();
        for (const change of changes) if (!change.before && change.after) added.set(change.after.oid, [...added.get(change.after.oid) ?? [], change]);
        const renamed = new Map<TreeChange, TreeChange>();
        for (const change of changes) {
            const candidates = change.before && !change.after ? added.get(change.before.oid) : undefined;
            const target = candidates?.find(candidate => !renamed.has(candidate));
            if (target) renamed.set(target, change);
        }
        const removedByRename = new Set(renamed.values());
        const files: ProjectSourceReviewFile[] = [];
        for (const change of changes) {
            if (removedByRename.has(change)) continue;
            const from = renamed.get(change);
            const before = from?.before ?? change.before;
            const previousPath = from?.path;
            const status = !before ? 'added' : !change.after ? 'removed' : 'updated';
            if (change.path.split('/').pop() !== 'project.source.json') {
                files.push({path: change.path, previousPath, status});
                continue;
            }
            try {
                const patch = createProjectSourceDiff(await readBlobText(before), await readBlobText(change.after));
                const loadAsset = pullRequestAssets({
                    before: before && mergeBase ? {ref: mergeBase, path: previousPath ?? change.path} : null,
                    after: change.after ? {ref: head, path: change.path} : null
                });
                files.push({path: change.path, previousPath, patch, loadAsset});
            } catch {
                files.push({path: change.path, previousPath, status, unavailable: true});
            }
        }
        return {base: {ref: base.branch ?? null, sha}, head, mergeBase, files};
    };
    // Walk the same two revisions used by the diff, excluding every commit reachable from the base.
    const pullRequestCommits = async (head: string, base: string, signal: AbortSignal) => {
        if (!isSha(head) || !isSha(base)) throw new GitPanelError('invalid');
        const excluded = new Set<string>();
        const pending = [base];
        while (pending.length) {
            signal.throwIfAborted();
            const oid = pending.pop()!;
            if (excluded.has(oid)) continue;
            if (excluded.size >= 10000) throw new GitPanelError('unsupported');
            const {commit} = await git.readCommit({...options, cache, oid});
            excluded.add(oid);
            pending.push(...commit.parent);
        }
        const commits: Commit[] = [];
        pending.push(head);
        while (pending.length) {
            signal.throwIfAborted();
            const oid = pending.pop()!;
            if (excluded.has(oid)) continue;
            if (commits.length === 250) return {commits: commits.reverse(), limited: true};
            const {commit} = await git.readCommit({...options, cache, oid});
            excluded.add(oid);
            commits.push({oid, message: commit.message, author: commit.author.name, timestamp: commit.author.timestamp});
            pending.push(...commit.parent);
        }
        return {commits: commits.reverse(), limited: false};
    };
    const directoryAt = async (path: string) => {
        let directory = root;
        for (const part of pathParts(path)) directory = await directory.getDirectoryHandle(part);
        return directory;
    };
    const browse = async (path = '') => {
        path = pathParts(path).join('/');
        const directory = await directoryAt(path);
        const children: string[] = [];
        let isProject = false;
        for await (const entry of (directory as FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>}).values()) {
            if (entry.kind === 'directory' && entry.name !== '.git') children.push(entry.name);
            if (entry.kind === 'file' && entry.name === 'project.source.json') isProject = true;
        }
        return {path, children: children.sort(), isProject};
    };
    const openProject = async (path: string) => {
        const parts = pathParts(path);
        let directory = root;
        for (const part of parts) {
            directory = await directory.getDirectoryHandle(part);
            for await (const entry of (directory as FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>}).values()) {
                if (entry.name === '.git') throw new GitPanelError('invalid');
            }
        }
        const parentParts = await root.resolve(directory);
        if (parentParts === null || parentParts.join('/') !== parts.join('/')) throw new GitPanelError('invalid');
        await directory.getFileHandle('project.source.json');
        return directory;
    };
    const defaultProject = async (rootFolder: Awaited<ReturnType<typeof browse>>) => {
        if (rootFolder.isProject) return '';
        if (!rootFolder.children.includes('project')) return null;
        try {
            await openProject('project');
            return 'project';
        } catch (error) {
            if (error instanceof GitPanelError && error.code === 'invalid') return null;
            if (error instanceof DOMException && ['NotFoundError', 'TypeMismatchError', 'NotAllowedError'].includes(error.name)) return null;
            throw error;
        }
    };
    return {root, openProject, browse, defaultProject, probe,
        readHead: () => serial(readHead),
        readOrigin: () => serial(() => git.getConfig({...options, path: 'remote.origin.url'})),
        remoteOperation: (operation: RemoteOperation, getSession: GetRemoteSession, guard: () => void, signal?: AbortSignal) =>
            serial(async () => {
                if (operation === 'push' && pushNeedsFetch) throw new GitPanelError('pushUnknown');
                try {
                    await runRemoteOperation(root, operation, getSession, guard, signal);
                    if (operation === 'fetch') pushNeedsFetch = false;
                } catch (error) {
                    if (operation === 'push' && error instanceof GitPanelError &&
                        (error.code === 'pushUnknown' || error.code === 'pushRefresh')) pushNeedsFetch = true;
                    throw error;
                }
            }),
        /**
         * Fetches a pull request's head (`refs/pull/<number>/head`, which also covers pull requests from forks) and every
         * branch over the connection; see `runPullRequestFetch`. Only Git objects and refs are written.
         */
        fetchPullRequest: (number: number, getSession: GetRemoteSession, guard: () => void, signal?: AbortSignal) =>
            serial(async () => {
                const result = await runPullRequestFetch(root, number, getSession, guard, signal);
                cache = {};
                return result;
            }),
        /**
         * Reads the changes of a fetched pull request head against a base, from local Git objects: the changed paths
         * from the merge base to the head, and each project file's diff with assets read from the same commits.
         */
        readPullRequest: (head: string, base: PullRequestBase) => serial(() => readPullRequest(head, base)),
        pullRequestCommits: (head: string, base: string, signal: AbortSignal) =>
            serial(() => pullRequestCommits(head, base, signal)),
        /** Stages, unstages or commits; see `runLocalOperation`. `guard` throws to stop before each write. */
        localOperation: (operation: LocalOperation, guard: () => void) =>
            serial(() => runLocalOperation(root, operation, guard)),
        /**
         * Whether a local branch, `origin/<name>` with `remote`, or the commit `name` with `remote` set to `'commit'`,
         * has the folder `path` (the root always exists).
         */
        hasFolder: (name: string, path: string, remote: boolean | 'commit' = false) => serial(async () => {
            const ref = remote === 'commit' ? name : remote ? `refs/remotes/origin/${name}` : `refs/heads/${name}`;
            if (!path) return true;
            try {
                const {tree} = await git.readTree({...options, oid: await git.resolveRef({...options, ref}), filepath: path});
                return tree.length > 0;
            } catch {
                return false;
            }
        }),
        read: (scope?: string, filepaths?: string[]) => serial(() => read(scope, filepaths)),
        /** Reads the saved files against the index, HEAD and the last known upstream, under one folder. */
        readFileStatus: (scope: string, fingerprint: string, {includeUpstream = true} = {}) =>
            serial(() => readFileStatus(pathParts(scope).join('/'), fingerprint, includeUpstream)),
        /**
         * The current branch, HEAD and the branch names, read from refs only. Cheap enough to follow branch changes made
         * by other tools while nothing else is read; `read` returns the same fields.
         */
        refs: () => serial(() => {
            fs.clearReads();
            return readRefs();
        }),
        /** Reads a regular file from the latest local commit. Missing paths and unborn branches have null bytes. */
        readHeadFile: (path: string, limit: number) => serial(() => readHeadFile(path, limit)),
        readDiff: (snapshot: Snapshot, change: FileChange) => serial(() => readDiff(snapshot, change)),
        readUnsavedDiff: (snapshot: Snapshot, path: string, draft: Uint8Array | null) =>
            serial(() => readUnsavedDiff(snapshot, path, draft)),
        planProjectRestore: (oid: string, folder: string) => serial(() => readRestorePlan(oid, folder)),
        readProjectVersion: (oid: string, folder: string) => serial(() => readProjectVersion(oid, folder)),
        historyChanges: (snapshot: Snapshot, oid: string) => serial(() => historyChanges(snapshot, oid)),
        /**
         * Reads one page of the commits reachable from the local branches, `origin/*` and a detached HEAD, newest first
         * with each child above its parents, and the refs at each. Pass the returned `cursor` as `after` for the next page.
         */
        history: (options?: {limit?: number; after?: HistoryCursor | null}) => serial(() => history(options)),
        /**
         * Reads the assets of both versions of a selected project file, for thumbnails. Staged changes compare HEAD with
         * the index, unstaged ones the index with the working tree, untracked ones nothing with the working tree, and
         * commit changes the first parent with the commit. Each version's sb3-source.json names its assets directory.
         * Reads never write, and resolve `null` for anything missing, invalid, larger than 10 MiB or changed since the snapshot.
         */
        assetLoader: (snapshot: Snapshot, change: FileChange): ProjectAssetLoader => ({version, md5ext, signal}) =>
            !isAssetName(md5ext) || signal.aborted ? Promise.resolve(null) :
                serial(() => readAsset(snapshot, change, version, md5ext, signal)).catch(() => null),
        /**
         * Reads the project file of a folder in both versions of a comparison, with each version's assets directory.
         * `null` stands for a version without the file. Throws `changed` when the repository changed since the snapshot.
         */
        readProject: (snapshot: Snapshot, folder: string, comparison: ProjectComparison) =>
            serial(() => readProject(snapshot, folder, comparison)),
        /** Reads the assets of a folder in both versions of a comparison, like `assetLoader`. */
        projectAssetLoader: (snapshot: Snapshot, folder: string, comparison: ProjectComparison): ProjectAssetLoader =>
            ({version, md5ext, signal}) => !isAssetName(md5ext) || signal.aborted ? Promise.resolve(null) :
                serial(() => readFolderAsset(snapshot, pathParts(folder), () => comparisonSource(snapshot, comparison, version),
                    md5ext, signal)).catch(() => null)
    };
}
export type Repository = Awaited<ReturnType<typeof openRepository>>;
