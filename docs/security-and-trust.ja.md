# Security and trust

## 記憶とsecret

パスワード、API key、token、秘密鍵などに似た内容は拒否し、会話全文は保存しません。記憶は参考情報であり、現在のコード、設定、実行結果を上書きしません。

## External Skills

外部Skill discoveryは参照専用です。source commitを検証し、boundedな内容をuntrusted candidateとして保存しますが、取得したSkillを自動install・実行・登録しません。
既定は`official`、`community`は明示opt-in、`off`で無効化します。

Skillの確認・管理:

```bash
kiokuko-ai skills find svelte --official-only --json
kiokuko-ai skills list
kiokuko-ai skills disable <skill-id>
kiokuko-ai skills refresh <skill-id>
```

Web UIではmappingの確認・無効化だけを行い、install、script、MCP登録は行いません。

## OpenCode境界

OpenCodeの継続は`session.idle`を入口にしますが、eventだけを信頼せず、injected clientからroot session、repository directory、完了済みassistant terminalを再検証します。hook subprocessはpackage所有のNode/CLI identity、protocol/package version、終了状態、厳密な応答shape、secret不在を確認し、timeoutまたはdisposeでは停止します。prompt APIの完了だけを配送証拠にせず、決定的message IDがmessages read-backに現れた場合だけ配送済みとします。

## MCP extensionと公開エラー

client extensionは成功・エラーMCP resultを検査・置換できるため、trusted computing baseの一部です。extensionが偽造できないoriginal-result identifierとmodified flagなしには、
end-to-end authenticityを主張できません。重要なresultを変更するextensionと併用しないでください。

通常の公開tool errorは`isError: true`、allowlist済みmessage、`structuredContent.code`、`structuredContent.retryable`だけを返します。`BACKPRESSURE`だけがboundedな`retryAfterSeconds`を追加できます。
stack、SQL、path、payload、secretはgeneric errorへコピーしません。
