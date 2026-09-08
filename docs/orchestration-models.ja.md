# オーケストレーションのモデル設定

[English](orchestration-models.md) · [README](../README.ja.md#オーケストレーションのモデルを追加する)

`task_prepare` は記憶を一度取得し、選択待ちのrunを保存します。この時点では役小角の
draftは作りません。`task_execution_select` が通常実行／中止／全5役割の構成を確定します。
選択はrunに保存され、追加回答・compaction・再起動でも保持されます。選択記録のない
既存の進行中runは従来方式で継続します。

## setupとおすすめ構成

両setupは同じ設定生成処理を使います。`--enno-oduno ask|on|off` の既定値は `ask`。
`on` でも依頼ごとにモデル構成を選び、`off` は通常実行へ進みます。
`--dry-run --json` で書き込み予定を確認できます。既存の有効なJSON／JSONCと設定
ディレクトリ指定を尊重します。`OPENCODE_CONFIG` はJSON/JSONCファイルの絶対パス、
`OPENCODE_CONFIG_DIR` はディレクトリの絶対パスを指定します。新規作成先を `~/.config/opencode/opencode.jsonc` にします。
変更対象の管理値以外のコメント、認証、他のplugin、provider、カスタムエージェントを
保持します。利用者が編集した管理エージェントも保持し、同時変更は衝突として扱います。

| 構成ID | 接続先 | ideal・zenki・check | gokiHead | gokiWorker |
|---|---|---|---|---|
| `openai` | OpenAI／ChatGPT | Astra | Sol | Luna |
| `zen-openai` | OpenCode Zen | Astra | Sol | Luna |
| `zen-glm` | OpenCode Zen | GLM-5.3 | GLM-5.3 | GLM-5.3 Flash |
| `go-glm` | OpenCode Go | GLM-5.3 | GLM-5.3 | GLM-5.3 Flash |
| `go-qwen` | OpenCode Go | Qwen3.8 Max | Qwen3.8 Max | Qwen3.8 Flash |
| `openrouter-glm` | OpenRouter | GLM-5.3 | GLM-5.3 | GLM-5.3 Flash |
| `openrouter-qwen` | OpenRouter | Qwen3.8 Max | Qwen3.8 Max | Qwen3.8 Flash |

DeepSeek V4 Flashもworkerの代替候補です。[設定上の正確なモデルID](orchestration-models.md#setup-and-presets)
を参照してください。テンプレートの存在は契約・利用権限の保証ではありません。
選択時にOpenCodeの接続済みproviderとモデル一覧、tool-call対応を確認し、不明なIDを
推測で置き換えません。setupは有料モデルを呼び出しません。認証・残量・利用制限は
実行時に初めて判明する場合があります。偽モデルサーバーの検証は実契約の検証ではありません。

役割・接続先・モデルが同じエージェントは構成間で共用します。委譲深度
`subagent_depth` は未指定時だけ2に設定します。明示された小さい値は保持し、
その場合はGokiヘッドに `depth_insufficient` を表示します。

<a id="custom-agents"></a>
## 全5役割へのカスタム登録

[READMEのworker追加例](../README.ja.md#オーケストレーションのモデルを追加する)は
エージェントとKiokuko側の登録を両方示しています。対象役割の生成済み定義を別名で
コピーし、正式な `provider/model` に変更します。指示と権限を保持してください。
既存Kiokuko plugin配列要素の2番目のオブジェクトへ、次のように登録を追記します。

```jsonc
{
  "orchestration": {
    "mode": "ask",
    "customAgents": {
      "ideal": ["my-ideal"],
      "zenki": ["my-planner"],
      "gokiHead": ["my-coordinator"],
      "gokiWorker": ["my-worker", "my-second-worker"],
      "check": ["my-reviewer"]
    }
  }
}
```

各名前をOpenCodeの `agent` にも定義します。役割ごとに接続先を混在させられます。
おすすめ構成のworkerだけを別providerへ変更することも可能です。OpenCodeを再起動し、
新しい依頼で役小角と構成を選んだ後、役割単位で候補を変更します。名前は大文字小文字を
区別します。無関係なエージェントの名前から推測で登録しません。カスタム名と定義は
利用者所有で、setupは削除・上書きしません。

## Gokiの二段階委譲と権限

親ホストは標準 `task.subagent_type` で固定モデルのエージェントを呼びます。
実行前にrun、選択リビジョン、現在の役割、エージェント定義、モデルの利用可否を照合します。
Gokiヘッドへ選択済みworkerの呼び出し情報を渡し、ヘッドからworkerへ委譲します。
親がrunの識別子とWorkUnitのリースを保持し、子の完了を待って既存のMCP報告を送ります。
`task_id` による子セッションの再利用とバックグラウンド実行は禁止します。同一プロンプトの
呼び出し記録を残し、結果不明な呼び出しの自動再送を防ぎます。

全役割は `mode: "subagent"` で既定拒否です。共通で許可するのは `read`、`glob`、
`grep`、`list`、`skill`。ideal・Zenki・checkは変更・shell・委譲を許可しません。
Gokiヘッドは `task` を許可し、pluginがそのrunで選択したworkerに限定します。
workerは `edit` と `bash` を許可し、`task` を拒否します。全役割で `kiokuko_*` を拒否し、
`external_directory` は `ask` を保持します。これはOpenCodeのツール権限であり、workerの
shellをOSレベルで隔離する仕組みではありません。承認済み範囲と既存のパス・リース検査を守ります。

カスタム役割も生成済み定義と同じ権限オブジェクトを保持してください。追加の許可や変更が
ある場合は候補を無効とします。最終検証は親が `enno_verify_prepare` で実行し、その後に
checkが新しい検証証拠を読み取ります。

## 候補が表示されない・実行できない場合

- `agent` と `customAgents` の役割・登録名が一致するか、`mode` が `subagent` か、
  `disable` がtrueでないかを確認します。
- `/connect` と `/models` で接続と正確なモデルIDを確認します。
  `provider_disconnected`、`model_missing`、`tools_unsupported`、`catalog_unavailable`
  が失敗した条件です。一覧にあるだけでは残量や課金上の利用権限は保証されません。
- `permissions_invalid` では現行の役割テンプレートから権限を再コピーします。
  `depth_insufficient` では利用者の判断で `subagent_depth` を2以上にします。
- 設定変更後はOpenCodeを再起動します。モデル・指示・権限の変更は既存の選択を無効にするため、
  実行前に明示的に再選択します。
- 中断時は先に子の結果を確認します。開始済みの呼び出し記録は再起動でも残ります。
  実行中WorkUnitを終了・報告する前に構成を変更できません。
- モデル失敗時は代替候補／通常実行／中止を選びます。自動代替しません。
  開始済みの役小角から通常実行へ移るとその役小角はキャンセルされます。
  再び役小角を使う場合は新しい依頼を開始します。

質問表示とMCP呼び出し順序はホストのモデルが実行します。Kiokukoは選択の案内と
登録済み役割の呼び出し検査を提供しますが、モデルが毎回質問することや全指示を守ることを
保証するものではありません。Kiokuko自体が利用できない場合も通常作業を続けられます。

## 検証済み範囲

macOS arm64上の実OpenCode **1.18.25／1.18.26** と隔離したOpenAI互換の偽サーバーで、
全役割の送信モデル、親→Gokiヘッド→README例のカスタムworker、読み取り専用役割の
変更拒否、worker再委譲の拒否、再起動後の選択復元、401・404・429時に別モデルへ
切り替わらないことを確認しています。失敗後の再起動でも明示的な再選択または中止を
必要とし、setup再実行はREADME例の定義・登録を保持しました。
両バージョンでOpenCode自身がMCP準備を一度呼び、接続済みモデル一覧を取り込み、
通常実行を選択して子セッションを作らない入口も検証しています。

単体・結合試験は、draftを作らない通常実行、選択の再送、異なる構成の並行run、
compaction時の選択保持、既存runの移行、両setup、JSONCコメント、dry-run、衝突検出を
対象とします。既存のパッケージ版ホストE2EもMCP接続と一度だけの自動継続を確認します。
CIには両バージョンを使うLinux上の役割振り分け試験を追加しています。

**OpenAI／ChatGPT、OpenCode Zen、OpenCode Go、OpenRouterの実アカウントは未検証です。**
契約上の利用権限、提供モデル、課金、実モデルの指示追従を保証するものではありません。
[検証コマンド](orchestration-models.md#verification-coverage)も参照してください。
