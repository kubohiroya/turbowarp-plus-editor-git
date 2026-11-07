# TurboWarp Plus Editor Git

[English](README.md)

TurboWarp Plus Editor のファイルメニューに、読み取り専用の「ローカル Git」を追加します。リポジトリルートを一度選び、配下の sb3-toolchain v1 作品フォルダをパネルから開きます。作品の編集と保存には Editor の project-folder 接続を使います。

ステージ済み・未ステージ・未追跡の変更、現在のブランチ、HEAD、ローカルブランチと直近50件の履歴を表示します。ファイルを選ぶとテキスト差分またはバイナリのサイズを確認できます。コミットを選ぶと第一親との差分を表示します。作品を選んでいるときは、変更一覧と差分をそのフォルダに絞ります。

外部で Git を操作した後は **再取得** を使います。**作品を再読込** では、Editor の未保存編集を確認してから同じ作品を開き直します。Git の閲覧には読み取り専用のアダプターを使い、インデックスの更新を無効にします。読み取り中にファイルや Git の状態が変わった場合は、外部操作の完了後に再取得します。

File System Access に対応する Chromium 系ブラウザーが必要です。初版は通常の `.git` ディレクトリとファイル内容の変更を扱います。linked worktree、サブモジュール、シンボリックリンクは対象外です。作業ツリーの実行権限の変更はブラウザーから検出できません。Git に記録済みのファイルモードは表示します。バイナリアセットはサイズを示し、テキスト差分の生成には上限があります。

Node.js 26 で `npm ci` と `npm test` を実行します。Vite でライブラリとスタイルシート、TypeScript で型宣言を生成します。`npm pack` で Editor 用の配布物を作成します。Editor では既定で有効です。起動 URL に `twPlusLocalGit=0` を指定するとパネルの接続を解除できます。

パネルの構成とローカル Git の扱いは [duff](https://github.com/chigichan24/duff) を参考にしました。実装には [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) と [react-diff-view](https://github.com/otakustay/react-diff-view) を使用し、同梱依存のライセンスはビルド時の第三者ライセンス一覧に収録します。

## Smart HTTP アダプター

`@kubohiroya/turbowarp-plus-editor-git/smart-http` の `createGitSmartHttp` に、Git 設定から選んだ GitHub の HTTPS リモート、信頼済みの接続先（`mode` と `proxyOrigin`）、現在のプロキシセッションか `null` を返す関数を渡します。auth パッケージの `GitAuthProvider` を使えます。Git パッケージは必要なセッションの型だけを構造的に参照するため、読み取り専用パネルとアダプターは auth パッケージと独立してインストールできます。

```ts
const transport = createGitSmartHttp({
    remote: configuredRemoteUrl,
    connection: provider.connection,
    getSession: () => provider.getSession()
});
await git.fetch({fs, dir, remote: remoteName, ...transport});
```

同じ接続オプションで `git.fastForward` による fast-forward 限定の pull と、明示操作での `git.push`（`force: false`）を利用できます。作業ツリーの安全確認は呼び出し元で行います。アダプターは Git の設定を書き換えず、プロキシ専用の資格情報を固定の接続先にだけ送信します。Git の探索と RPC は `/v1/git/<owner>/<repo>.git/` に変換します。要求の上限は32 MiBで、呼び出し元から引き下げられます。成功時の応答は isomorphic-git にストリームで返します。`PUSH_OUTCOME_UNKNOWN` の場合は再送前にリモートの参照を確認します。

`npm test` はローカル Git のテストと、IPv4 ループバック上の `git-http-backend` を使うヘッドレステストを実行します。一時リポジトリとテスト用の資格情報を使用します。 [プロキシ・認証・CORS の契約](https://github.com/kubohiroya/turbowarp-plus-editor/issues/315)
