# TurboWarp Plus Editor Git

[日本語](README.ja.md)

Local Git adds a read-only panel to the TurboWarp Plus Editor File menu. Select the repository root once, then browse to an sb3-toolchain v1 project folder inside it. Project editing and saving are supplied by the Editor's project-folder integration.

The panel separates staged, unstaged, and untracked changes. It shows the current branch, HEAD, local branches, and the latest 50 commits. Select a file to inspect its text diff or binary size. When the host supplies a block renderer, project data (`project.source.json`) is compared as blocks by stage, sprite and code, and **Text** switches to the line diff. Each stage and sprite heading shows a thumbnail of its current costume (the backdrop for the stage) in each version. Assets are read from the compared versions: HEAD and the index for staged changes, the index and the working tree for unstaged changes, the working tree for untracked files, and the first parent and the commit for history. The assets folder is the `assetsDirectory` of that version's `sb3-source.json` (`assets` by default). When an asset cannot be read, only the name is shown. Pull request reviews read the same thumbnails from raw.githubusercontent.com at the merge base and head, without using the GitHub API rate limit. Select a commit to compare its files with its first parent. The selected project limits the file list and diffs to that folder.

While the panel is open, it checks the repository every two seconds, when the window regains focus, and on `FileSystemObserver` notifications where available. It compares the sizes and modification times of HEAD, the index, `packed-refs`, `config`, the current branch ref, and the files in the selected project folder (the whole work tree when no project is selected, up to 5,000 files). When something changed and no diff or commit is open, the panel reads the repository again. While a diff, a commit or a pull request review is open, it keeps the view and asks you to **Refresh** instead. Checks wait while Git holds a lock on its metadata. **Reload Project** opens the selected project again using the Editor's unsaved-edit confirmation. Git inspection uses a read-only adapter and isomorphic-git with index refresh disabled. If the repository changes during a read, refresh after the other operation completes.

A Chromium-based browser with File System Access support is required. The first version supports ordinary `.git` directories and content changes. Linked worktrees, submodules, and symbolic links are outside this scope. The browser cannot detect working-tree executable-bit changes. Recorded index and tree modes remain visible. Binary assets show sizes, and text diff generation is bounded.

Use Node.js 26, run `npm ci`, then `npm test`. Vite builds the library and stylesheet, and TypeScript emits declarations. `npm pack` prepares the artifact used by the Editor build. The Editor enables the panel by default. Start it with `twPlusLocalGit=0` in its URL to disable the integration.

The panel structure and local Git approach were informed by [duff](https://github.com/chigichan24/duff). The implementation uses [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) and [react-diff-view](https://github.com/otakustay/react-diff-view). Bundled licenses are listed in the build's third-party notices.

## Smart HTTP adapter

`test/smart-http-fixture.js` runs `git-http-backend` on the IPv4 loopback for tests. It uses only Node.js built-in modules and ships in the package so browser tests of a host use the fixture of the same version.

Import `createGitSmartHttp` from `@kubohiroya/turbowarp-plus-editor-git/smart-http`. Pass the selected GitHub HTTPS remote from Git config, a trusted connection (`mode` and `proxyOrigin`), and a function that returns the current proxy session or `null`. A `GitAuthProvider` from the auth package satisfies this contract. The Git package uses the session fields structurally, so the read-only panel and the adapter can be installed independently of the auth package.

```ts
const transport = createGitSmartHttp({
    remote: configuredRemoteUrl,
    connection: provider.connection,
    getSession: () => provider.getSession()
});
await git.fetch({fs, dir, remote: remoteName, ...transport});
```

Pass the same transport options to `git.fastForward` for fast-forward-only pulls and to `git.push` with `force: false` for explicit pushes. Keep the existing worktree safety checks in the caller. The adapter writes no Git configuration and sends only proxy credentials to the fixed proxy. It maps Git discovery and RPC requests to `/v1/git/<owner>/<repo>.git/`. Requests have a 32 MiB cap, which the caller can lower, and successful responses stream back to isomorphic-git. A `PUSH_OUTCOME_UNKNOWN` error means the remote ref must be checked before another push.

Each receive-pack POST carries a new UUID v4 in `Git-Push-Id`. A browser replay carries the same ID. The proxy's `409 PUSH_DUPLICATE` is exposed as `PUSH_OUTCOME_UNKNOWN` so the caller can reconcile the remote ref with a fetch.

`npm test` runs the local Git tests and a headless Smart HTTP fixture on IPv4 loopback using `git-http-backend`. The fixture uses disposable repositories and test credentials. [Proxy, authentication and CORS contract](https://github.com/kubohiroya/turbowarp-plus-editor/issues/315).

When the Editor host supplies connection settings, the Local Git panel offers fetch, fast-forward pull and push for the current branch and its existing GitHub HTTPS `origin`. Authorize push when connecting to enable the explicit push action. Fetch updates Git metadata. Pull requires a stopped project, a clean worktree, and regular non-executable files. Pull stages the changes, rechecks the local state, and then applies them. Reopen the project from the panel after a successful pull.

## Release

`.github/workflows/release.yml` publishes to npm. Push a `v<version>` tag that names the
`package.json` version on a `main` commit: the workflow runs the tests, packs the archive, attaches it
to the GitHub Release, publishes it to npm and points `latest` and `next` at it. It authenticates with
npm Trusted Publishing (OIDC), not a token, and publishes with provenance. The npm settings name this
workflow file, so rename both together.
