# OpenCode の Common Lisp ツール

通常の会話で `kiokuko_lisp` を使用できる。記憶の保存、task_prepare、Enno の選択は前提にしない。Common Lisp の処理系は SBCL であり、このパッケージは別の Lisp 処理系を実装しない。SBCL は OS のパッケージ管理で用意する（例: macOS `brew install sbcl`、Ubuntu `sudo apt-get install sbcl`）。版番号の固定はなく、実際の起動と評価を検証する。

`kiokuko-ai setup` が OpenCode に登録したプラグインの Node/CLI パスを実行に使う。OpenCode 自身の実行ファイルを Node と見なさない。SBCL が見つからない場合はその Lisp 呼び出しが失敗し、通常の会話や他のツールは続行できる。セットアップ済みプラグインの options に `lisp: { enabled: true, binary: "/absolute/path/to/sbcl" }` を追加すると実行ファイルを指定できる。`enabled: false` はユーザー設定での無効化であり、モデルの呼び出しでは解除できない。

入力は `code`（最大32768文字）と `timeoutMs`（50〜60000、既定10000）。SBCL のユーザー／システム初期化ファイルは読み込まず、HOME と一時ディレクトリを呼び出し側のものから隔離する。作業ディレクトリは現在の OpenCode プロジェクト。状態はセッションごとのプロセスに保持し、最大4セッションを同時に保持する。処理系でのエラー後は状態を保持して次の評価を受け付ける。タイムアウト、中断、出力上限、reset、disable、プラグイン終了では状態を破棄する。

ネイティブ権限 action は `kiokuko_lisp`。allow/ask/deny の判定は OpenCode が行い、このツールは許可を作成・代行しない。任意の Lisp はファイル・プロセス・ネットワークへアクセスできるため、権限設定はコード実行として扱う。必要なら OpenCode の permissions へ `{ "action": "kiokuko_lisp", "resource": "*", "effect": "ask" }` を設定する。許可済みの呼び出しでも引数、セッション、ターン、呼び出しIDが変われば実行しない。結果は未信頼の出力で、タスク成功や記憶保存の承認にはならない。

ユーザーのネイティブコマンド `/kiokuko-lisp-disable`、`/kiokuko-lisp-enable`、`/kiokuko-lisp-reset` は現在のセッションに作用し、待機中の実行受付も失効させる。disable は通常ツールを妨げない。enable で過去の実行受付は復活しない。設定レベルで無効の場合、enable では解除しない。

出力は標準／エラー出力と戻り値の合計をUTF-8で32 KiB以内に抑える。生のファイル記述子への出力も別の上限で監視する。POSIX supervisor は親の生存監視と OS の実際の親子関係から通常の子孫を終了する。SBCL が別プロセスグループを作る場合も対象にする。監視に必要な `/bin/ps` が使えない環境では Lisp 評価前に失敗する。任意のFFIや悪意ある daemon 化を封じる新たなOSサンドボックスではなく、ホストの権限・隔離を引き継ぐ。Windows のプロセス所有は未実装。

## Rust 評価器との関係

確認した既存 Rust 実装は `kiokuko-dsh/crates/guardrail` の `kiokuko-guardrail` で、opt-in の bounded TDD プロトコルを判定する限定 S 式評価器。DSH の guardrail adapter から配布済みバイナリを解決して `validate` / `check` を呼ぶ。汎用 Common Lisp の `defun`、状態更新、loop、ファイル操作を許可する処理系ではない。

現時点の kiokuko-ai はこの Rust 評価器を依存・配布物・OpenCode dispatch に接続していない。`kiokuko_lisp` の既定は SBCL で、Rust への自動切替も、Rust から SBCL への fallback もない。`binary` は SBCL 互換の起動引数を受ける処理系の指定であり、Rust guardrail のパスを指定して互換にする機能ではない。SBCL の試験成功は Rust 経路の検証を意味しない。Rust を AI の必須実行経路とする統合は未完了であり、別の実行経路を増やす前に guard 判定と汎用評価の役割を明示する必要がある。

## 検証対応

| 要件 | 永続試験 | 限界 |
|---|---|---|
| 会話→モデルのschema→dispatch→SBCL→結果→次のモデル要求 | `scripts/run-opencode-lisp-e2e.mjs`（既存配布物ホスト試験を拡張） | 固定応答モデル。実LLM品質は測定しない |
| process・localhost curl | 同上、実curlと隔離HTTPサーバー | 外部ネットワークや認証を使わない |
| 状態保持とセッション分離・エラー後の回復 | 同上、`tests/unit/lisp.test.ts` | プラグイン再起動後には永続化しない |
| 大量出力・タイムアウト後の回復 | 同上、worker試験 | 出力上限時は状態も破棄する |
| 中断・タイムアウト後の実子消滅 | worker試験と実ホストinterrupt APIで実sleep子PIDのESRCHを確認 | 実ユーザーのUI操作と悪意あるdaemon化は別途検証が必要 |
| disable/re-enable | 実ホストのネイティブコマンド・登録試験 | 実ユーザーのUI操作は模擬しない |
| 権限拒否 | 実ホストのdenyセッションでモデルへのschema除外とファイル効果0 | 人間のask承認クリックは未測定 |
| 引数変更・別セッション／ターン／呼出ID・受付再使用 | 登録済みcallbackと本物のhookを使う限定試験 | ホスト内部を書き換える攻撃の安全証明ではない |

`npm run test:e2e:opencode:lisp`、または `npm run verify -- --profile host` で配布物を実ホストへ導入する。`OPENCODE_BIN` と SBCL を用意する。main profile でもSBCLを宣言された試験能力に含め、ない場合に黙って合格させない。
