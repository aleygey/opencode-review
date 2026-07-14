# OC Review

[![Release](https://img.shields.io/github/v/release/aleygey/opencode-review)](https://github.com/aleygey/opencode-review/releases)
[![License](https://img.shields.io/github/license/aleygey/opencode-review)](LICENSE)

OC Review 是一款面向 [opencode](https://opencode.ai) 的 VS Code 扩展。它会记录 AI 修改代码前的基线，并在编辑器中集中展示后续变更，方便你逐文件审查、定位和回退。

扩展原生支持一个工作区内存在多个相互独立的 Git 仓库，包括多层嵌套仓库。每个仓库都会单独建立基线，避免子仓库中的修改被遗漏。

## 功能特性

- **集中审查变更**：按仓库和目录展示文件及 hunk，并统计新增、删除行数。
- **基线对比**：使用 VS Code 原生 Diff 编辑器比较基线与当前工作区。
- **编辑器内标记**：高亮新增行，并在删除位置提供可悬停查看的锚点。
- **快速导航**：在不同文件和 hunk 之间连续跳转。
- **多级回退**：支持按 hunk、文件、仓库或整个工作区回退，并可撤销或重做回退操作。
- **安全归属判断**：区分 agent 修改、人工修改、共同修改和未验证修改，降低误删用户代码的风险。
- **选区追问**：选中任意代码后直接向当前 opencode 会话提问，不限于已修改的代码。
- **大工作区优化**：持久化仓库索引，并根据文件事件按路径增量刷新；手动刷新仍会执行完整校验。

## 环境要求

- VS Code 1.90.0 或更高版本。
- `git` 已加入 `PATH`。
- 可访问的 opencode Server，默认地址为 `http://127.0.0.1:4096`。
- 扩展、工作区文件和 opencode Server 应运行在同一操作系统环境中。

如果使用 Remote SSH 或 WSL，请在对应的远程 VS Code 窗口中安装扩展，不要只安装在本地窗口。

## 安装

1. 从 [Releases](https://github.com/aleygey/opencode-review/releases) 下载最新的 `oc-review-*.vsix`。
2. 在 VS Code 中打开扩展视图。
3. 点击右上角 `…`，选择 **Install from VSIX...**。
4. 选择下载的 VSIX 文件并重新加载窗口。

当前版本：[下载 OC Review v0.11.0](https://github.com/aleygey/opencode-review/releases/download/v0.11.0/oc-review-0.11.0.vsix)

## 快速开始

### 1. 启动 opencode Server

在工作区或其上级目录运行：

```bash
opencode serve
```

为了让 agent 连续完成多文件修改，再由 OC Review 统一审查，建议在 `opencode.jsonc` 中使用以下配置：

```jsonc
{
  "permission": {
    "edit": "allow"
  },
  "snapshot": false
}
```

OC Review 使用自己的 Git 基线机制，因此不依赖 opencode 的 snapshot。

### 2. 连接 Server

打开工作区后，状态栏会显示 `OC: ...`。扩展会先读取 lock 文件，再尝试探测本机端口。

如果没有自动连接，请运行命令：

```text
OC Review: Connect to opencode Server
```

也可以通过 `ocReview.serverUrl` 手动指定 Server 地址。

### 3. 创建基线

首次使用时运行：

```text
OC Review: Checkpoint Now (New Baseline)
```

创建完成后即可让 opencode 修改代码。扩展会监听 agent 写入和文件系统事件，并把相对于基线的变化显示在资源管理器中的 **OC Review** 面板。

### 4. 审查并处理变更

- 单击文件打开基线与工作区的 Diff。
- 展开文件查看各个 hunk。
- 使用文件或 hunk 右侧的操作按钮执行回退。
- 确认所有修改后，运行 **Accept All (New Baseline)**，将当前内容设为新基线。
- 遇到连接、仓库发现或基线问题时，运行 **OC Review: Diagnose** 查看诊断信息。

## 常用命令与快捷键

| 操作 | 命令或快捷键 |
| --- | --- |
| 创建新基线 | `OC Review: Checkpoint Now (New Baseline)` |
| 完整刷新 | `OC Review: Refresh` |
| 接受全部修改并创建新基线 | `OC Review: Accept All (New Baseline)` |
| 跳到下一个变更 | `Ctrl+Alt+PageDown` |
| 跳到上一个变更 | `Ctrl+Alt+PageUp` |
| 向 opencode 询问选中代码 | `Ctrl+Alt+A` |
| 切换编辑器内变更标记 | `OC Review: Toggle Inline Marks` |
| 查看和切换历史基线 | `OC Review: Baselines...` |
| 回退整个工作区 | `OC Review: Revert All to Baseline` |
| 诊断问题 | `OC Review: Diagnose` |

完整命令列表可以在 VS Code 命令面板中输入 `OC Review` 查看。

## 大型工作区配置

OC Review 默认监听整个工作区。对于大型 monorepo，可以只保护常用源码目录，并排除确认不会被 agent 修改的生成目录或第三方目录：

```jsonc
{
  "ocReview.includePaths": [
    "src",
    "packages/app"
  ],
  "ocReview.excludeDirs": [
    "generated",
    "third_party_cache"
  ]
}
```

默认还会跳过 `.git`、`node_modules`、`dist`、`build`、`out`、`target`、`.venv`、`vendor`、`coverage` 等常见目录。

> [!WARNING]
> 被排除或未包含的路径不会建立基线，也不会显示在审查列表中，因此无法通过 OC Review 回退。请只排除确定不需要审查的目录。

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `ocReview.serverUrl` | 空 | opencode Server 地址；为空时自动发现。 |
| `ocReview.serverPassword` | 空 | Server 启用 HTTP Basic Auth 时使用的密码。 |
| `ocReview.probePorts` | `[4096]` | 自动发现时探测的本机端口。 |
| `ocReview.viewMode` | `tree` | 变更列表显示为目录树或平铺列表。 |
| `ocReview.autoCheckpoint` | `turn` | 在新一轮 opencode 对话开始且当前审查列表为空时自动创建基线。 |
| `ocReview.includePaths` | `[]` | 需要审查的工作区相对路径；为空表示整个工作区。 |
| `ocReview.excludeDirs` | `[]` | 额外排除的目录名称。 |
| `ocReview.strictAttribution` | `true` | 对未观察到 agent 写入的变更采用保守回退策略。 |
| `ocReview.inlineMarks` | `true` | 在编辑器中显示行级变更标记。 |
| `ocReview.codeLens` | `true` | 在变更块上方显示一键回退 CodeLens。 |
| `ocReview.notifyAgent` | `true` | 回退后通知对应会话重新读取文件，不触发新的模型响应。 |
| `ocReview.shadowDir` | 空 | 基线影子仓库的存储目录；为空时使用扩展全局存储。 |

## 安全模型

- 每个真实 Git 仓库都是独立的基线和回退单元，嵌套仓库不会被父仓库吞掉。
- 基线保存在独立的 shadow 仓库中，不修改真实仓库的 index，也不会执行 `git clean`。
- 文件内容按字节恢复；仓库级回退只删除能够确认由 agent 新增的文件。
- 如果 agent 修改后你又手动编辑了同一文件，该文件会被标记为共同修改，回退前需要再次确认。
- 扩展没有观察到 agent 写入的变更会被标记为未验证。默认严格模式下，这类变更需要显式确认后才能回退。
- hunk 级回退使用补丁上下文校验。如果磁盘内容已经发生漂移，操作会安全失败，而不是强行覆盖。

## 为什么要按仓库建立基线

一个工作区可能包含多个独立 Git 仓库，并且这些仓库不一定是 submodule。使用单一的顶层 shadow worktree 时，Git 可能把内层仓库视为 gitlink，从而漏掉其中的文件修改。

OC Review 会发现工作区内的每个 `.git` 目录或 gitdir 文件，将文件归属到最近的仓库根目录，并分别执行 checkpoint、diff 和 revert。这样既能完整展示嵌套仓库中的修改，也能保证回退操作不会越过仓库边界。

## 项目结构

```text
packages/
├── extension/    # VS Code 扩展、opencode 接入和界面
└── git-engine/   # 多仓库 checkpoint、diff 和回退引擎
```

Git 引擎使用 Node.js 和原生 Git 命令实现，不依赖运行时第三方包。扩展使用 TypeScript、VS Code Extension API 和 esbuild 构建。

## 本地开发

测试 Git 引擎：

```bash
cd packages/git-engine
npm install
npm test
```

构建和测试 VS Code 扩展：

```bash
cd packages/extension
npm install
npm run typecheck
npm test
npm run test:integration
npm run build
npm run package
```

打包完成后，VSIX 文件会生成在 `packages/extension` 目录中。

## 已知限制

- 扩展需要与 opencode Server 和工作区文件运行在同一操作系统环境中，不负责跨系统路径映射。
- VS Code Extension API 无法直接创建真正的编辑器 view zone，因此删除内容通过锚点和悬停提示展示；完整内容可在原生 Diff 编辑器中查看。
- 原生 Windows Git 对文件模式和符号链接的还原能力有限；Linux 和 WSL 下可以保留更多 Git 元数据。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
