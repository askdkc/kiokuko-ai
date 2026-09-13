# Akinatorのプロフィール記憶

現在の依頼で対象や成功条件が不足するときに、過去のプロフィールを参考候補として返します。現在の入力を優先し、質問は任意の補助情報として扱います。Skill不足で通常の作業を止めません。

## 有効化

既定は `off` です。利用する設定を環境変数で渡し、OpenCode／MCPプロセスを新しく起動します。

```bash
KIOKUKO_AKINATOR_MEMORY_MODE=suggest opencode
```

| モード | 動作 |
|---|---|
| `off` | プロフィール検索を省略。状態だけの読込みとタグ索引検索は有効。 |
| `shadow` | 評価用の候補参照と、resolveならtargetを採用するかの判定を上限付きで保存。プロフィールや表示するヒントは変えない。 |
| `suggest` | 不足フィールドごとに最大3候補を `intake.memoryHints` で返す。 |
| `resolve` | 現在の明示パス、repository内の現在位置、完了した出典run、元のユーザー／client由来、完全で競合のない検索が一致した場合だけ、不足するtargetも補完する。 |

不正な設定値は警告を返して補助機能を無効にします。対象パスの権限やリソース不足で確認できない場合も、理由を返して補完なしで続行します。DB破損やrepositoryの不一致を候補なしとして扱いません。環境変数の変更を反映するにはプロセスを再起動してください。offへの切替でヒントと新しい採用を止めても、既存runの監査用プロフィールは書き換えません。off／shadowで始めたrequestは、再試行でも初回設定を維持します。

初期版の自動補完は、`Fix src/alpha.ts` や `src/alpha.ts を修正` のような単一パスへの短い操作指示に限ります。否定・例示・複数対象・長い自然文は候補提示に留めます。ファイル確認はDB書込みロックの外で行い、トランザクション内でrepositoryの対応関係と正規プロフィールを再検証します。

成功条件、制約、作業種別、過去の許可は自動採用しません。repository外、存在しないパス、曖昧な名前、未完成の索引、打切り検索からtargetを自動採用しません。類似度は順位付けの値であり、確率や操作許可ではありません。

## 既存の履歴

新しいready状態のintakeは、検索投影を自動更新します。古い履歴も取り込む場合は、このリポジトリのcheckoutから次を実行します。最初は明示的に指定した検証用DBかバックアップDBで確認してください。

```bash
npm run memory:backfill:akinator -- --database /absolute/path/to/test.sqlite3
```

`--workspace project:example` で対象を絞り、`--batch-size 100` でバッチ件数を指定できます。既存の通常ファイルを必須とし、現行migrationを適用して、小さいバッチごとにcommitします。中断後は続きから再開できます。通常利用中のDBを暗黙に選びません。稼働中DBはKiokukoのバックアップ手順を使い、SQLite本体ファイルだけをコピーしないでください。

検索投影とFTSは再構築できます。 `--rebuild` を指定すると対象workspaceの検索投影と再開位置をリセットして取り込み直します。初期採用の監査記録は保持します。取り込みが未完了なら部分的な検索であることを返し、targetの自動採用には使いません。プロフィール本文を通常の記憶entryへ追加しません。

## 再試行・復元・削除

新規requestごとに、既存runのトランザクション内で初期判断を一度保存します。履歴や設定の変化でrequest hashは変わりません。再試行で後のユーザー回答を巻き戻しません。compaction後の `task_context_read` も含め、候補の表示直前に出典を再検証します。

不変のcontext revisionには候補本文のコピーを残さず、参照だけを保存します。更新・消失・削除された出典の値は復元しません。出典runのpurgeで検索投影と、その出典を参照する採用記録の候補を削除します。既に採用された現在のプロフィールは、そのrunの監査データとして残ります。その内容も消す場合は採用先runもpurgeしてください。バックアップの保持は別途管理します。

migration 007で検索投影と採用記録のテーブルを追加します。ledger archive version 2は初期判断を含み、読込側はversion 1にも対応します。復元後の検索投影は明示的にbackfillしてください。modeをoffにしても、旧バイナリで新schema／archiveを読めるわけではありません。downgradeには更新前のバックアップを使い、`memory` の由来をユーザー回答へ偽装しないでください。

## 検証

```bash
npm run typecheck
node scripts/run-tests.mjs tests/unit/profile-memory-resolver.test.ts tests/integration/akinator-memory-probe.test.ts
npm run test:evaluation:akinator
npm run test:benchmark:akinator -- --entries 10000 --profiles 1000 --samples 10 --prepare-samples 1
```

評価・計測結果は標準出力に表示します。保存する場合は `--output /tmp/akinator-report.json` を指定してください。指定がなければレポートファイルは作成しません。fixtureに個人の履歴は含めません。benchmarkは従来のタグ全件走査を再現し、SQL実行回数・本文読込数・ローカル検索時間・同期prepareの時間・書込みロックの保持時間を比較します。バックグラウンド検索完了までの時間、実運用の訂正率、タスク全体のトークン削減は証明しません。

候補IDは64件、lexical検索は3段階、ヒントはフィールドごとに3件までです。probeから追加のLLM・embedding・ネットワーク呼出しは行いません。SQLiteは同期処理のままで、候補数の制限はSQLの強制timeoutではありません。Worker／Goの導入は含みません。
