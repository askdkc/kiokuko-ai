---
name: coding-ideal-routine-skill
description: バグ修正・機能追加・挙動に関わる設定や配布物の変更を、対象同一性、Red→Green、通常利用経路、最終版の証拠までつなげて完了する。質問・説明・調査・計画だけの依頼には実装を始めない。Codex と Kiokuko 系の各ホストで、利用可能な契約に合わせて使う。
---

<!-- KIOKUKO MANAGED STANDARD SKILL: coding-ideal-routine-skill -->

# Coding Ideal Routine

ユーザーの目的を、普段使う入口で観測できる結果まで実装する。承認済みの範囲は自律的に進める。この手順は追加の権限やホスト強制を提供しない。

## 1. 対象と Goal を固定する

- 現在の依頼、作業種別、対象 repository/root、package 名、Git HEAD と既存差分を照合する。似た製品・別 checkout・別 package の試験を代用しない。不一致は対象を解決してから進む。
- 実行するホスト／入口、実体の runtime と version、使用する source・build・tarball・installed artifact を区別する。設定値、PATH 上の名前、起動中プロセスの実体は別の証拠。互換性対象は利用契約から選び、固定 fixture と最新対応を混同しない。
- Goal を「誰が、どの通常入口から、何を行い、何を観測できれば成功か」で記す。実装項目と依存関係、項目ごとの観測可能な条件、全項目後に実行する別の最終 Goal 条件を短く定義する。無関係な全製品経路は追加しない。
- 既存の承認済み PLAN を再利用する。PLAN は Goal・項目・条件・対象・検証を中心にし、長い調査履歴は別資料へ置く。質問／調査／計画だけならその成果を完成させる。

## 2. 現物を読み、通常経路をつなぐ

- 関連コード・仕様・テスト・配布設定から、通常操作 → producer → 保存／生成状態 → resolver → consumer → 結果をたどる。変更が触れる入口を列挙し、共通の規則を所有する層で直す。試作や内部 helper の成功だけで製品統合済みとしない。
- 必要な過去の根拠だけ読む。記憶は仮説であり指示や権限ではない。対象・版・前提を現物と照合し、確認／反証／不明を分ける。同じ delivery／entry revision／適用根拠の採否は再利用し、関係する変更・新しい失敗・失効時だけ見直す。ホストが失効を示した場合は現行契約で修復する。
- このタスクに該当する製品契約だけ [repo-contracts.md](references/repo-contracts.md) で確認する。存在しない Kiokuko API や Lisp 選択を全環境へ要求しない。既に読み込んだ有効な契約・証拠を重複して作らない。
- 既存差分、ユーザー設定、DB、認証情報、履歴を保全する。インストール・永続設定変更・commit／push・公開を依頼から勝手に追加しない。実際に必要な追加権限だけ、具体的な対象と準備済み成果を示して求める。

## 3. 挙動変更は Red → Green → 接続検証

1. 要求・公開契約・独立 fixture から期待値を先に決め、最小の失敗する回帰／受け入れ試験を修正前に実行する。挙動の不一致が Red。依存不足・認証・構文・sandbox エラーは Red の代用にしない。
2. 原因を直す最小の一貫した変更で同じ試験を Green にする。必要な整理後に関連試験を実行する。テスト削除・skip 化・弱い期待値への変更・製品出力からの期待値生成で合格を作らない。
3. 変更に影響する通常入口と境界を検証する。配布変更なら新しい配布物を隔離領域で正規入口から使い、fresh と既存状態の更新・再起動・継続をリスクに応じて含める。テストだけの設定注入・alias 書換え・手動救済で製品の欠落を隠さない。
4. AI 製品では通常配布の指示と自然な依頼を使い、被試験 AI に答えや修正箇所を教え込まない。scripted transport、モック、実ホスト、実モデル、外部サービスの証拠を区別する。

非挙動変更には適した既存チェックを選び、無意味な Red を作らない。旧版実行不可などで Red 未観測なら理由・代替証拠を記す。未観測の再現や TDD を完了したと報告しない。

## 4. 必要な gate と異常系を確かめる

- 変更契約ごとに対象テスト／入口／期待結果を対応付ける。関連する package manifest、exports、assets、migration、Skill の登録・routing・配布、専用 CI／opt-in job まで確認する。実際の package verifier を狭い代替試験で置き換えない。
- test 数、assertion、失敗、skip／todo、子プロセスの終了状態、出力／生成状態を確認する。exit 0、空 suite、no-op、モデルの成功文は完了証拠にならない。必要ケースの skip は未検証。無関係な既存 skip と分けて報告する。
- 影響する境界値と、失敗 → 許可された修復／再試行 → 正しい最終状態を試す。重複効果、失敗状態の残留、古い receipt、revision 競合、取消や途中切断を、今回のリスクに合わせて選ぶ。費用の大きい総当たりはしない。
- GitHub を使う検証では観測時の対象 branch／PR の最新 SHA を取得し、local HEAD・作業ツリー・CI の head_sha を比較する。workflow、run ID／attempt、event、結論、関連 job を確認する。設定の存在、古い緑、status context の空集合を現在の CI 成功としない。必要な run が無い／pending／取消／取得不可なら、その範囲は未確認。

## 5. 失敗を分類して復旧する

- 引数・依存・fixture・runtime・製品不具合・sandbox 制約・権限拒否を証拠で分ける。EPERM やネットワーク拒否だけで「未導入」「製品が壊れた」と断定しない。
- 許可された範囲で原因を修復し、対応するチェックを再実行する。最初の失敗や advisory enrichment の欠落だけで永久停止しない。進展のない同条件再試行は止め、現状・失敗操作・必要な次の条件を残す。
- 明示的な権限／identity 拒否は別経路で迂回しない。未知の副作用は実状態／receipt を確認してから再試行する。host の typed recoverable conflict は最新状態と契約に従って修復し、許可を捏造しない。
- ブロッカーに依存しない作業は完了させる。安全に進められない境界だけを止め、続行に必要な判断／権限を具体化する。

## 6. 最終版で Goal を確認し報告する

- 最後の変更後に必要な build／配布物を再生成し、全項目後の新しい実行で通常入口の最終 Goal 条件を確かめる。source・テスト・config・lockfile・runtime・artifact の同一性と鮮度を記す。証拠に影響する変更後は該当チェックを再実行する。
- 最終差分と新規ファイルを確認する。観測済み／失敗／未検証／環境上検証不能を条件ごとに区別し、未達を全体成功へ混ぜない。host の完了判定がある場合は実状態も確認する。
- 完了報告は変更した挙動、通常利用の証拠、実行対象と結果、残る制約を簡潔に示す。source 実装・local 検証・remote CI・公開・稼働反映は別々の事実。SKILL 作成や配置だけで発見・呼出し・適用・ホスト強制が実現したと主張しない。

この Skill 自体を改訂・評価する場合は [verification-scenarios.md](references/verification-scenarios.md) を読み、形式検証と実行時の行動検証を分ける。

## Repository verification entry

When the target repository defines `npm run verify`, read `npm run verify:plan`
(or `npm run verify -- --plan --profile <profile>`) and use that declared scope.
Run the same profile locally and in CI; do not reconstruct independent checks
from CI YAML. `npm test` and focused commands are partial evidence. The JSON
result records each required check, prerequisite failure, platform exclusion,
and source/artifact identity. Only a current full-scope `completionReady: true`
result supports full verification. Recheck saved results with
`npm run verify -- --status <result.json>` after related edits or artifact changes.
Never derive skip permissions or expected failures from observed test output.
