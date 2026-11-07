# TurboWarp Plus Editor Git

[English](README.md)

TurboWarp Plus Editor のファイルメニューに、読み取り専用の「ローカル Git」を追加します。リポジトリルートを一度選び、配下の sb3-toolchain v1 作品フォルダをパネルから開きます。作品の編集と保存には Editor の project-folder 接続を使います。

ステージ済み・未ステージ・未追跡の変更、現在のブランチ、HEAD、ローカルブランチと直近50件の履歴を表示します。ファイルを選ぶとテキスト差分またはバイナリのサイズを確認できます。コミットを選ぶと第一親との差分を表示します。作品を選んでいるときは、変更一覧と差分をそのフォルダに絞ります。

外部で Git を操作した後は **再取得** を使います。**作品を再読込** では、Editor の未保存編集を確認してから同じ作品を開き直します。Git の閲覧には読み取り専用のアダプターを使い、インデックスの更新を無効にします。読み取り中にファイルや Git の状態が変わった場合は、外部操作の完了後に再取得します。

File System Access に対応する Chromium 系ブラウザーが必要です。初版は通常の `.git` ディレクトリとファイル内容の変更を扱います。linked worktree、サブモジュール、シンボリックリンクは対象外です。作業ツリーの実行権限の変更はブラウザーから検出できません。Git に記録済みのファイルモードは表示します。バイナリアセットはサイズを示し、テキスト差分の生成には上限があります。

Node.js 26 で `npm ci` と `npm test` を実行します。Vite でライブラリとスタイルシート、TypeScript で型宣言を生成します。`npm pack` で Editor 用の配布物を作成します。Editor では既定で有効です。起動 URL に `twPlusLocalGit=0` を指定するとパネルの接続を解除できます。

パネルの構成とローカル Git の扱いは [duff](https://github.com/chigichan24/duff) を参考にしました。実装には [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) と [react-diff-view](https://github.com/otakustay/react-diff-view) を使用し、同梱依存のライセンスはビルド時の第三者ライセンス一覧に収録します。
