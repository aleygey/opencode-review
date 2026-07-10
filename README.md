# oc-review — opencode 的 VSCode 变更审查 + 追问扩展

给 [opencode](https://opencode.ai) AI 编码 agent 补上 IDE 内的改动审查体验:看清改动、强制过目、diff 标记、快速跳转、选区追问。定位类似 Cursor 的 review 流,但**不 fork 任何现有扩展**,从零构建。

对应 opencode 社区诉求 issue #9578 / #8003(官方与现有社区扩展均未实现该工作流)。

---

## 🚀 快速开始(工位测试)

前提:Linux/WSL 侧装有 `git` 和 opencode;VSCode 通过 **Remote-SSH / Remote-WSL** 连到 server 所在系统(扩展要和 opencode、你的文件在同一 OS)。

1. 从 [Releases](https://github.com/aleygey/opencode-review/releases) 下载 `oc-review-*.vsix`。
2. 在**远程窗口**里安装:扩展面板 → `⋯` → *Install from VSIX*(装到 "SSH: xxx" / "WSL" 那一侧,不是本地)。
3. opencode 配置(`opencode.jsonc`)推荐加:`{ "permission": { "edit": "allow" }, "snapshot": false }`,然后在工作区里跑 `opencode serve`(默认 4096;TUI 另开)。
4. 打开工作区 → 状态栏出现 `OC: …`;不通就跑命令 `OC Review: Connect to opencode Server`。
5. 跑一次 `OC Review: Checkpoint Now` 建基线 → 让 opencode 干活 → 左侧 OC Review 面板逐文件/逐 hunk 审查、跳转(`Ctrl+Alt+PgDn/PgUp`)、回滚;选中代码 `Ctrl+Alt+A` 追问。
6. 有问题先跑 `OC Review: Diagnose`,把输出发 issue。

详细功能与安全模型见 [packages/extension/README.md](packages/extension/README.md)。

---

## 要解决的 5 个痛点

1. 改动能看到,但要进文件里才看得清 → 编辑器内直接呈现 diff。
2. 想强制过目所有改动,心里有底 → 汇总变更、逐项可审。
3. diff 标记确认改动范围 → gutter / 滚动条 / 内联高亮。
4. 快速跳转所有改动 → 变更树 + hunk/文件间跳转。
5. 选区「问为什么」(改动与非改动都能问)→ 右键 quick-ask → session.prompt。

## 核心设计决策

- **不用权限门控(non-blocking)**。opencode 的 `permission.edit:"ask"` 是**同步阻塞**,多文件改动会逐个卡住 agent。改为放开写(`permission.edit:"allow"`),事后审查。可选:只给 `bash`/删除类高危操作保留门控。
- **审查与回滚引擎 = 真实的 per-repo git**,不用 opencode 的 snapshot。原因见下"嵌套仓库"。`opencode.jsonc` 里设 `"snapshot": false`。
- **内联 diff,不左右分屏**(用户屏幕放不下)。省事版 = diff 编辑器 `renderSideBySide:false`;真内联 = 真实文件上 `decoration`(新增行)+ view-zone(幽灵删除行)。
- **不 fork OpenCodeGUI**:它的 UI 是不可改的压缩 blob,核心逻辑是两个 ~9k 行巨石文件,且默认行为(左右分屏 / 阻塞门控 / 单一扁平 worktree / 选区仅预填)全与本项目目标相反。仅参考其 `.opencode/server.lock.json` 端口发现约定。

## ⚠️ 嵌套 git 仓库问题(本项目最独特的约束)

工作区是**一个顶层目录,内部各级子目录散布着多个相互独立的 git 仓库**(不是 submodule)。

- opencode 的 snapshot 和 OpenCodeGUI 的 undo **都用单一扁平 shadow git**,git 把子目录里的 `.git` 当"嵌入式仓库/gitlink"不递归 → **子仓库内的改动被静默漏掉**,既看不到 diff 也回滚不了(且不报错 = 假安全感)。
- 本项目解法:**把每个真实 git 仓库当独立回滚单元**。发现所有 `.git` → 每个 repo 用临时 index(`GIT_INDEX_FILE`)建零副作用 checkpoint → 每个改动文件按"最近祖先 `.git`"归属到对应 repo → 所有 diff/回滚都 `git -C <repo>` 精确限定边界。per-hunk 回滚用 `git apply --reverse`。

> 具体 git 命令配方正在用并行 agent 在合成嵌套仓库上**实测硬化**(数据丢失 / 结果错误 / 嵌套边界三类对抗测试),结果落到 `packages/git-engine`。

## 架构(三层)

| 层 | 包 | 职责 |
|---|---|---|
| ① opencode 接入 | `packages/extension`(接入部分) | 发现/连 server(SDK v2 或 lock 文件)、订阅 `/event` SSE、`session.prompt` 发问;放开权限 |
| ② git 引擎(核心) | `packages/git-engine` | `discoverRepos` / `checkpoint` / `collectChanges` / `revert`;纯 Node、多仓库、per-hunk、零副作用、CLI 可测 |
| ③ VSCode 呈现 | `packages/extension`(UI 部分) | 内联 diff、变更树(TreeView)、hunk/文件跳转、选区 quick-ask → Webview |

**技术栈**:TypeScript · `@opencode-ai/sdk/v2` · 原生 `git`(`child_process`,需要 `GIT_INDEX_FILE` 等底层技巧,不用封装库)· esbuild(扩展打包)· VSCode Extension API。

## 阶段

- **P0 ✅** `packages/git-engine`:发现 repo → checkpoint → 多仓库 diff 聚合 → 三粒度回滚(文件/hunk/仓库),CLI + 9 项硬化测试(T1/T3/T9/T14/T17/T21/T23/T24)。
- **P1 ✅** opencode 接入(server 发现 + SSE + AgentWriteRecord 归属)+ 变更树 + 状态栏 + 权限通知。
- **P2 ✅** 选区 quick-ask(`Ctrl+Alt+A`,流式答案面板,改动/非改动都能问)。
- **P3 ✅** 精修:内联改动标记(新增行底色 + 删除锚点 hover 显示被删内容)、per-hunk 回滚(带确认与归属守卫)、hunk/文件跳转、diff 编辑器(基线↔工作区)、Accept All、Diagnose。整套经过 25-agent 对抗审查,19 项确认问题全部修复(含 2 项可能吞用户改动的关键缺陷)。
- 已知取舍:删除行以"锚点+hover"呈现而非真正的幽灵行(VSCode 扩展 API 无 view-zone);内联标记之外,完整 diff 用原生 diff 编辑器(可在其内切 unified 视图)。

## 环境说明

- 引擎为纯 Node,逻辑与宿主无关;最终在 opencode server 所在的同一 OS 里运行(现 WSL,工位为 VirtualBox 上的 Ubuntu)。
- 开发一律 co-locate:VSCode 用 Remote-WSL(WSL)或 Remote-SSH / 原生(VM)attach,避免跨界路径映射。
- Windows 专属的 snapshot `.nothrow` stale bug 在真 Linux 上不触发;但嵌套仓库问题与平台无关,照上面处理。
