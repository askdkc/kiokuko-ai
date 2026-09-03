# Kiokuko（記憶庫）for OpenCode

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

**MCPで接続し、必要な記憶を検索し、作業後に知識を蓄積する。**

KiokukoはOpenCode向けのローカル外部メモリ導入Pluginです。SQLiteに知識を保存し、
次のタスクに関係する文脈を検索し、作業結果から再利用できる知識を記録します。

## 基本概念

```text
依頼 → MCP接続 → 関係する記憶を検索 → 作業
                                  ↓
                         再利用できる知識を保存
```

記憶はProject・Ecosystem・Globalに分離されます。現在のコード、設定、実行結果が過去の記憶より優先されます。

## 最短セットアップ

Node.js 24.16.0以上が必要です（Node.js 26.1.0以上にも対応）。

```bash
npm install --global kiokuko-ai
kiokuko-ai setup
```

`setup`はローカルDBを初期化し、標準Skill、OpenCodeのMCP接続、npm pluginを設定します。
起動中のOpenCodeは、設定後に一度再起動してください。正確な設定規則は
[導入ガイド](docs/getting-started.ja.md)を参照してください。

## 主な機能

- **RAGメモリ**: 標準はlexical検索、任意でローカルsemantic検索。
- **Akinator**: 曖昧な依頼を作業前に具体化。
- **役小角(enno-oduno)**: 複数手順の計画、確認、検証、回復。
- **ローカルWeb UI**: 保存した記憶の確認と整理。
- **参照専用Skill**: 外部Skillは検証して保存するが、自動実行しない。

semantic検索を有効にする場合も、通常のclient設定フローを使います。

```bash
kiokuko-ai embeddings setup
```

managed MCP blockと登録済みプロジェクトのinstructionsを更新します。unmanaged identityの置換は対話確認後だけ行い、
非対話または`--dry-run --json`では変更せずfail closedします。詳細は
[semantic retrievalガイド](docs/semantic-retrieval.ja.md)を参照してください。

## 対応クライアント

対応クライアントはOpenCodeのみです。設定、再起動、Web UIは
[導入ガイド](docs/getting-started.ja.md)にまとめています。

## 安全性と制約

会話全文は保存せず、パスワード、API key、token、秘密鍵に似た内容を拒否します。保存された記憶は参考情報であり、
現在のリポジトリと実行結果で確認してください。

MCP toolの呼び出しはclientとモデルが決めるため、モデルが毎回KiokukoのMCP toolを呼ぶ保証はありません。OpenCode pluginのhookによる自動処理は、MCP toolの呼び出しとは別に実行されます。信頼境界と公開エラーは
[Security and trust](docs/security-and-trust.ja.md)で説明しています。

## 詳細ドキュメント

- [ドキュメント目次](docs/README.ja.md)
- [導入ガイド](docs/getting-started.ja.md)
- [基本概念](docs/concepts.ja.md)
- [役小角(enno-oduno)](docs/enno-oduno.ja.md)
- [Semantic retrieval](docs/semantic-retrieval.ja.md)
- [Security and trust](docs/security-and-trust.ja.md)
- [CLI contract](docs/cli-contract.md)

実装者向け資料は[architecture](docs/architecture.md)、[database](docs/database.md)、[execution ledger](docs/execution-ledger.md)、
[OpenCode integration](docs/opencode-integration.md)を参照してください。
