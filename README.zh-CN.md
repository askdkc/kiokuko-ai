# Kiokuko（记忆库）for OpenCode

[English](README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md)

**通过 MCP 连接，检索需要的记忆，并在工作后积累知识。**

Kiokuko 是面向 OpenCode 的本地外部记忆插件。它把知识保存在 SQLite 中，在下一次任务中检索相关上下文，
并保存可复用的工作结果。

```text
请求 → MCP 连接 → 检索相关记忆 → 完成工作
                              ↓
                         保存可复用知识
```

记忆分为 Project、Ecosystem 和 Global。当前代码、配置和运行结果优先于历史记忆。

## 快速开始

需要 Node.js 24.16.0 或更高版本（也支持 Node.js 26.1.0 或更高版本）。

```bash
npm install --global kiokuko-ai
kiokuko-ai setup
```

`setup` 会初始化数据库、安装标准 Skill，并配置 OpenCode MCP 和 npm 插件。已运行的 OpenCode 请在设置后重启。
精确配置和恢复规则请参阅[英文 Getting started](docs/getting-started.md)。

## 主要功能

- RAG 记忆（默认 lexical，可选本地 semantic 检索）
- Akinator 让模糊请求先变得具体
- 役小角(enno-oduno) 负责计划、确认、验证和恢复
- 本地 Web UI 用于检查和整理记忆
- 外部 Skill 仅作为经过验证的参考，绝不自动执行

可选的 semantic 检索使用与 `setup` 相同的客户端配置流程：

```bash
kiokuko-ai embeddings setup
```

它会更新 managed MCP block 和项目 instructions。替换 unmanaged identity 需要交互确认；非交互或 `--dry-run --json`
执行会在不修改配置的情况下 fail closed。详见[英文 semantic retrieval](docs/semantic-retrieval.md)。

## 支持的客户端

仅支持 OpenCode。设置、重启和 Web UI 的说明请参阅[英文 Getting started](docs/getting-started.md)。

## 安全性与限制

Kiokuko 不保存完整对话，并拒绝看起来像密码、API key、token 或私钥的内容。记忆只是参考信息，应以当前代码和运行结果为准。

MCP tool 是否调用由客户端和模型决定，因此不保证模型每一轮都会调用 Kiokuko 的 MCP tool。OpenCode plugin hook 的自动处理与 MCP tool 调用相互独立。信任边界和公开错误请看[英文 Security and trust](docs/security-and-trust.md)。

## 详细文档

请从[英文文档目录](docs/README.md)开始；其中链接到 Getting started、Concepts、Enno-Oduno、Semantic retrieval、Security and trust，
以及实现者用的 architecture、database、execution-ledger 和 client-compatibility 文档。
