<!-- KIOKUKO MANAGED STANDARD SKILL: coding-ideal-routine-skill -->

# 製品別の条件付き契約

対象の repository と現在の実行ホストが該当するときだけ、この節を読む。
以下は 2026-10-12 に観測した source の案内であり、API の固定仕様ではない。
実行前に対象版の AGENTS.md、公開 schema、status と docs を優先して照合する。
source を調査する Codex と、その source が実装する DSH／OpenCode のホスト契約を混同しない。

## askdkc/kiokuko-dsh

package 名は `kiokuko-dsh`。DSH plugin の入口と version は package／lockfile／fixture／実ホストをそれぞれ確認する。別製品 dsh-cli のテストは代用にならない。

**現在のホストが対応する coding workflow を実際に提供するとき**：

1. 読取調査後、最初の実装効果前に `coding_workflow status` で revision と有効な入力を確認する。
2. 現行 schema の `coding_workflow_apply`（`propose`／`revise`）へ Goal・依存付き項目・項目条件・別の最終 Goal 条件を登録する。`expectedRevision` は現在値。Enno では既存 ideal／plan から投影する共通表示を使い、競合 Goal を作らない。
3. ホストのタスク単位 Lisp 選択を使う。人間の未回答・閉じる・切断は pending。モデルが回答を代行したり、既存 enable 設定を回答に置換したりしない。pending 中は読み取りと対話を続け、実装効果を開始しない。
4. no は同じ条件を通常ツールで進め、Lisp を勧め直さない。yes は対応 runtime の起動結果を確認し、失敗は具体的な runtime blocker として回復する。契約外で勝手に no へ変更しない。
5. `task_completion status/bind` で criterion と実行方法を対応付けてから、利用可能な owned tools／選択した Lisp の実子プロセスを使う。host receipt と meaningful assertion を確認する。モデル申告 JSON は host proof ではない。
6. 全項目後に最新 artifact を使う新しい最終 Goal チェックを実行する。scope 変更・取消・revision／runtime／source 変更の失効を status で確認し、実状態の未達を文章で上書きしない。

Codex の source 編集でこの API が利用できない場合、存在を捏造せず共通手順の Goal／検証表で進める。現在の適用可能な repository 指示が実際に必須とする gate は守る。legacy run に架空の workflow や Lisp 選択を作らない。

現物参照：`docs/coding-workflow.md`、`src/dsh/coding-workflow/{host,service,contracts}.ts`、`src/dsh/task-completion.ts`、`src/dsh/task-completion-host.ts`、`tests/dsh/unit/coding-workflow/workflow.test.ts`、`tests/dsh/e2e/coding-workflow-native.test.ts`。

配布と CI の関連入口：`scripts/pack-check.mjs`、`src/dsh/standard-skills.ts`、`src/dsh/modules/resources.ts`、`tests/dsh/skill-delivery/`、`.github/workflows/{ci,code-intelligence}.yml`。必要な契約に応じて `pack:check`、`test:skill-delivery`、`test:modules`、native／Lisp／Web 専用 checks を選ぶ。REQUIRE flags と DSH fixture version は対象 job から取得する。CI の FORCE_COLOR と local の差異が出力に関係するなら同じ条件で再現する。

## askdkc/kiokuko

package／CLI は `kiokuko`。source、installed CLI、Codex MCP、hook と既存接続の実体を区別する。

- 現在の `AGENTS.md`、`skills/kiokuko-soul/SKILL.md` を読み、利用可能な capability と現行 run 契約だけを使う。task_prepare／answer、verification 定義・記録、completionReady などは実 schema と戻り値に従う。
- missing memory enrichment、typed recoverable conflict、authorization／identity denial の扱いは同一ではない。現在の契約が文脈 withholding 後の proceed を返す場合、記憶を捏造せず現物から進める。必須 gate の拒否を advisory と読み替えない。
- memory 適用完了と製品 Goal 達成を分ける。無関係と判定済み entry は関連根拠が変わるまで再利用する。承認済み作業の継続を誤った terminal state や全件再レビューで止めない。
- setup／doctor／hook を変えるタスクでは、fresh と既存生成指示・削除済み instruction・通常 consumer の振る舞いを確かめる。diagnostics の成功や新しい config の保存だけで既存 Codex 接続の reload 済みを断定しない。

配布参照：`src/setup/standard-skills.ts`、`src/setup/codex-hooks.ts`、`tests/ci/global-install-smoke.mjs`、`scripts/run-normal-workflow-gates.mjs`、`.github/workflows/ci.yml` と `normal-workflow-acceptance.yml`。通常利用の live／policy／review 条件は専用 workflow の現在値を確認する。workflow を定義しただけで live acceptance 済みとはしない。

## askdkc/kiokuko-ai

package／CLI は `kiokuko-ai`。公開契約は OpenCode を対象にしており、kiokuko の Codex hooks や DSH の Lisp 選択を移植しない。

- `skills/kiokuko-soul/SKILL.md` と `src/setup/standard-skills.ts` の現在契約を確認する。観測版では `one-shot-software-completion` が coding core で、共通 routine は追加レビュー資料としてその計画と証拠を再利用する。同名 routine が既に標準配布されているとは仮定しない。
- 観測版の Kiokuko は memory／plan sidecar。unresolved advisory intake、missing skill、enrichment failure は警告／品質低下を保ったまま coding 継続が可能。安全・実際に不足する権限・path／identity 違反・DB corruption・stale revision／lease による採用拒否は迂回しない。
- OpenCode の実クライアント identity、MCP 入口、通常 wrapper、子プロセス終了と continuation を確認する。テスト応答 server での transport 成功を実モデルの記憶適用率としない。

関連入口：`scripts/verify-opencode-boundary.mjs`、`tests/ci/global-install-smoke.mjs`、`scripts/run-opencode-{host,execution,agenticreplay}-e2e.mjs`、`.github/workflows/ci.yml`。host／wrapper が対象なら source unit だけでなく該当 E2E を選ぶ。別 repo と結合する CI は両側 SHA と artifact を確認する。

## 既存 SKILL と統合する場合

このフォルダは独立成果物であり、managed marker／deployment hash を複製して既存 manager の所有物を装わない。配置・登録・routing・package 更新は別の許可された実装タスクとする。

同名版の Red→Green、通常入口、復旧、鮮度は本主文書へ集約した。DSH 固有部分はこの参照に限定した。`one-shot-software-completion`、`memory-reasoning`、`repair-user-workflow` を利用する場合は、それぞれの有効な core を読み、既存 Goal／plan／ledger／証拠を共有する。別 PLAN や無意味な追加 review を積み重ねない。host 契約との衝突は現物と scope を確かめ、実装不能な部分を明示する。
