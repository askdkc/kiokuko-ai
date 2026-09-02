# Kiokuko (記憶庫) for Opencode

English | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

**Connect through MCP, recall useful context, and build reusable project memory.**

Kiokuko is a local external memory plugin for Opencode. It stores durable knowledge
in SQLite, retrieves relevant context for the next task, and records useful results
after work. You keep using your client normally; the client calls Kiokuko through MCP.

## The core idea

```text
request → MCP connection → retrieve relevant memory → do the work
                                             ↓
                                  save reusable knowledge
```

Memory is separated into Project, Ecosystem, and Global scopes. Current source,
configuration, and execution results take precedence over remembered context.

## Quick start

Node.js 24.16.0 or newer is required (Node.js 26.1.0 or newer is also supported).

```bash
npm install --global kiokuko-ai
kiokuko-ai setup
```

`setup` initializes the local database, installs the bundled standard Skills, and
configures OpenCode's MCP connection and npm plugin. Restart OpenCode after setup.
Exact configuration rules and recovery procedures are in the
[Getting started guide](docs/getting-started.md).

## Main features

- **RAG memory**: lexical retrieval by default, with optional local semantic retrieval.
- **Akinator**: clarifies vague requests before work begins.
- **役小角(enno-oduno)**: plans, confirms, verifies, and recovers multi-step agent work.
- **Local Web UI**: review and curate saved memories.
- **Reference-only Skills**: discovered external Skills are verified and never executed automatically.

Enable optional semantic retrieval with the same client setup flow:

```bash
kiokuko-ai embeddings setup
```

Managed MCP blocks are updated and registered-project instructions are refreshed.
An unmanaged identity is replaced only after interactive confirmation; non-interactive
and `--dry-run --json` invocations fail closed without changing it. See the
[semantic retrieval guide](docs/semantic-retrieval.md) for runtime, offline, and
fallback behavior.

## Supported client

OpenCode is the only supported client. Setup, Web UI, and restart instructions
are in [Getting started](docs/getting-started.md). The [documentation index](docs/README.md)
links to conceptual and operational guides.

## Safety and limitations

Kiokuko does not store full conversations and rejects content that resembles secrets
such as passwords, API keys, tokens, or private keys. Saved memories are advisory;
verify them against the current repository and runtime.

MCP tool calls are decided by the client and model, so there is no guarantee that
the model calls Kiokuko's MCP tool on every turn. Automatic processing by OpenCode
plugin hooks is separate from MCP tool calls. Trust boundaries and public error
behavior are documented in [Security and trust](docs/security-and-trust.md).

## More detail

- [Documentation index](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Concepts](docs/concepts.md)
- [役小角(enno-oduno)](docs/enno-oduno.md)
- [Semantic retrieval](docs/semantic-retrieval.md)
- [Security and trust](docs/security-and-trust.md)
- [CLI contract](docs/cli-contract.md)

Implementation-focused references remain in [architecture](docs/architecture.md),
[database](docs/database.md), [execution ledger](docs/execution-ledger.md), and
[client compatibility](docs/client-compatibility.md).
