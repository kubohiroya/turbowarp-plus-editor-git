# TurboWarp Plus Editor Git

[English](README.md)

TurboWarp Plus Editor に「ローカル Git」パネルを追加します。リポジトリルートを一度選び、配下の sb3-toolchain v1 作品フォルダをパネルから開きます。作品の編集と保存には Editor の project-folder 接続を使います。

パネルは、Editor のメニューバーのブランチのボタンから開きます。`mountGitPanel({vm, document, host})` はパネルを組み込み、`{open(locale), refresh(), dispose()}` を返します。`renderBranchButton(createElement, {vm, locale})` は、`vm` に組み込んだパネルのボタンを描きます。パネルがないとき（ホストがローカル Git を出さないときなど）は何も描きません。ボタンはブランチのアイコン、現在のブランチ名、▾ を表示します。リポジトリを選ぶ前は **Git** と表示し、**リポジトリを選択…** に進みます。detached HEAD ではコミットの短い ID を、記録がまだないブランチではそのことを表示します。メニュー（`role="menu"`。矢印キー・Home・End・Enter で操作し、Escape でボタンに戻ります）には、ローカルブランチ（現在のブランチに印）、`origin` にあってローカルにないブランチの **… を作って切り替える**、**新しいブランチ…**（HEAD からブランチを作る小さな欄。既定で作ったら切り替えます）、**ローカル Git を開く** を並べます。ボタンとパネルは同じリポジトリと同じ操作を使うので、メニューからの切り替えも、パネルのボタンと同じく確かめ、同じ理由で断ります。結果はパネルを開かずに、画面下のスナックバーで示します。切り替えたときは「ブランチを切り替えました。」（パネルで作品フォルダを選んでいれば **作品を再読込** のボタン付き）、作っただけのときは「ブランチを作りました。」、断ったときはパネルと同じ理由を警告として **ローカル Git を開く** のボタン付きで示します。確認で取りやめたときは何も出しません。スナックバーは 6 秒で消えますが、ポインターを置いているときとフォーカスがあるときは残ります。Escape か閉じるボタンで閉じ、新しい結果は前のものを置き換えます。フォーカスは移さず、Tab でボタンに移れます。`localWrite` がなければ、メニューはブランチを示すだけです。ボタンは、パネルやほかのツールでのブランチの変更に追従します。パネルが見えていない間は、下のパネルの確認と同じ契機で、HEAD とブランチの参照だけを読みます。`BranchButton` は、状態をホストが持つ場合のためのボタン単体です。

ホストの横のパネル向けに、`renderHistoryView(createElement, {vm, locale})` は同じリポジトリの履歴のグラフを描きます。ブランチが動くたびに履歴を読み直し、ホストが書き込みを許すときはグラフのブランチの操作を出し、その結果を同じスナックバーで示します。リポジトリを選ぶ前は **リポジトリを選択…** を出し、`vm` にパネルがないときは何も描きません。`followChangeMarks(vm, directory, listener)` は、パネルが最後に読んだ `directory` 配下のファイルの Git の状態（`added`・`modified`・`deleted`・`untracked`、`directory` からの相対パスごと）を、フォルダのツリー向けに `listener` へ渡し、止める関数を返します。`changeMarks(changes, folder)` はその対応づけ単体です。

ステージ済み・未ステージ・未追跡の変更、現在のブランチ、HEAD、ローカルブランチと履歴を表示します。ファイルを選ぶとテキスト差分またはバイナリのサイズを確認できます。作品データ（`project.source.json`）は、ホストがブロックの描画関数を渡していればステージ・スプライト別、コード別のブロックで比べ、「テキスト」に切り替えると行単位の差分を表示します。ステージ・スプライトの見出しには、その版の現在のコスチューム（ステージは背景）のサムネイルを添えます。素材は比較する版から読みます（ステージ済みは HEAD とインデックス、未ステージはインデックスと作業ツリー、未追跡は作業ツリー、コミットは第一親とそのコミット）。素材のフォルダはその版の `sb3-source.json` の `assetsDirectory`（既定は `assets`）です。読めない版では名前だけを示します。コミットを選ぶと第一親との差分を表示します。作品を選んでいるときは、変更一覧と差分をそのフォルダに絞ります。

パネルを開いている間は、2 秒ごと、ウィンドウにフォーカスが戻ったとき、対応環境では `FileSystemObserver` の通知でリポジトリを確認します。HEAD、インデックス、`packed-refs`、`config`、現在のブランチの参照、選択中の作品フォルダのファイル（作品を選んでいない場合は作業ツリー全体、5,000 件まで）のサイズと更新時刻を比べます。変更があり、差分やコミットを開いていなければ読み直します。差分・コミット・プルリクエストのレビューを開いている間は表示を保ち、**再取得** を案内します。Git がメタデータをロックしている間は確認を待ちます。**作品を再読込** では、Editor の未保存編集を確認してから同じ作品を開き直します。Git の閲覧には読み取り専用のアダプターを使い、インデックスの更新を無効にします。読み取り中にファイルや Git の状態が変わった場合は、外部操作の完了後に再取得します。

ホストが `localWrite` を渡すと、現在のブランチで、ファイルを次の記録に入れる（ステージ）、次の記録から外す（アンステージ）、入れた変更を記録する（コミット）操作も使えます。pull と同じく、Git の書き込みを先にまとめ、置き換えるファイルを確かめ直してから適用し、途中で失敗したら適用した分を戻します。書き込むのは `.git/index`、オブジェクト、現在のブランチの参照だけで、作業ツリーと `.git/config` は書きません。コミットの作者はリポジトリの `user.name` と `user.email` を使い、足りない分だけ `localWrite.author()` で補います。補った値を設定には書きません。Editor に保存していない編集があるときは、ステージを待ちます。ブラウザーからは実行権限とシンボリックリンクが見えないため、Git が `100644` 以外のモードで記録しているファイルはステージできません。ほかのツールが `index.lock` を持っているときや、マージ・cherry-pick・revert・rebase の途中では操作しません。`localWrite` があると、左側の一覧にローカルブランチと **切り替える**、HEAD から新しいブランチを作る欄（作ったら切り替えることもできます）、`origin` から取得済みでローカルにまだないブランチの **作って切り替える** が出ます。切り替えは HEAD・インデックス・作業ツリーを同じ確かめ方で書き換えるので、作品を止め、未保存の編集と作業ツリーの変更をなくしておく必要があります。切り替え先のファイルが通常の `100644` でなければ切り替えません。`origin/<名前>` から作ったブランチには追跡の設定を書きません（`.git/config` は書かないため）。fetch・pull・push は同じ名前のリモートブランチを使います。開いている作品フォルダが切り替え先にないときは、先に確かめます。切り替えた後は **作品を再読込** で、そのブランチのファイルを開けます。`localWrite` がなければ、パネルは読むだけです。

履歴は、ローカルブランチ、`origin/*`、ブランチ未選択の HEAD からたどれるコミット（タグだけからたどれるものは除く）のグラフです。コミット時刻の新しい順に、子を必ず親より上に並べ、50 件ずつ表示して **さらに表示** で続きを読みます。レーンは [DoltHub のコミットグラフ](https://www.dolthub.com/blog/2024-08-07-drawing-a-commit-graph/) の考え方でパネル内で割り当て、SVG で描きます。各コミットはボタンで、ブランチ（`main`、`origin/main`、現在のブランチの印）、作者、日時を示します。Tab で一覧に入り、上下矢印（Home・End）でコミットを移り、Enter か Space で選ぶと第一親との差分を表示します。各コミットの **⋯** ボタン（またはコンテキストメニューキー、Shift+F10）で操作を開きます。**コミットの ID をコピー** は常に、`localWrite` があれば **ここからブランチを作る…**（名前を入れ、作ったら切り替えることもできます）、そのコミットにあるローカルブランチへの **切り替える**、ローカルにまだない `origin/<名前>` の **作って切り替える** が出ます。ブランチ一覧と同じ確かめ方・確認を通ります。ほかの場所に履歴を出すホストは、`Repository.history({limit, after})` でページを読み、`HistoryGraph` で描けます。`layoutHistory` はレーンの割り当てだけを行います。

File System Access に対応する Chromium 系ブラウザーが必要です。初版は通常の `.git` ディレクトリとファイル内容の変更を扱います。linked worktree、サブモジュール、シンボリックリンクは対象外です。作業ツリーの実行権限の変更はブラウザーから検出できません。Git に記録済みのファイルモードは表示します。バイナリアセットはサイズを示し、テキスト差分の生成には上限があります。

Node.js 26 で `npm ci` と `npm test` を実行します。Vite でライブラリとスタイルシート、TypeScript で型宣言を生成します。`npm pack` で Editor 用の配布物を作成します。`npm run test:browser` は、最小 editor runtime（`@kubohiroya/turbowarp-plus-editor-test-runtime`）の上で、ブランチのボタンのメニューとキーボード操作（実際のリポジトリでパネルと並べた場合も）、履歴グラフのキーボード操作と操作メニュー、比較ダイアログのブロックの描画を Chromium で試します。Editor が固定する VM と Scratch Blocks を使い、Editor のビルドは要りません。Editor では既定で有効です。起動 URL に `twPlusLocalGit=0` を指定するとパネルの接続を解除でき、ブランチのボタンも出ません。

パネルの構成とローカル Git の扱いは [duff](https://github.com/chigichan24/duff) を参考にしました。実装には [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) と [react-diff-view](https://github.com/otakustay/react-diff-view) を使用し、同梱依存のライセンスはビルド時の第三者ライセンス一覧に収録します。

## Smart HTTP アダプター

`test/smart-http-fixture.js` は、`git-http-backend` を IPv4 のループバックで動かす検証用のフィクスチャです。Node.js の標準モジュールだけを使い、利用側のブラウザーテストが同じ版を使えるよう配布物に含めます。

`@kubohiroya/turbowarp-plus-editor-git/smart-http` の `createGitSmartHttp` に、Git 設定から選んだ GitHub の HTTPS リモート、信頼済みの接続先（`mode` と `proxyOrigin`）、現在のプロキシセッションか `null` を返す関数を渡します。auth パッケージの `GitAuthProvider` を使えます。Git パッケージはこれらの型を auth パッケージから取り込みます。auth は省略可能な peer で、型を使う TypeScript の利用者だけがインストールすれば足ります。読み取り専用パネルとアダプターは auth パッケージが無くても動きます。

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

### 作品の初回 push

`./initial-commit` は `prepareInitialRepository` と `pushInitialRepository` を提供します。前者は選択した空のフォルダに作品・文書ファイルと `main` の初回コミットを作り、`origin`、追跡ブランチ、指定された Git 作者をローカル設定に記録します。再開用に、ホストはフォルダハンドル、操作の UUID、確認済みの GitHub リポジトリ ID と URL、初回コミットのファイル・作者・時刻、返されたコミット ID を保持します。

push には同じ GitHub リポジトリ ID に紐づく書き込みセッションを使います。ローカルのコミットとリモートの参照を確認し、空のリポジトリでは Git の参照作成条件付きで push します。リモートに記録済みのコミットがある場合、再開時はパックを再送せずローカルの追跡参照を整えます。作成途中の状態と完了は `.git/` 内に記録します。途中からの再開には同じ入力を使います。ファイルの内容が変わった場合や一致する記録がない場合は、フォルダの内容を確認し、新しい操作には空のフォルダを選びます。

### 接続を使って PR を読む

GitHub 接続が接続済みのとき、PR レビューは PR の中身を GitHub API ではなく同じ Git Smart HTTP の経路で読みます。非公開リポジトリの PR も読め、中身の取得には API の利用上限を使いません。`repository.fetchPullRequest(number, getSession, guard, signal)` は GitHub の `refs/pull/<番号>/head` を、すべてのブランチと一緒に fetch します（広告と pack の 2 件）。フォークからの PR も base のリポジトリのこの ref で取れます。ブランチは fetch と同じく `refs/remotes/origin/*` を更新します。`repository.readPullRequest(head, {sha, branch})` は、手元の Git オブジェクトから、ベースとの merge base と head を比べます。変更されたパス（内容が同じ移動は名前の変更として対にします）、`project.source.json` ごとのブロック差分、同じコミットから読むサムネイルを返します。プロキシの経路と GitHub App の権限は変えません。

取得した head は `refs/pull/origin/<番号>/head` に置き、同じ PR を取得するたびに置き換えます（head は force-push されることがあるため）。`refs/heads`・`refs/remotes`・`refs/tags` の外にあるので、Git CLI では `git for-each-ref refs/pull` と `git log --all` に出て、`git branch -a` と `git tag` には出ません。`refs/remotes/origin/` の下に置くと GitHub のブランチに見え、`git fetch --prune` で消えます。ref を作らずに取得すると、オブジェクトがどこからも参照されず `git gc` で消えます。要らなくなった ref は `git update-ref -d refs/pull/origin/<番号>/head` で消せます。取得で書くのはオブジェクトと ref だけで、fetch・pull と同じ一時領域とロック（`tw-plus-git-mutation`）を通します。作業ツリー、インデックス、HEAD、`.git/config` は書きません。

一覧と、公開リポジトリの題名・本文・ベースは、引き続き公開 API から読みます（PR ごとに 1 件）。API のベースのコミットが取得で手元に来ていればそれと比べ、なければベースのブランチと比べます。非公開リポジトリではベースのブランチが API でしかわからないため、GitHub の既定のブランチと比べ、別のブランチを選べるようにします。失敗したときは、未接続またはセッション切れ、接続にリポジトリを読む権限がない、その番号の PR がない、ネットワーク、のどれかを示します。接続しているときに中身を公開 API から読むことはありません。接続していないときは、従来どおり公開 API を読みます。選んだブランチにすでにマージされた PR は、API がベースのコミットを返さない限り、変更なしと表示されます。

#### PR の版を手元で動かす

`localWrite` があるとき、接続で読んだ PR に「pr/&lt;番号&gt; として手元で開く」が出ます。取得した head にローカルブランチ `pr/<番号>` を作り（`pullRequestBranch(number)`。`refs/pull/origin/<番号>/head` はそのまま残します）、ブランチ一覧と同じ確認付きの経路で切り替え、選んでいる作品フォルダをそのブランチから開き直します。これで PR の版を Editor で実行できます。作品の実行中、Editor に保存していない編集があるとき、作業ツリーに変更（ステージ済み・未ステージ・未追跡）があるときは行わず、何も書きません。開いている作品フォルダが PR にないときは、先に確かめます。`pr/<番号>` がすでに同じコミットにあるときは、それに切り替えます。別のコミットを指しているとき（そのブランチで記録した、または PR が更新された）は、ブランチを動かさずに断ります。「ローカルの変更」でそのブランチに切り替えるか、Git で名前を変えるか消して（`git branch -m pr/<番号> <名前>`、`git branch -D pr/<番号>`）、もう一度開いてください。公開 API で読んだ PR は Git のオブジェクトが手元にないため、ボタンを出しません。`localWrite` がないときも出しません。

#### レビューを送る

「レビューの送信を許可する」を付けて接続したとき（auth パッケージの任意の `review` の許可。push とは別）、接続で読んだ PR では、各コードの変更の下にコメント欄が、末尾に「レビューを送る」が出ます。全体のコメントと「コメント」「承認」「修正を依頼」を選べます。ホストは `connection` に `reviewGranted()` を渡します。レビューはプロキシの GitHub API の経路（`/v1/github/<owner>/<repo>/`、`createGitHubReviewApi`）で送り、GitHub のトークンとノード ID はプロキシの中に留まります。クライアントが送るのは、プロキシのセッションの Bearer、`Review-Submit-Id`、PR 番号、取得した head、書いた内容だけです。GraphQL の経路では、1 つずつ順に送ります。取得した head への保留中のレビュー、コードのコメントごとに `project.source.json` へのファイル単位のスレッド（50 件まで）、最後に公開です。PR の変更に入っていないファイル、51 件目以降、GitHub が拒んだファイルへのコメントは、ファイルとコードの見出しを付けてレビュー本文に入れます。送る前に、どちらに何件入るかを表示します。GraphQL の経路が `404 GITHUB_API_UNAVAILABLE` のときは、全部を本文に入れて REST のレビュー 1 件で送ります。どちらの経路もなければ、送信は出しません。

公開の前に失敗したときは保留中のレビューを破棄し、何も公開しません。破棄に失敗したら「GitHub に保留中のレビューが残っています」と示し、破棄し直せます。公開を拒まれたときは、スレッド付きの保留中のレビューを残し、直して送り直すか破棄できます。結果がわからないとき（応答が届かない、重複、`502`・`504`）は自動で再送せず、「送信されたか確かめる」でプロキシの記録を読みます。利用上限では待ち時間を示し、その間ボタンを止めます。下書き（内容、結果、送信中の送信 ID）は GitHub がレビューを受け取るまで、失敗や再読み込みをまたいで `turbowarp-plus-git:review-draft:<owner/repo#番号>` に保存します。トークン、プロキシのアドレス、GitHub の ID は入れません。`sendReview`・`checkReview`・`discardReview`・`planReview` と下書きの関数は、React から分けて `./project-source-diff` から使えます。

元のブランチはそのまま残ります。戻るときは「ローカルの変更」でそのブランチに切り替えます（開いた後に、パネルがブランチ名を示します）。`pr/<番号>` は追跡の設定を持たない通常のローカルブランチです。パネルは消さず、pull と push もほかのブランチと同じに扱うので、意図しない限り push しないでください。要らなくなったら `git branch -D pr/<番号>` で消せます。

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

確認済みの印は、`rememberAs`（`owner/repo#42` など）を渡すと、ブラウザーのストレージにコードの内容と組で保存します。パネルを閉じても Editor を再読み込みしても残り、PR の head が変わると、内容が変わったコードの印だけが外れます。作品ファイルと Git には書きません。`rememberAs` がないときは、表示中のレビューだけの状態です。ローカル Git パネルの PR 一覧は、リポジトリ名と PR 番号を渡します。PR 本文・ファイル差分の取得は呼び出し側が担当します。`commentAs`（`owner/repo#42` など）を渡すと、コードごとにレビューの下書きへ入るコメント欄を出します。

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

## コミットをプルリクエストとして送る

`/pull-request-queue` の `createPullRequestQueue` に、利用者が確認したリポジトリ ID、対象ブランチ、コミット OID、PR と Issue の内容を登録します。固定したコミットは `pushPublicationCommit` でジョブ専用の `tw-plus/pr-…` ブランチに送ります。その後のローカル編集やコミットは別の変更として扱われます。

キューは処理前に進捗を記録し、Issue・PR の作成応答が途切れた場合は、本文のジョブ識別子と PR の head を照合します。`advance` は一段階進め、`watch` は CI や非同期マージを待ちます。チェックが無い場合は明示の確認を待ちます。GitHub で対象 PR のマージを確認してから、選択された Issue をクローズします。

`/github-publication-host` は、GitHub のアクセストークンを保持するホスト向けです。利用者が承認した操作ごとに、照合済みリポジトリ ID と必要な権限を持つ短期トークンを渡します。ホストはマージ直前に head、base、差分と CI・レビュー条件を照合し、GitHub へ head SHA とルールをバイパスしない設定を送ります。ネイティブのスタック PR は通常 PR の自動マージ対象外です。

Cloudflare 接続では `createGitHubReviewApi` の `publicationStatus(number, repositoryId)` が Worker から head、base、CI とレビューの状態を取得します。Worker で `checks-read` を有効にし、通常の Git セッションを同じリポジトリ ID にひもづけます。キューで利用する際は、返された head と base を登録済みの情報と照合します。

## 公開

npm への公開は `.github/workflows/release.yml` が行う。`package.json` の版と同じ `v<版>` のタグを
`main` のコミットに push すると、テストを通したうえで npm に入れるアーカイブを作り、GitHub Release に
添付してから npm に公開し、`latest` と `next` をその版に向ける。認証はトークンではなく npm の
Trusted Publisher（OIDC）で、provenance を付けて公開する。npm 側の設定にはこのワークフローの
ファイル名をそのまま登録するため、改名するときは npm の設定も合わせる。
