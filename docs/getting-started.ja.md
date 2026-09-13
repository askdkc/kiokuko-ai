# 導入ガイド

## インストールと設定

Node.js 24.16.0以上が必要です。次の2コマンドで導入します。

```bash
npm install --global kiokuko-ai
kiokuko-ai setup
```

setupはOpenCodeを自動設定します。`--clients`はサポートしていません。
`--dry-run --json`は書き込みなしで計画を出力します。`--no-standard-skills`、
`--skill-discovery off|official|community`、`--enno-oduno ask|on|off`も指定できます。

setupはOpenCodeの`opencode.json`または`opencode.jsonc`に`kiokuko` MCP entryを設定し、
`plugin`配列にnpm pluginを追加します。

```jsonc
{
  "plugin": ["kiokuko-ai"],
  "mcp": {
    "kiokuko": {
      "type": "local",
      "command": ["kiokuko-ai", "mcp"],
      "enabled": true,
      "environment": { "KIOKUKO_SKILL_DISCOVERY": "official" }
    }
  }
}
```

これは手動設定の最小例です。推奨する `kiokuko-ai setup` は plugin の版を固定し、
plugin hook と MCP server が同じ絶対 Node/CLI runtime を使う設定を生成します。

無関係な設定とコメントは保持します。値の変更、重複plugin identity、余分なMCP field、
unmanagedな`kiokuko` identityはconflictとして無断上書きしません。対話実行では置換前に確認し、
JSON・非対話・dry-runでは`CONFLICT`を返して変更しません。

setupは対応する形式のプロジェクトinstructionsだけを更新します。新しいtemplateやDSH管理のblockは、
ファイルとbindingを変更せず、保持したことを表示します。不正なmarker、読めないpath、identity不一致は引き続きエラーです。
再実行時は設定済みのdiscovery modeを維持し、OrcaReplayと管理対象aliasが導入済みなら再確認しません。

起動中のOpenCodeは設定後に再起動してください。`kiokuko-ai doctor --json`はruntime、DB、
OpenCode MCPを読み取り専用で検査します。

## ローカルsemantic検索

`kiokuko-ai setup`でOpenCodeの設定とモデルの検証・有効化まで完了します。
初回は必要なruntimeとモデルをダウンロードし、次回から検証済みのものを再利用します。
追加のsetupコマンドは不要です。モデルの準備を省く場合は`--no-embeddings`を指定します。
この指定で既存のprofileが無効になることはありません。
`embeddings setup`は互換用に残し、同じ導入処理を実行しますが、任意の連携機能の質問は行いません。

runtimeと検証済みモデルが導入済みなら、オフラインでも実行できます。

```bash
kiokuko-ai setup --offline
kiokuko-ai embeddings status --json
```

`--replace`は別のembedding profileから切り替える指定です。`--dry-run`はdownloadと変更を行わず、`--json`は自動化向けで
unmanaged MCP identityをfail closedします。dry-run以外ではoptional runtimeの確認・導入前にsetup lockを取得するため、複数のsetup processがpackage導入やclient・database変更を並行実行しません。

## Web UIとclient

`kiokuko-ai web`を実行し、`http://127.0.0.1:4173`を開きます。UIはローカル限定の管理画面で、model向けMCP呼び出しの代替ではありません。
Enno-Oduno有効時はOpenCode pluginが`session.idle` hookで継続処理を行います。
