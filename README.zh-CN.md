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

使用 `kiokuko-ai trace record --` 记录 OpenCode，并在退出后导入最终跟踪。交互式设置可添加 `orca-opencode` 快捷命令。同步和恢复方法见 [OrcaReplay 集成](docs/orcareplay-integration.md)。

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

## 添加编排模型

`kiokuko-ai setup` 和 `kiokuko-ai embeddings setup` 会注册固定模型的角色代理。
`--enno-oduno ask|on|off` 保存偏好，默认为 `ask`。每个新请求选择普通执行或
役小角(enno-oduno)，再选择预设和各角色的模型。小范围README文字修改建议普通执行。
`on` 仍会询问模型配置；同一请求的后续回复保留选择。

1. 在OpenCode中用 `/connect` 连接提供商，用 `/models` 或 `opencode models`
   确认准确的 `provider/model`。
2. 在有效的OpenCode配置（新建时为 `~/.config/opencode/opencode.jsonc`）中，
   复制生成的 `gokiWorker` 代理并改名，修改 `model`，保留角色提示和权限。
   将下例中的代理条目合并到已有 `agent` 对象。将 **`YOUR_PROVIDER/YOUR_MODEL`**
   替换为确认的模型ID；如需改名，两处 **`my-orchestration-worker`** 必须一致。
3. 将第二个示例合并到**已有Kiokuko plugin元组的第二个对象**，在
   `orchestration.customAgents.gokiWorker` 中追加名称。保留已有选项和其他名称，
   不要替换整个配置文件或plugin列表。
4. 重启OpenCode。在新请求中选择役小角及预设，再将worker改为新代理。
   再次运行setup会保留自定义定义。

<!-- kiokuko-custom-worker-example -->
```jsonc
{
  "agent": {
    "my-orchestration-worker": {
      "description": "My Kiokuko worker",
      "mode": "subagent",
      "model": "YOUR_PROVIDER/YOUR_MODEL",
      "prompt": "Implement only the supplied approved WorkUnit and run its focused verification. Do not delegate or broaden scope. The parent owns the run, leases, and all Kiokuko reports. Do not call Kiokuko tools or change models. Return changed paths and verification evidence.",
      "permission": {
        "*": "deny",
        "read": "allow", "glob": "allow", "grep": "allow", "list": "allow",
        "skill": "allow", "edit": "allow", "bash": "allow",
        "task": "deny", "kiokuko_*": "deny", "external_directory": "ask"
      }
    }
  }
}
```
<!-- /kiokuko-custom-worker-example -->

<!-- kiokuko-custom-registration-example -->
```jsonc
// Merge these fields into the options object of your EXISTING Kiokuko plugin tuple:
// "plugin": [["kiokuko-ai@<installed-version>", { ...existing options, ...fields below }]]
{
  "orchestration": {
    "mode": "ask",
    "customAgents": {
      "gokiWorker": ["my-orchestration-worker"]
    }
  }
}
```
<!-- /kiokuko-custom-registration-example -->

[五种角色、混合提供商、权限和故障排查](docs/orchestration-models.md#custom-agents)。
