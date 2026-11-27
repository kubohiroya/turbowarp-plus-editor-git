// SPDX-License-Identifier: MPL-2.0
import * as git from 'isomorphic-git';
import {createReadOnlyFs} from './filesystem.js';
import type {GitAuthor} from './local-operations.js';
import type {GetRemoteSession} from './remote-operations.js';
export interface CollaborationRecord {
    sessionId: string; range: {sessionId: string; from: number; to: number}; representative: string;
}
export interface CommitAttribution {
    message: string; author: GitAuthor; explicitAuthor: true; collaboration?: CollaborationRecord;
}
export interface GitCollaborationPort {
    workLabel?: string;
    prepareCommit(root: FileSystemDirectoryHandle, message: string): Promise<CommitAttribution | null | undefined>;
    committed(root: FileSystemDirectoryHandle, oid: string, record: CollaborationRecord): Promise<void>;
    runPush<T>(root: FileSystemDirectoryHandle, execute: (getSession: GetRemoteSession) => Promise<T>): Promise<T | undefined>;
    showCommitWork?(oid: string): void;
}
export async function inspectPairRepository(root: FileSystemDirectoryHandle) {
    const options = {fs: createReadOnlyFs(root), dir: '/', gitdir: '/.git', cache: {}};
    const branch = await git.currentBranch(options) ?? null;
    const head = await git.resolveRef({...options, ref: 'HEAD'}).catch(error => {
        if (error.code === 'NotFoundError') return null;
        throw error;
    });
    const remote = await git.getConfig({...options, path: 'remote.origin.url'}) ?? null;
    return {point: {branch, head}, remote};
}
export async function hasPairCommit(root: FileSystemDirectoryHandle, oid: string) {
    try {await git.readCommit({fs: createReadOnlyFs(root), dir: '/', gitdir: '/.git', oid}); return true;}
    catch (error) {if ((error as {code?: string}).code === 'NotFoundError') return false; throw error;}
}
/** Outgoing ancestry is local evidence. Author timestamps never determine attribution. */
export async function readOutgoingCommits(root: FileSystemDirectoryHandle): Promise<string[]> {
    const options = {fs: createReadOnlyFs(root), dir: '/', gitdir: '/.git', cache: {}};
    const branch = await git.currentBranch(options);
    if (!branch) return [];
    const target = await git.getConfig({...options, path: `branch.${branch}.merge`});
    const remoteRef = 'refs/remotes/origin/' + (target?.replace(/^refs\/heads\//u, '') ?? branch);
    const base = await git.resolveRef({...options, ref: remoteRef}).catch(error => {
        if (error.code === 'NotFoundError') return undefined;
        throw error;
    });
    const walk = async (ref: string) => {
        const commits = await git.log({...options, ref, depth: 10001});
        if (commits.length > 10000) throw new Error('PAIR_HISTORY_LIMIT');
        return commits.map(commit => commit.oid);
    };
    const local = await walk('HEAD'), remote = new Set(base ? await walk(base) : []);
    return local.filter(oid => !remote.has(oid));
}
