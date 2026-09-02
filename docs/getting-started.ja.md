# 導入ガイド

## インストールと設定

Node.js 24.16.0以上が必要です。次の2コマンドで導入します。

```bash
npm install --global kiokuko-ai
kiokuko-ai setup
```

setupはOpenCodeを自動設定します。`--clients`はサポートしていません。
`--dry-run --json`は書き込みなしで計画を出力します。`--no-standard-skills`、
`--skill-discovery off|official|community`、`--enno-oduno on|off`も指定できます。

setupはOpenCodeの`opencode.json`または`opencode.jsonc`に`kiokuko` MCP entryを設定し、
`plugin`配列にnpm pluginを追加します。

```jsonc
{
  "plugin": ["kiokuko-ai"],
  "mcp": {
    "kiokuko": {
      "type": "local",
      "command": ["kiokuko", "mcp"],
      "enabled": true,
      "environment": { "KIOKUKO_SKILL_DISCOVERY": "official" }
    }
  }
}
```

無関係な設定とコメントは保持します。値の変更、重複plugin identity、余分なMCP field、
unmanagedな`kiokuko` identityはconflictとして無断上書きしません。対話実行では置換前に確認し、
JSON・非対話・dry-runでは`CONFLICT`を返して変更しません。

起動中のOpenCodeは設定後に再起動してください。`kiokuko-ai doctor --json`はruntime、DB、
OpenCode MCPを読み取り専用で検査します。

## Embeddings

`kiokuko-ai embeddings setup`は固定semantic runtimeを導入し、`kiokuko-ai setup`と同じclient設定フロー（conflict確認、managed MCP更新、
登録済みプロジェクトのinstructions更新）を実行します。

```bash
kiokuko-ai embeddings setup --preset local-small --offline
kiokuko-ai embeddings status --json
```

`--replace`は別のembedding profileから切り替える指定です。`--dry-run`はdownloadと変更を行わず、`--json`は自動化向けで
unmanaged MCP identityをfail closedします。

## Web UIとclient

`kiokuko-ai web`を実行し、`http://127.0.0.1:4173`を開きます。UIはローカル限定の管理画面で、model向けMCP呼び出しの代替ではありません。
Enno-Oduno有効時はOpenCode pluginが`session.idle` hookで継続処理を行います。
