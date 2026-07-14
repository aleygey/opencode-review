# OC Review

[![License](https://img.shields.io/github/license/aleygey/opencode-review)](LICENSE)

OC Review 是一个 OpenCode companion plugin + VS Code 扩展，用来集中审查 OpenCode 实际写入磁盘的改动。

v0.12 默认使用 **OpenCode-first capture**：不遍历工作区、不扫描全部 Git 仓库、不创建全量 checkpoint，也不注册 VS Code `**/*` watcher。OpenCode 插件只记录本轮工具实际触达的路径，VS Code 再按这些路径生成 Diff、标记、导航和回退。

这套设计面向以下场景：

- 超大代码库和性能较弱的开发机。
- 一个工作区包含多个独立 Git 仓库，且仓库可以嵌套。
- merge、rebase、cherry-pick 或跨分支搬功能时，需要检查冲突处理是否被粗暴二选一。
- 希望 OpenCode 连续完成一轮修改后统一审查，而不是每次 edit 都等待 permission reply。

## 工作方式

```text
OpenCode tool hook
  ├─ edit/write/apply_patch: 精确捕获触达路径的 before/after
  ├─ shell: 声明写路径，或产生 coverage gap
  └─ Git transition: 捕获命令前后状态、HEAD 变化和冲突 stage
                  │
                  ▼
       JSONL journal + content-addressed blobs
                  │
                  ▼
            VS Code OC Review
  Diff / 行标记 / 快速跳转 / 回退 / Quick Ask / 审核确认
```

OpenCode 一轮执行期间不会逐次阻塞。session 进入 idle 后，该轮 mutation epoch 才关闭；如果 `ocReview.enforceReview` 为 `true`，同一 session 的**下一次写操作**会等待上一轮在 VS Code 中全部审查并接受。只读工具仍可继续运行。

这不依赖 `permission.edit=ask`，因此不会在每个文件修改处同步等待。

## 功能

- 原生 VS Code Diff：基线内容与当前磁盘内容对比。
- 编辑器内新增行、删除锚点和 hunk CodeLens。
- `Ctrl+Alt+PageDown/PageUp` 快速跳转所有改动。
- 每个文件显式标记 Reviewed；存在未审查文件时不能接受 epoch。
- 文件在 OpenCode 写入后又被人工修改时标记为 `co-touched`，原审核标记自动失效。
- 支持按 hunk、文件、仓库或整批回退，并支持撤销/重做回退。
- Git 冲突保存 `base / ours / theirs`，冲突文件菜单可分别与当前结果比较。
- `Ctrl+Alt+A` 可询问任意选区；Quick Ask fork 原 session 保留上下文，但禁用写文件、shell 和 task 工具。
- 未知 shell/custom tool 在 `audit` 模式生成显眼的 coverage gap，接受前必须单独确认。
- 原 v0.11 Git checkpoint 引擎保留为显式 `legacy-git` 兼容模式。

## 捕获覆盖范围

| 来源 | 默认处理 |
| --- | --- |
| `edit`、`write`、`patch`、`apply_patch`、`multiedit` | 工具运行前后精确捕获目标文件。 |
| `cp`、`mv`、`rm`、`sed -i`、重定向、PowerShell 写命令等 | 没有声明输出路径时阻止，并要求重试。 |
| `git merge/rebase/cherry-pick/revert/pull/am/commit/checkout/switch/reset/restore/stash` | 自动记录命令前后的 tracked dirty 路径和旧/新 HEAD；冲突时保存 Git stage 1/2/3。支持 `git -C` 和简单的 `cd ... && git ...`。 |
| `git clean`、`git stash -u/--all`、`git checkout -f` | 可能删除无法从 post-state 推导的未跟踪文件，必须声明准确输出路径。 |
| test/build/脚本解释器等可能产生文件的命令 | 不假定只读；`audit` 下生成 coverage gap，或用写路径标记声明输出。 |
| 无法证明只读的 shell/custom tool | `audit`：记录 coverage gap；`strict`：阻止；`off`：放行。 |
| OpenCode 之外的人工操作、IDE refactor、其他后台进程 | 故意不捕获。它们不属于 OpenCode 改动。 |

对会写文件的 shell 命令，在命令第一行声明准确输出路径：

```bash
# oc-review-writes: ["services/api/src/a.ts", "services/api/src/b.ts"]
sed -i 's/old/new/g' services/api/src/a.ts services/api/src/b.ts
```

该标记在执行前会被 companion 移除，不会改变实际命令。路径相对于 OpenCode 当前目录，也可以使用绝对路径。

## 环境要求

- VS Code 1.90 或更高版本。
- OpenCode 支持本地 plugin hooks。
- `git` 在 `PATH` 中。普通 edit/write 捕获不依赖 Git；Git transition 和文本 Diff 使用 Git。
- VS Code 扩展 host、OpenCode 和工作区文件必须处于同一操作系统环境。

> 在 WSL 或 Remote SSH 中运行 OpenCode 时，必须把扩展安装到对应的 WSL/远程扩展 host。只装在本地 Windows 侧无法读取远端 journal 和文件。

## 安装与部署

### 使用 VSIX

1. 获取 `oc-review-0.12.0.vsix`。
   - GitHub Actions 的 `build-and-test` workflow 会上传名为 `oc-review-vsix` 的 artifact。
   - 也可以按下方命令从源码本地打包。
2. 在目标 VS Code 窗口执行 **Extensions: Install from VSIX...**，或运行：

   ```bash
   code --install-extension oc-review-0.12.0.vsix --force
   ```

3. 打开代码工作区，运行：

   ```text
   OC Review: Install/Upgrade OpenCode Companion Plugin
   ```

4. 重启正在运行的 OpenCode 进程，让它重新加载插件。

安装命令会把 VSIX 内置的 companion 写到：

```text
~/.config/opencode/plugins/opencode-review.js
```

因此带到工位时只需要传一个 VSIX，不需要在工位执行 npm install，也不需要单独复制插件源码。

### WSL / Remote SSH

1. 在已经连接 WSL/SSH 的 VS Code 窗口中选择 **Install from VSIX...**。
2. 确认扩展显示为“Installed in WSL/SSH”，而不是只安装在 Local。
3. 在同一个远程窗口运行 companion 安装命令。
4. 在相同 WSL/SSH 环境中重启 OpenCode。

插件目标路径中的 `~` 属于远程用户。捕获数据默认保存在：

- Linux/WSL/SSH：`$XDG_DATA_HOME/opencode-review` 或 `~/.local/share/opencode-review`
- Windows：`%LOCALAPPDATA%\opencode-review`
- 自定义：设置环境变量 `OC_REVIEW_HOME`

### 从源码构建一个离线 VSIX

```bash
cd packages/extension
npm ci
npm run typecheck
npm test
npm run test:integration
npm run package
```

生成的 `packages/extension/oc-review-0.12.0.vsix` 已包含 companion plugin。

## OpenCode 配置

推荐让 OpenCode 正常连续写入，不使用逐文件 permission gate：

```jsonc
{
  "permission": {
    "edit": "allow"
  },
  "snapshot": false
}
```

`snapshot: false` 不是强制要求，只是避免同时维护 OpenCode 自带全量 snapshot。OC Review 的回退来自按触达路径保存的 CAS，不依赖 OpenCode snapshot。

捕获本身不需要 `opencode serve`。Quick Ask、session 归属和回退通知需要 HTTP/SSE 连接；可以运行：

```bash
opencode serve --port 4096
```

SSE 是一个长期保持的 HTTP 事件流。OC Review 仅用它接收 session 状态和问答相关事件；即使 SSE 断线，companion 的本地 journal 仍会继续捕获文件改动。

## 使用流程

1. 安装扩展和 companion，重启 OpenCode。
2. 让 OpenCode 完成一轮修改。
3. 在 Explorer 的 **OC Review** 视图逐项打开 Diff。
4. 使用上下文菜单 **Toggle Reviewed** 标记确认过的文件。
5. 对冲突文件分别查看 Base、Ours、Theirs；必要时用 Quick Ask 询问当前选区。
6. 全部文件 Reviewed 后运行 **Accept Reviewed Epoch**。
7. 如果存在 coverage gap，扩展会单独列出并要求显式确认；确认后该 session 的下一轮写操作才会放行。

OpenCode 在 `session.idle` 前异常退出时，companion 下次启动会恢复已有成功写入记录的 orphan epoch，不会让这批改动永久卡住。

## 主要设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `ocReview.captureMode` | `plugin` | 默认无扫描捕获；`legacy-git` 启用旧 checkpoint 引擎。切换后需 Reload Window。 |
| `ocReview.shellPolicy` | `audit` | 未知 shell/custom tool 的策略：`strict`、`audit`、`off`。 |
| `ocReview.enforceReview` | `true` | 上一轮未接受时，阻止同一 session 的下一次 mutation。 |
| `ocReview.maxBlobBytes` | `20971520` | 单文件 CAS 上限。超限文件仍显示，但无法保证字节级回退。 |
| `ocReview.serverUrl` | 空 | OpenCode server 地址；为空时读取 lock 文件并探测端口。 |
| `ocReview.serverPassword` | 空 | OpenCode server Basic Auth 密码。 |
| `ocReview.inlineMarks` | `true` | 编辑器内显示行级改动标记。 |
| `ocReview.codeLens` | `true` | hunk 上方显示回退 CodeLens。 |
| `ocReview.notifyAgent` | `true` | 回退后向原 session 注入只读通知，不触发模型回复。 |

`includePaths`、`excludeDirs`、`shadowDir` 和 `autoCheckpoint` 只影响 `legacy-git` 模式。

## 性能模型

默认 plugin 模式的常驻工作量是：

- 扫描少量 OC Review instance 元数据，而不是工作区目录。
- 增量读取 append-only JSONL journal。
- 只对当前未接受 epoch 中已触达的文件检查 `mtime/size`。
- 仅当该文件变化时重新生成单文件 Diff。
- 只有执行 Git transition 时，才做一次命令前/后的 repo status 和 commit-tree diff；旧 blob 按触达路径分块、批量读取，不会周期性运行或遍历整棵 tree。
- blob 按 SHA-256 去重；已接受 journal 在下一次 mutation 时压缩，七天以上且无引用的 blob 每天最多清理一次。

不会执行：递归 repo discovery、全仓库 `git status` 轮询、全量 checkpoint、全工作区 watcher。

## 诊断

运行：

```text
OC Review: Diagnose
```

输出面板会显示 capture mode、数据目录、companion 目标路径、已发现 plugin 版本、journal 路径、coverage gap 和 OpenCode server 状态。

状态栏显示 `OC: plugin missing` 时，通常是 companion 尚未安装，或 OpenCode 安装后还没有重启/执行过任何 hook。

## 已知边界

- 默认模式只保证 OpenCode 内置文件工具、声明写路径的 shell、已识别 Git transition，以及未知工具的显式 gap；它不通过全量扫描猜测外部进程改了什么。
- `audit` 模式允许无法证明写集合的工具执行，因此 gap 表示“这一段覆盖不完整”。要求绝不放行时使用 `strict`。
- Git transition 会在命令前后各执行一次 `git status --untracked-files=no`，用于保护已有未提交修改并覆盖 `merge --no-commit`；Git hook 额外生成的未跟踪文件仍应使用路径声明。
- 超过 `maxBlobBytes` 或不可读文件无法安全回退，扩展会按保守方式标记。
- 多根 VS Code workspace 当前以第一个 file-scheme workspace folder 为主；一个根目录下的任意数量嵌套仓库均可支持。
- Windows 对符号链接权限有限；WSL/Linux 能更完整保留 symlink 和 mode。

## 项目结构

```text
packages/
├── protocol/          # VS Code 与 companion 共用的 journal/CAS 协议
├── opencode-plugin/   # OpenCode tool hooks、epoch barrier、冲突捕获
├── extension/         # VS Code UI、Diff、导航、Quick Ask、VSIX 打包
└── git-engine/        # legacy-git 兼容模式
```

## License

[MIT](LICENSE)
