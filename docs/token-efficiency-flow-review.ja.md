# 実OpenCodeでの処理経路レビューと修正

2026-09-09 / Kiokuko開始時HEAD `701f136b07e581349688971324f83ca6adb5b625`

## 結果

OpenCodeの実ソースを取得して経路を追い、v1.18.25 / v1.18.26の実バイナリで検証した。**既存コードに復元・終了・custom compaction promptの問題があり、修正した。** 効率化機能そのものは製品コードへ追加していない。空白削減は比較試験のwrapper内だけで適用した。

前回の「再起動後に復元できた」「終端後のcontextが0件」というfixtureの解釈は不十分だった。返ったexecutionは検査していたが、新pluginのobserverがそれを取り込んだか検査していなかった。observerが空のままなので終端検査も通っていた。この検証不足を訂正する。

## 再現して修正した不具合

| 不具合 | 原因 | 修正と確認 |
| --- | --- | --- |
| 再起動後の次のcompactionで選択情報が抜ける | observerのtool名フィルターにtask_context_readがない | read結果のexecutionを観測。新revisionが0件でも次の実compaction requestにordinary選択があることを確認 |
| 完了済みrunの選択をcompactionへ持ち越す | memory_checkpointが観測対象外。Enno終了も継続レコードだけを除去 | 同じrunの成功した終端結果で選択・継続を両方除去。error envelope、別run、古いrevision、遅延readを回帰検査 |
| custom summary promptでKiokukoの復元情報が消える | hostがpromptを優先するとcontext配列を使わない | 先行pluginのcustom promptにもKiokukoの追加情報を連結。実providerが受けたcompaction promptを検査 |

該当ソース: `src/opencode/compaction.ts`、`src/opencode/plugin.ts`。

後続pluginがprompt全体を上書きする構成は別問題。Kiokukoのhook終了後まで情報保持を保証できないため、置換pluginを先に置くか、後続pluginが既存promptを保持する必要がある。

## OpenCodeソースで確定したこと

v1.18.25は `cb7d8b2f5e44876ef98b661dc10590c915af3a9f`、v1.18.26は `774cc7c1914e4329eefde5a669f938b0cf566661`。調査時devは `830d5eb5354874105cc31599635a80c1662609e8`。devは実行していない。

1. MCP実行 → raw結果へのafter hook → text結合・切り詰め → completed output保存 → model message変換の順。保存・provider requestの両方を確認する必要がある。[tools.ts](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/tools.ts#L388)
2. 通常MCP経路のモデル入力は保存済みtext。structuredContentの別コピーを二重課金する経路ではない。[message-v2.ts](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/message-v2.ts#L273)
3. config hookはhostのConfig.getと同じobjectを受け取り、hooksは順番にawaitされる。任意の表示処理がthrowすると上流へ伝わる。イベントhookは同様にはawaitされない。[plugin/index.ts](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/plugin/index.ts#L244)
4. 設定更新endpointはinstance disposalを要求する。結果ごとの100 ms設定readは必要ない。[config handler](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts#L17)
5. custom compaction promptがあるとcontext配列は採用されない。[compaction.ts](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/compaction.ts#L373)
6. MCP server instructionsはpermissionで適用可能な場合に通常のsystem messageへ入る。実provider requestでも確認した。[system.ts](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/system.ts#L119)
7. Code Modeは子MCP hookを呼ぶが、結果のstructuredContentを優先する。textだけの短縮に通常経路と同じ効果を見込めない。この経路はソース確認のみ。[code-mode.ts](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/tool/code-mode.ts#L78)

調べたMCP結果処理・config・compaction・truncationについて、v1.18.25からv1.18.26への差分は対象の挙動を変えていない。別の差分としてtool開始時刻の維持とproviderによるthinking除去の診断追加がある。将来版全体を検証済みとはしない。

## 実プロセス試験

`scripts/run-opencode-presentation-e2e.mjs` を追加した。個人設定・認証を使わず、一時HOME/config/data/cache/state、実Kiokuko MCP、実plugin、localhostのfake providerで実行する。Code Modeは明示的にoff。

```text
task_prepare → task_execution_select(ordinary) → 最終応答
 → 実compaction(custom prompt)
 → OpenCode終了・同じ保存データで再起動
 → task_context_read → 最終応答
 → 実compaction（選択を再確認）
 → memory_checkpoint(completed) → 最終応答
 → 実compaction（選択が残っていないことを確認）
```

各toolについて元textとstructuredContentのJSON値、hostの保存output、次のprovider requestのtool messageを照合する。v1.18.25 / v1.18.26それぞれで元表示とbounded minify試作表示を比較した。

両版で同じfixtureサイズになった。以下はbytesであり、実token usageではない。

| tool | 元表示 bytes | 試作表示 bytes | 減少 |
| --- | ---: | ---: | ---: |
| task_prepare | 27,568 | 20,214 | 26.7% |
| task_execution_select | 19,887 | 14,545 | 26.9% |
| task_context_read | 19,149 | 13,957 | 27.1% |
| memory_checkpoint | 485 | 406 | 16.3% |

追加の別sessionでは `tests/e2e/presentation-mcp-server.mjs` の人工大容量JSONを使い、hostの本物の切り詰めを確認する。

| 大容量結果 | 次のモデル入力 | hostの保存した完全結果ファイル |
| --- | --- | --- |
| pretty JSON | 冒頭の一部はあるが末尾directiveがなく、JSONとしてparse不能 | 完全なJSONと末尾directiveを保持 |
| 1行JSON | 本文プレビューが空で、末尾directiveもない | 完全なJSONと末尾directiveを保持 |

この結果は「上限超過も安全に最適化できた」という成功例ではなく、**無条件minifyとpretty fallbackだけでは全情報を届けられない反例**。

実行例（実行前にnpm run build、OPENCODE_BINはchecksum確認済み実行ファイル）:

```sh
OPENCODE_BIN=/absolute/path/to/opencode node scripts/run-opencode-presentation-e2e.mjs
KIOKUKO_PRESENTATION_EXPERIMENT=compact OPENCODE_BIN=/absolute/path/to/opencode node scripts/run-opencode-presentation-e2e.mjs
```

## その他の確認

- 新規回帰テストは修正前に2件失敗、修正後に成功。
- 隔離環境の8ファイル・67テストが全件成功。Ennoの実verifier付き完了ループ、再計画、revision/lease、execution hooks、plugin lifecycle等を含む。
- 実OpenCode v1.18.26の既存execution E2Eが成功。ordinary選択、全role、ネストしたworker委譲、再起動、permission、providerの401/404/429失敗を確認。
- pack → 一時prefixへのinstall → setup → 実OpenCode MCP接続 → active Enno continuation → cancel → durable receipt 1件、という既存host E2Eが成功。
- buildとtypecheckは成功。OpenCode境界検査は、開始時から存在する未追跡の `src/source-context/snapshot.ts:11` の除外directory名を検出して失敗した。今回の変更外なので削除・変更していない。機械可読結果は [token-efficiency-flow-review.json](token-efficiency-flow-review.json)。

検証途中の失敗も区別する。最初のlocalhost起動はsandboxが拒否したため、許可された隔離実行で再実施した。作成中の試験では誤ったHTTP endpointとtitle用の別requestの扱いを修正した。広範なテストの初回は66成功・1失敗で、未隔離のmanaged-file registryへアクセスしたことが原因。KIOKUKO_DATA_DIR等を一時directoryへ固定し、全67件を再実行して成功した。個人registryへの権限を広げて通したものではない。

## 計画への反映と限界

[修正版プラン](token-efficiency-plan.ja.md)では、先行修正を明記し、configの不要な毎回readを除き、Code Modeの扱いを分離した。初回は元のJSON値を保つ表示短縮だけ。candidates、記憶本文、警告、lease等の省略は別契約まで保留する。

fake providerは決められたtool callと応答を返す。確認したのは転送・保存・制御経路であり、実モデルの理解や品質、実タスク全体のtoken削減ではない。製品の新option/parserは未実装で、試作minifyをEnnoの全phaseに適用した実host試験も未実施。完成した効率化機能として配布可能とは判定していない。今回の修正はこのcheckoutにあり、ユーザーのインストール済みpluginへの反映・公開は行っていない。
