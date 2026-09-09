# OpenCode向けトークン効率化：ソース・実プロセス確認後の実装計画

2026-09-09。対象はこの `kiokuko-ai` checkout。DSH側の適用判断は含めない。

## 判断

**通常のMCPツール結果では、JSONの空白削減は有効な候補。ただし無条件minifyは採用しない。** 実OpenCodeで上限超過した1行JSONの本文プレビューが空になることを確認した。完全な結果は別ファイルへ保存されるが、モデルの次の入力には必要な末尾情報がない。

先に既存の復元・終了処理を修正した。効率化の製品実装はまだ追加していない。実験用表示変換はE2Eスクリプト内だけにある。

## 確認した対象

- OpenCode v1.18.25: `cb7d8b2f5e44876ef98b661dc10590c915af3a9f`
- OpenCode v1.18.26: `774cc7c1914e4329eefde5a669f938b0cf566661`
- 調査時のupstream dev: `830d5eb5354874105cc31599635a80c1662609e8`
- v1.18.25 / v1.18.26のmacOS arm64リリースを、既存互換manifestのSHA-512で照合して実行した。
- devはソース比較のみ。すべての将来の1.x版、実プロバイダー、他プラグイン構成を保証するものではない。

## 実際の処理経路

```text
設定のmerge → 同じconfig objectをpluginへ渡す → MCP接続・schema登録
 → モデルのtool call
 → tool.execute.before（元のargsを変更）
 → permission確認 → MCP実行・業務mutation確定
 → tool.execute.after（raw CallToolResultを変更）
 → text結合 → hostのbyte/line切り詰め
 → completed tool partのoutputへ保存
 → 次のprovider requestを保存済みoutputから構成
 → compaction → 必要な選択情報を保持 → 再起動後のtask_context_read
 → ordinaryはmemory_checkpoint、Ennoはfinish後のmeditation submitで終了
```

通常経路では `structuredContent` が別コピーとしてモデルへ加算されるわけではない。[tools.ts](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/tools.ts#L388)、[message-v2.ts](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/message-v2.ts#L273)

**Code Modeは別経路。** 子MCPにもbefore/after hookはあるが、その後は `structuredContent` を優先してプログラムへ返す。textの空白削減だけで同じ節約が得られるとは言えない。初回の評価・対応範囲から外す。[code-mode.ts](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/tool/code-mode.ts#L78)

MCP server instructionsも通常のsystem messageへ含まれる。tool descriptionから共通規則を移す候補は検討できるが、個別ツールの引数・前提・失敗時の操作は維持する。[system.ts](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/system.ts#L119)

## 先行修正：復元と終了

今回、次を製品コードで修正した。

1. `task_context_read` のexecutionをcompaction observerへ取り込む。新しいcontext revisionが0件でも、再起動後の次のcompactionに選択情報を渡す。
2. 成功したrun-bound `memory_checkpoint` とEnno終了で、対応runの継続情報・選択情報を両方除去する。別runの完了、error envelope、古いrevision、終了後に遅れて届いたreadで現在の状態を壊さない。
3. 先行pluginがcustom compaction promptを指定した場合、Kiokukoの追加contextをそのpromptにも入れる。OpenCodeはcustom promptがあればcontext配列を使わないため。

後続pluginがprompt全体を上書きすれば、先行pluginの情報を消せる。Kiokukoからその動作を強制的に禁止しない。custom promptを置換するpluginはKiokukoより前に置くか、後続側で既存promptを保持する契約が必要。

## E0：比較条件と計測

既存の `scripts/run-opencode-presentation-e2e.mjs` を基準にする。

- 実host・実MCP・実Kiokuko hook・ローカルfake providerでoff/onを比較する。
- raw text、structuredContent、保存tool output、次のprovider requestを照合する。
- 普通の結果、実hostのoversize結果、custom compaction prompt、host再起動、read復元、checkpoint、最終応答を確認する。
- token推定はtokenizer名・版・対象表現を記録し、byte削減と実usageを区別する。
- 実モデル比較ではtool schema、MCP instructions、AGENTS/Skills、親・子・compaction・title等の補助requestも集計する。見えないusageを0としない。
- fake providerのusage値は人工値。金額や実タスク全体の節約率には使わない。

## E1：正常結果の空白だけを削減

責務は値を変えない表示短縮。DB・MCP公開schema・structuredContent・receipt・routingは変更しない。

変更対象: `src/opencode/plugin.ts`、専用のoption parserと純粋なresult-presentation関数、そのテスト。

### 設定

- plugin tupleに `efficiency.compactJson` を追加し、初期値はoff。不正な機能optionは機能無効とする。既存runtime identity検証は維持する。
- setupは既存tupleの追加optionを保持する。この更新契約をテストする。MCP environmentへキーを増やさない。現行検査ではidentity conflictになる。
- **config hookで受け取る同じobjectへの参照を保持し、after hook時に実効上限を読む。コピーした古いsnapshotを使わない。** hostのConfig.getとplugin config hookは同じobjectを参照し、設定更新endpointはinstanceをdisposeする。
- 前版の「結果ごとにSDKで設定を読み、100 msでtimeout」は削除する。確認した実装では不要なreadと失敗条件を増やす。
- 初期対応では `tool_output.max_bytes` / `max_lines` の明示された正の安全整数を使用する。不明・不正なら元結果。未指定時のhost既定値を無条件に推測しない。50 KiB / 2,000行を使う設定例なら、確認した版の既定値と同じである。
- host版の検証は実行テストで `/global/health` を確認する。注入SDK v1に存在しない `client.global.health()` を実装の前提にしない。
- `disabled / applied / skipped(reason)` はローカル診断にする。モデルの結果へ毎回診断文を加えない。Code Modeではtext短縮をモデル入力の節約と計上しない。

[共有configとhook実行](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/plugin/index.ts#L244)、[hostの上限取得](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/tool/truncate.ts#L76)

### 適用条件・順序

1. 管理対象Kiokuko MCPの固定操作名だけを対象とする。他MCP、native task、名前のsuffix一致だけで対象を増やす処理は除外する。
2. 成功、単一text、添付なし、JSON object、textをparseした値とstructuredContentが一致する結果に限定する。
3. 解析上限を明示する。既存observerの上限は **256 KiB**。前版にあった「既存1 MiB」は誤記だった。
4. 既存execution検証 → 元結果をcompaction observerへ渡す → 候補を作る → byte・line両上限を確認 → textだけを最後に一度置換する。
5. 候補が大きすぎる、形が違う、処理が失敗した場合は元のtextをそのまま残す。元結果の再pretty化もしない。
6. 任意の表示処理だけを例外分離する。成功済みmutationに表示エラーをかぶせて失敗と返さない。既存のidentity/lease検証エラーは握りつぶさない。
7. 追加の非同期処理・タイマー・DB・LLMは不要。dispose後は適用しない。過去の保存messageを再整形しない。
8. 原結果自体が上限超過していた場合、fallbackは「元挙動を保持した」だけである。全情報到達・圧縮成功とは記録しない。

受け入れ条件: 候補製品コードを通したoff/onでE0を再実行する。現在の試作wrapper成功を製品option/parserの検証に流用しない。通常終了だけでなく、Enno全phase・再計画・モデル失敗・取消・重複結果・setup更新・pack/installも確認する。

## E2：説明文の整理

E1とは別の変更として評価する。

- 実provider requestの内訳から、MCP instructions、各tool description、管理対象AGENTS/Skillsの重複を選ぶ。
- requestId、revision、lease、承認条件、親だけがreport、terminal checkpoint等を契約一覧にし、必要な文を残す。
- JSON Schemaのrequired/enum/範囲/unionを削らない。
- 個別ツールだけが見える経路・permissionでinstructionsが除外される場合も確認する。
- 人間が書いたAGENTSや他pluginを変更しない。
- 実モデルで引数間違い、不要なread、retryが増えるなら採用しない。

## 初回から外す変更

- 選択済みexecutionのcandidates/presets省略。`task_context_read` は復元・再選択に使うため、別view契約なしで消さない。
- 記憶本文の要約、LLM圧縮、診断projection、参照カード化。minifyと異なり意味・復元・feedbackとの対応が変わる。
- `selectionReasons` の一括削除。矛盾・適用条件不一致等の警告を含む。
- 追加の永続usage台帳・presentation table・自動finalizer。必要性を計測してから別設計にする。
- Code ModeとDSHに同じ効果があるという推定。

## 採否

現行 / E1 / E1+E2を別群で比較する。モデル、reasoning、課題、記憶snapshotを固定し、cold/warmを分ける。短い通常作業、記憶多量、Enno、compaction、失敗復旧を含める。

モデル可視tokensが減っても、再読込・retry・compaction・子呼出し増加でタスク全体が増えれば不採用。小さなfixtureのbytes減少を全体の節約率と表現しない。実装状態・測定値・未検証範囲は [flow review](token-efficiency-flow-review.ja.md) に記録する。
