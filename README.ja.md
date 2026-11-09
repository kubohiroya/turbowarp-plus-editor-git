# TurboWarp Plus Editor Git

[English](README.md)

TurboWarp Plus Editor のファイルメニューに、読み取り専用の「ローカル Git」を追加します。リポジトリルートを一度選び、配下の sb3-toolchain v1 作品フォルダをパネルから開きます。作品の編集と保存には Editor の project-folder 接続を使います。

ステージ済み・未ステージ・未追跡の変更、現在のブランチ、HEAD、ローカルブランチと直近50件の履歴を表示します。ファイルを選ぶとテキスト差分またはバイナリのサイズを確認できます。作品データ（`project.source.json`）は、ホストがブロックの描画関数を渡していればステージ・スプライト別、コード別のブロックで比べ、「テキスト」に切り替えると行単位の差分を表示します。ステージ・スプライトの見出しには、その版の現在のコスチューム（ステージは背景）のサムネイルを添えます。素材は比較する版から読みます（ステージ済みは HEAD とインデックス、未ステージはインデックスと作業ツリー、未追跡は作業ツリー、コミットは第一親とそのコミット）。素材のフォルダはその版の `sb3-source.json` の `assetsDirectory`（既定は `assets`）です。読めない版では名前だけを示します。コミットを選ぶと第一親との差分を表示します。作品を選んでいるときは、変更一覧と差分をそのフォルダに絞ります。

パネルを開いている間は、2 秒ごと、ウィンドウにフォーカスが戻ったとき、対応環境では `FileSystemObserver` の通知でリポジトリを確認します。HEAD、インデックス、`packed-refs`、`config`、現在のブランチの参照、選択中の作品フォルダのファイル（作品を選んでいない場合は作業ツリー全体、5,000 件まで）のサイズと更新時刻を比べます。変更があり、差分やコミットを開いていなければ読み直します。差分・コミット・プルリクエストのレビューを開いている間は表示を保ち、**再取得** を案内します。Git がメタデータをロックしている間は確認を待ちます。**作品を再読込** では、Editor の未保存編集を確認してから同じ作品を開き直します。Git の閲覧には読み取り専用のアダプターを使い、インデックスの更新を無効にします。読み取り中にファイルや Git の状態が変わった場合は、外部操作の完了後に再取得します。

File System Access に対応する Chromium 系ブラウザーが必要です。初版は通常の `.git` ディレクトリとファイル内容の変更を扱います。linked worktree、サブモジュール、シンボリックリンクは対象外です。作業ツリーの実行権限の変更はブラウザーから検出できません。Git に記録済みのファイルモードは表示します。バイナリアセットはサイズを示し、テキスト差分の生成には上限があります。

Node.js 26 で `npm ci` と `npm test` を実行します。Vite でライブラリとスタイルシート、TypeScript で型宣言を生成します。`npm pack` で Editor 用の配布物を作成します。`npm run test:browser` は、最小 editor runtime（`@kubohiroya/turbowarp-plus-editor-test-runtime`）の上で、比較ダイアログのブロックの描画を Chromium で試します。Editor が固定する VM と Scratch Blocks を使い、Editor のビルドは要りません。Editor では既定で有効です。起動 URL に `twPlusLocalGit=0` を指定するとパネルの接続を解除できます。

パネルの構成とローカル Git の扱いは [duff](https://github.com/chigichan24/duff) を参考にしました。実装には [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) と [react-diff-view](https://github.com/otakustay/react-diff-view) を使用し、同梱依存のライセンスはビルド時の第三者ライセンス一覧に収録します。

## Smart HTTP アダプター

`test/smart-http-fixture.js` は、`git-http-backend` を IPv4 のループバックで動かす検証用のフィクスチャです。Node.js の標準モジュールだけを使い、利用側のブラウザーテストが同じ版を使えるよう配布物に含めます。

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

receive-pack の POST ごとに UUID v4 を発行し、`Git-Push-Id` に設定します。ブラウザーが同じ要求を再送すると ID が維持されます。プロキシの `409 PUSH_DUPLICATE` は `PUSH_OUTCOME_UNKNOWN` に変換し、呼び出し元で fetch による参照の照合を行います。

`npm test` はローカル Git のテストと、IPv4 ループバック上の `git-http-backend` を使うヘッドレステストを実行します。一時リポジトリとテスト用の資格情報を使用します。 [プロキシ・認証・CORS の契約](https://github.com/kubohiroya/turbowarp-plus-editor/issues/315)

Editor のホストが接続設定を渡すと、ローカル Git パネルで、現在のブランチと既存の GitHub HTTPS リモート `origin` に対して fetch、fast-forward pull、push ができます。push には接続時の明示許可が必要です。fetch は Git のメタデータを更新します。pull は作品を停止し、作業ツリーがクリーンで通常の実行権限なしファイルだけを扱える場合に使えます。変更を一時領域に組み立て、ローカルの状態を再確認してから適用します。pull 後はパネルから作品を再読込できます。

## 作品ソースのブロック差分

`@kubohiroya/turbowarp-plus-editor-git/project-source-diff` の `createProjectSourceDiff` に、変更前後の `project.source.json` の文字列を渡します。戻り値を `project.diff` として保存できます。生成した unified diff には全行の文脈が入るので、ビューへ渡すときは `.diff` だけで変更前後を復元できます。既存のコンパクトな Git 差分を使う場合は、`beforeSource` に対応する変更前の JSON も渡します。

```tsx
import {
    createProjectSourceDiff,
    createScratchBlocksDiffRenderer,
    ProjectSourceBlockDiff
} from '@kubohiroya/turbowarp-plus-editor-git/project-source-diff';
import '@kubohiroya/turbowarp-plus-editor-git/style.css';

// These adapters use the host's existing Scratch Blocks and Scratch VM.
const renderBlock = createScratchBlocksDiffRenderer({
    getBlockly,
    deserializeBlocks,
    createBlockContainer: () => new VMBlocks()
});

const patch = createProjectSourceDiff(await beforeFile.text(), await afterFile.text());
// Save a .diff by writing patch to a file or creating a Blob from it.
const diffFile = new Blob([patch], {type: 'text/x-diff'});

<ProjectSourceBlockDiff patch={patch} renderBlock={renderBlock} locale="ja" />;
```

`getBlockly` は読み込み済みの Scratch Blocks、`deserializeBlocks` と `VMBlocks` はホストの Scratch VM が提供するものを使います。表示用の VM ブロックコンテナーとワークスペースは差分ごとに新しく作ります。ホストに定義がない拡張ブロックやプレビュー非対応の mutation には描画不可と表示します。

ブロックはステージまたはスプライト名とブロック ID で照合します。変更されたブロックとその入力を読み取り専用で並べ、追加・削除・入力値などの注釈を付けます。「元のコード内で強調」を選ぶと、つながったコードの中で対象を確認できます。オレンジの枠は変更された入力欄やフィールドを示します。画像・音声など、コード以外に変更があればその旨を表示します。切り戻す場合は、このコンポーネントの呼び出しを外します。

### 編集画面のブロックと照合する

`locateBlock` に `createScratchBlocksDiffLocator(resolveWorkspace)` を渡すと、各版のプレビューに「編集画面で強調」が出ます。`resolveWorkspace` は指定された `version`、対象のステージ・スプライト、ブロック ID に対応するワークスペースを返します。ホストは作品と版を照合し、必要なら対象を切り替えてブロックが表示されるまで待ちます。一致する編集画面がなければ `null` を返します。削除済みのブロックは変更前のコードを展開して確認できます。

ロケーターは一致したブロックを中央に移動し、差分ビューと同じ入力欄やフィールドを強調します。別の差分の選択・差分ファイルの切り替え・ビューの終了で強調を解除します。

### 表示枠

変更前・変更後の各枠は読み取り専用の作業領域です。Editor のコードエリアと同じ倍率でブロックを描き、枠の高さをブロックに合わせます（160〜420 px。枠の右下をドラッグすると高くできます）。ドラッグとスクロールバーで動かし、拡大縮小ボタンと Ctrl＋ホイール（トラックパッドのピンチ）で拡大縮小します。ホイールだけの操作は、レビュー全体のスクロールに使います。同じ比較の枠は拡大率・高さ・スクロール位置を連動させ、「変更前と変更後を連動して動かす」で切り離せます。

`createScratchBlocksDiffRenderer` の `attachNavigation(workspace, blockly, watermark)` に、ホストのコードエリアと同じ操作部品を付ける関数を渡せます。TurboWarp Plus Editor は右下にコスチュームのサムネイル、ミニマップ、拡大縮小ボタンの列を並べます。`watermark` はその版の現在のコスチュームを表示する要素で、素材を読む `loadAsset` があるときに渡します。`attachNavigation` がなければ Scratch Blocks の拡大縮小ボタンを使います。独自の描画関数は `{dispose, view}` を返すと、`createPreviewSync` による連動に加われます。

## PR 単位でレビューする

同じエントリの `ProjectSourceReview` は、作品ファイルを複数含む変更セットをまとめてレビューするためのビューです。`title`・`description`・`verification` には PR 作者が記した目的と確認観点を渡します。`files` に作品ファイルの `{path, patch, beforeSource?, loadAsset?}` や、関連ファイルの `{path, status, summary?}` を渡します。ブロックを描画する `renderBlock` は個別差分ビューと共通です。

```tsx
<ProjectSourceReview
    title="ゲーム開始の合図をそろえる"
    description="ステージからの合図を受けて、プレイヤーが動き出すようにします。"
    verification={['開始時に合図が一度だけ送られること', '合図を受けるまでプレイヤーが待機すること']}
    files={[
        {path: 'game/project.source.json', patch},
        {path: 'game/assets/start.svg', status: 'updated', summary: '開始画面の案内を更新'}
    ]}
    renderBlock={renderBlock}
    locale="ja"
/>
```

作品ファイルはステージ・スプライトごとに整理し、変更のあったコードだけを比較項目にします。ひとかたまりのブロックは Editor のタブ名と同じく「コード」と呼び、見出しには「コードの変更 · N か所」と示します。各項目は帽子ブロックの名前で呼びます。分割・結合したコードも、両版に共通するブロック ID を使って一項目にまとめます。展開すると前後のコードをブロックで表示し、編集箇所を枠で示します。変数、コスチュームなどの変更は別に示します。関連ファイルの要約はホストから渡した情報を表示します。

`loadAsset` は `({version, md5ext, signal}) => Promise<Blob | null>` の形で、`version`（`before`／`after`）の作品フォルダの素材を読みます。渡すと、ステージ・スプライトの見出しにその版の現在のコスチューム（ステージは背景）のサムネイルを添えます。変更前後でコスチュームが違えば「変更前 → 変更後」と並べます。関数がないとき、または画像を読めないときは名前だけを示します。`createGitHubPullRequests` が返す作品ファイルには、変更前（マージベース）と変更後（head）の素材を raw.githubusercontent.com から読む `loadAsset` が付きます。この読み込みは GitHub API の利用上限を消費せず、1 ファイル 10 MiB までです。

確認済みの印は表示中の比較データに紐づくローカル状態です。PR 本文・ファイル差分の取得と GitHub へのレビュー送信は、呼び出し側が担当します。

### 2 つの版を直接比べる

`ProjectSourceComparison` は、同じ比較を 1 つの作品ファイルについて表示します。変更前と変更後の `project.source.json` の文字列を `before`・`after` に渡します。ファイルがない側は `null` とし、すべてのコードを追加または削除として示します。`loadAsset` は `ProjectSourceReview` の作品ファイルと同じで、見出しのサムネイルに使います。ローカル Git パネルは作業ツリーと履歴の差分にこのビューを使います。

```tsx
<ProjectSourceComparison before={beforeText} after={afterText} renderBlock={renderBlock} locale="ja"
    fallback={<pre>{patch}</pre>}/>
```

どちらかの版を作品として読めないときは理由を示し、`fallback` を表示します。`fallback` がなければエラーだけを示します。

### 比べてから選ぶダイアログ

`openProjectComparison(document, options)` は、見出しの付いた複数の比較を 1 つのモーダルに並べ、利用者に操作を選んでもらいます。各 `sections` は `ProjectSourceComparison` と同じ `before`・`after` を取ります。選ばれた `actions` の `id` で解決し、閉じるか Escape では `null` で解決します。最初の操作にフォーカスを置くので、失われるものが少ない操作を先に並べます。作品フォルダは、未保存の編集があるときに「あなたの未保存の編集」と「フォルダでの変更」を並べるのに使います。

```ts
const choice = await openProjectComparison(document, {
    title: '外部の変更と未保存の編集',
    sections: [{title: 'あなたの未保存の編集', before: base, after: edited}, {title: 'フォルダでの変更', before: base, after: disk}],
    actions: [{id: 'keep', label: '編集を残す'}, {id: 'discard', label: '編集を破棄してフォルダから読み込む'}],
    renderBlock, locale: 'ja'
});
```

## 公開

npm への公開は `.github/workflows/release.yml` が行う。`package.json` の版と同じ `v<版>` のタグを
`main` のコミットに push すると、テストを通したうえで npm に入れるアーカイブを作り、GitHub Release に
添付してから npm に公開し、`latest` と `next` をその版に向ける。認証はトークンではなく npm の
Trusted Publisher（OIDC）で、provenance を付けて公開する。npm 側の設定にはこのワークフローの
ファイル名をそのまま登録するため、改名するときは npm の設定も合わせる。
