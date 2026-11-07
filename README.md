# TurboWarp Plus Editor Git

[日本語](README.ja.md)

Local Git adds a read-only panel to the TurboWarp Plus Editor File menu. Select the repository root once, then browse to an sb3-toolchain v1 project folder inside it. Project editing and saving are supplied by the Editor's project-folder integration.

The panel separates staged, unstaged, and untracked changes. It shows the current branch, HEAD, local branches, and the latest 50 commits. Select a file to inspect its text diff or binary size. Select a commit to compare its files with its first parent. The selected project limits the file list and diffs to that folder.

After an external Git operation, use **Refresh**. **Reload Project** opens the selected project again using the Editor's unsaved-edit confirmation. Git inspection uses a read-only adapter and isomorphic-git with index refresh disabled. If the repository changes during a read, refresh after the other operation completes.

A Chromium-based browser with File System Access support is required. The first version supports ordinary `.git` directories and content changes. Linked worktrees, submodules, and symbolic links are outside this scope. The browser cannot detect working-tree executable-bit changes. Recorded index and tree modes remain visible. Binary assets show sizes, and text diff generation is bounded.

Use Node.js 26, run `npm ci`, then `npm test`. Vite builds the library and stylesheet, and TypeScript emits declarations. `npm pack` prepares the artifact used by the Editor build. The Editor enables the panel by default. Start it with `twPlusLocalGit=0` in its URL to disable the integration.

The panel structure and local Git approach were informed by [duff](https://github.com/chigichan24/duff). The implementation uses [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) and [react-diff-view](https://github.com/otakustay/react-diff-view). Bundled licenses are listed in the build's third-party notices.
