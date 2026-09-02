# Semantic retrieval

軽量インストールではlexical検索が動きます。semantic検索は任意のlocal `local-small` embedding profileです。

```bash
kiokuko-ai embeddings setup
kiokuko-ai embeddings status --json
kiokuko-ai embeddings repair
```

固定runtimeを導入し、load前にartifactを検証します。`--offline`は検証済みlocal installationを要求し、`--dry-run`はdownload・書き込み・profile変更を行いません。
`--replace`は別profileから切り替えます。model weightはnpm packageに含めません。

このコマンドは通常のclient setup flowも実行し、managed MCP blockとproject instructionsを更新します。完全一致の旧managed blockは自動更新します。
unmanagedまたは改変されたidentityは対話確認が必要で、JSON・非対話・dry-run自動化では設定を変えずfail closedします。

runtime、model、vectorに障害があってもlexical検索と既存vectorは利用できます。`status`と`doctor --json`でcoverageとhealthを確認します。
embedding設定は環境変数ではなくSQLiteに保存します。
