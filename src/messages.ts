export const messages = {
    en: {
        title: 'Local Git', menu: 'Local Git…', close: 'Close', choose: 'Choose Repository…', refresh: 'Refresh',
        empty: 'Choose an existing Git repository to inspect its files and history.',
        repository: 'Repository', project: 'Project folder', none: 'No project selected', root: 'Repository root',
        open: 'Open This Project', reload: 'Reload Project', up: 'Parent folder', browse: 'Choose a project inside this repository',
        replace: 'Replace the open project and discard its unsaved changes?',
        dirty: 'The Editor has unsaved changes.', saved: 'The Editor has no unsaved changes.',
        staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked', commit: 'Commit changes',
        history: 'History', worktree: 'Working tree', clean: 'No changes in the selected folder.',
        branches: 'Local branches', unborn: 'No commits yet', detached: 'Detached HEAD', select: 'Select a file to view its diff.',
        binary: 'Binary asset', large: 'Text preview exceeds its display limit.', bytes: 'bytes',
        mode: 'Git file mode', permissions: 'Working-tree executable permission changes are unavailable in the browser.',
        unchanged: 'The text is unchanged.', loading: 'Reading repository…',
        invalid: 'Choose a repository with a .git directory, and a project inside that repository.',
        changed: 'Files or Git state changed while reading. Refresh to read the current state.',
        unsupported: 'This repository contains an entry the browser cannot represent.',
        failed: 'Could not read the repository. Check folder access and refresh.'
    },
    ja: {
        title: 'ローカル Git', menu: 'ローカル Git…', close: '閉じる', choose: 'リポジトリを選択…', refresh: '再取得',
        empty: '既存の Git リポジトリを選び、ファイルの状態と履歴を確認できます。',
        repository: 'リポジトリ', project: '作品フォルダ', none: '作品は未選択', root: 'リポジトリルート',
        open: 'この作品を開く', reload: '作品を再読込', up: '上のフォルダ', browse: 'リポジトリ内の作品を選択',
        replace: '未保存の変更を破棄して、別の作品を開きますか？',
        dirty: 'Editor に未保存の変更があります。', saved: 'Editor に未保存の変更はありません。',
        staged: 'ステージ済み', unstaged: '未ステージ', untracked: '未追跡', commit: 'コミットの変更',
        history: '履歴', worktree: '作業ツリー', clean: '対象フォルダに変更はありません。',
        branches: 'ローカルブランチ', unborn: 'コミットはまだありません', detached: 'ブランチ未選択の HEAD', select: 'ファイルを選ぶと差分を表示します。',
        binary: 'バイナリアセット', large: 'テキスト差分の表示上限を超えています。', bytes: 'バイト',
        mode: 'Git のファイルモード', permissions: '作業ツリーの実行権限の変更はブラウザーから確認できません。',
        unchanged: 'テキストに変更はありません。', loading: 'リポジトリを読込中…',
        invalid: '.git ディレクトリを持つリポジトリと、その配下の作品を選んでください。',
        changed: '読込中にファイルまたは Git の状態が変わりました。再取得してください。',
        unsupported: 'ブラウザーで扱えない種類の Git エントリーがあります。',
        failed: 'リポジトリを読み込めませんでした。フォルダへのアクセスを確認し、再取得してください。'
    }
};
export type Labels = typeof messages.en;
export const labelsFor = (locale: string): Labels => locale.startsWith('ja') ? messages.ja : messages.en;
