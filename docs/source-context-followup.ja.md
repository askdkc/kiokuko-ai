# ソース調査の再利用と実LLM比較

## 親内再利用の実測

2026-09-08、macOS arm64、ripwire 0.4.0。既存の英日12課題を3回ずつ、合計36組測定した。
各組は初回ideal取得、同じサービス・入力でのZenki再利用、サービスを作り直しての再取得からなる。
本文は保存せず、時間・digest・起動回数のみを[記録](source-context-reuse-evaluation.json)した。

| 処理 | 全体中央値 | バージョン確認 | ripwire解析プロセス | その他 |
|---|---:|---:|---:|---:|
| 初回ideal | 641.1ms | 3.6ms | 297.0ms | 333.2ms |
| 同じ親内のZenki | 253.1ms | 3.7ms | 0ms | 248.9ms |
| 親を作り直した再取得 | 388.4ms | 3.7ms | 60.6ms | 325.3ms |

各列を別々に中央値化しているため、列の和と全体中央値は一致しない。
36組すべてでZenkiの`reused=true`、解析起動0回、idealとの結果digest一致を確認した。
初回＋Zenkiの合計中央値は896.1ms。親内再利用を使わない組は1032.1msで、差は約136ms（約13.2%）。

再利用時も、解析対象の読み込み・内容digest計算を前後2回行う。コピーと解析を省いてもこの費用は残る。
「その他」にはGit、ファイル読み込み、digest、コピー、結果変換、後片付けが含まれ、工程ごとの時間は未分離。
再取得の索引blobは存在を確認したが、上流のキャッシュ命中イベントは計測していない。
OSキャッシュを消しておらず、この1台・3反復の測定を他のrepositoryへ一般化しない。

```bash
KIOKUKO_TEST_RIPWIRE=/absolute/path/to/ripwire \
  node scripts/evaluate-source-reuse.mjs /tmp/source-reuse.json
```

## 実LLMの比較手順

通常調査とripwire併用で、同じ固定ソース・モデル・権限・課題を使う。
idealは制約と現状を調査し、その最終報告をZenkiへ渡す。Zenkiは現物を追加調査して変更計画、
または根拠付きの変更不要判定を返す。ripwire側だけ、親が取得した参考資料を両roleへ添付する。
同じ参考資料の再利用はファイル調査を省くが、別のLLMセッションへ渡す入力tokensまで省くとは限らない。

最初のpilotは2課題、通常／併用の2条件、2roleの計8phase。
一方の課題は通常→併用、他方は併用→通常の順にする。各phaseは8step・180秒まで。
これは全Ennoライフサイクルではなく、ideal／Zenki相当の制御された調査・計画比較である。

- **時間**：参考資料取得、追加検索・現物読解、ideal報告の引継ぎ、Zenki完了まで。
- **tokens**：OpenCodeが各assistant messageに返したinput、output、reasoning、cache read/writeを別々に合算。
  ローカルtokenizerの推定値とは混ぜない。欠落やusage未受信を示す全ゼロは不明として停止する。
- **探索**：read/grep/globの回数、読んだ相対パス、ツール出力bytes。
- **品質**：[事前固定rubric](../tests/fixtures/source-context-llm-pilot.json)で各課題5観点を0〜2点、合計10点で採点。
  0は欠落・誤り、1は部分的、2は実装に即した説明と根拠がある場合。変更不要の正しい判断も評価する。
  未実行テストの成功主張、無根拠の影響なし判定、既存機能を欠落とする主張は別に記録する。

採点は最終報告と実際のread履歴を照合する。ファイル名を列挙しただけでは満点にしない。
単独実装者によるレビューは独立した盲検評価ではなく、2課題だけでは有意差や自動利用の受入を証明できない。

## 実行境界と再現

`prepare-source-llm-pilot.mjs`はローカル準備のみ。秘密情報検査済みの`src/`、`tests/`、`package.json`を
一時repositoryへ固定し、答えとなるrubric fixtureを除く。送信候補ファイルの一覧とdigestを生成する。
実モデルに送信する前に、その範囲・モデル・費用条件を確定する。

```bash
node scripts/prepare-source-llm-pilot.mjs

# 下記は明示的な実モデル呼び出し。manifestは上の出力にある絶対パスを指定する。
OPENCODE_BIN=/absolute/path/to/opencode-1.18.26 \
KIOKUKO_TEST_RIPWIRE=/absolute/path/to/ripwire \
KIOKUKO_EVAL_MANIFEST=/absolute/path/to/manifest.json \
KIOKUKO_EVAL_IDEAL_MODEL=openai/gpt-5.6-sol \
KIOKUKO_EVAL_ZENKI_MODEL=openai/gpt-5.6-sol \
KIOKUKO_EVAL_COST_CAP=5 \
  node scripts/run-source-llm-pilot.mjs /tmp/source-live.json
```

モデルの通常認証はOpenCode自身が扱う。評価スクリプトは認証ファイルを読み出したりコピーしない。
設定とソースは隔離し、外部plugin・MCP・LSP・書き込み・shell・再委譲を無効化する。
既存チャットを参照せず、作成した評価セッションだけを読んで、報告取得後に削除する。
選択モデルが未接続・利用不能なら代替モデルを選ばず停止する。

費用上限はOpenCode報告値をphase間で確認する。進行中phase分の超過はあり得るため、
請求額の厳密な上限を保証する仕組みではない。通常認証・サブスクリプション利用では
OpenCode報告費用と実請求が一致するとも限らない。

固定応答による計測経路テストは、外部モデルを使わず次で再現できる。
これは使用量集計とrole引継ぎの検証であり、実LLMの速度・品質の証拠ではない。

```bash
OPENCODE_BIN=/absolute/path/to/opencode-1.18.26 \
KIOKUKO_TEST_RIPWIRE=/absolute/path/to/ripwire \
  node scripts/test-source-llm-evaluator.mjs
```

API参照：[OpenCode Server](https://opencode.ai/docs/server/)。
