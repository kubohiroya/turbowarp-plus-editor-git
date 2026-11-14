import * as git from 'isomorphic-git';
import type {TreeEntry} from 'isomorphic-git';
import {errorCode, GitPanelError} from './filesystem.js';
import {createMutationFs} from './mutation-fs.js';
import {pushWithoutForce} from './remote-operations.js';
import type {GetRemoteSession} from './remote-operations.js';
import {createGitSmartHttp, MAX_GIT_REQUEST_BYTES, remoteUrl} from './smart-http.js';

export const MAX_PAGES_HTML_BYTES = MAX_GIT_REQUEST_BYTES - 1024 * 1024;
export type PagesFolder = '/' | '/docs';

export async function publishPagesHtml({root, remote, branch, base, folder, html, getSession}: {
    root: FileSystemDirectoryHandle;
    remote: string;
    branch: string;
    base: string;
    folder: PagesFolder;
    html: Uint8Array;
    getSession: GetRemoteSession;
}) {
    if (!html.byteLength || html.byteLength > MAX_PAGES_HTML_BYTES) throw new GitPanelError('large');
    // Keep the fetched objects and publication commit in memory. A successful push leaves the local checkout alone.
    const {fs} = createMutationFs(root, false);
    const options = {fs, dir: '/', gitdir: '/.git', cache: {}};
    const config = (path: string) => git.getConfig({...options, path});
    const configured = await config('remote.origin.url');
    if (!configured || remoteUrl(configured) !== remoteUrl(remote)) throw new GitPanelError('session');
    const name = await config('user.name');
    const email = await config('user.email');
    if (!name || !email || /[<>\r\n]/u.test(name + email)) throw new GitPanelError('author');
    const session = await getSession(configured, true);
    if (!session) throw new GitPanelError('session');
    const transport = createGitSmartHttp({remote, connection: session.connection,
        getSession: () => getSession(configured, true)});
    const ref = 'refs/heads/' + branch;
    const refs = await git.listServerRefs({...transport, forPush: true, protocolVersion: 1});
    if (refs.find(entry => entry.ref === ref)?.oid !== base) throw new GitPanelError('changed');
    const readTree = (oid: string) => git.readTree({...options, oid});
    const {tree: rootTree} = await readTree(base).catch(async error => {
        if (errorCode(error) !== 'NotFoundError') throw error;
        const result = await git.fetch({...options, ...transport, remote: 'origin', ref, remoteRef: ref,
            singleBranch: true, tags: false});
        if (result.fetchHead !== base) throw new GitPanelError('changed');
        return readTree(base);
    });
    const docs = folder === '/docs' ? rootTree.find(entry => entry.path === 'docs') : undefined;
    if (docs && docs.type !== 'tree') throw new GitPanelError('unsupported');
    const files = folder === '/' ? rootTree : docs ? (await readTree(docs.oid)).tree : [];
    const existing = files.find(entry => entry.path === 'index.html');
    if (existing && existing.mode !== '100644') throw new GitPanelError('unsupported');
    const oid = await git.writeBlob({...options, blob: html});
    if (existing?.oid === oid) return base;
    const replace = (entries: TreeEntry[], entry: TreeEntry) =>
        git.writeTree({...options, tree: [...entries.filter(item => item.path !== entry.path), entry]});
    const outputTree = await replace(files, {path: 'index.html', oid, type: 'blob', mode: '100644'});
    const tree = folder === '/' ? outputTree :
        await replace(rootTree, {path: 'docs', oid: outputTree, type: 'tree', mode: '040000'});
    const author = {name, email, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: new Date().getTimezoneOffset()};
    const commit = await git.writeCommit({...options, commit: {tree, parent: [base], author, committer: author,
        message: 'Publish project HTML to GitHub Pages\n'}});
    const result = await pushWithoutForce({...options, ...transport, remote: 'origin', ref: commit, remoteRef: ref,
        onPrePush({remoteRef}) {
            if (remoteRef.ref !== ref || remoteRef.oid !== base) throw new GitPanelError('changed');
            return true;
        }});
    if (!result.refs[ref]?.ok) throw new GitPanelError('pushUnknown');
    return commit;
}
