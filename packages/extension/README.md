# OC Review 0.12

OC Review 是一个 OpenCode companion plugin + VS Code 审查界面，面向大型工作区和嵌套 Git 仓库。

默认 `plugin` 模式不递归扫描工作区、不创建全量 Git checkpoint，也不注册 `**/*` watcher。companion 在 OpenCode 的 tool hook 中只捕获本轮实际触达的路径，扩展再提供原生 Diff、行标记、跨文件导航、回退和 Quick Ask。

## 首次安装

1. 安装本 VSIX。
2. 打开目标工作区。
3. 运行 `OC Review: Install/Upgrade OpenCode Companion Plugin`。
4. 重启 OpenCode。

companion 会安装到 `~/.config/opencode/plugins/opencode-review.js`。VSIX 已包含插件，不需要单独安装 npm 包。

在 WSL 或 Remote SSH 中使用时，请在对应远程 VS Code 窗口安装 VSIX并运行上述命令；扩展、OpenCode 和工作区必须处于同一个环境。

## 审查流程

1. 让 OpenCode 完成一轮修改。
2. 在 Explorer 的 **OC Review** 视图打开每个文件 Diff。
3. 使用 **Toggle Reviewed** 确认文件。
4. 用 `Ctrl+Alt+PageDown/PageUp` 跳转所有 hunk。
5. 全部确认后运行 **Accept Reviewed Epoch**。

同一 session 的一轮修改不会逐文件阻塞。session idle 后 epoch 才关闭；上一轮未接受时，下一轮的第一个 mutation 会被 companion 阻止。无需把 `permission.edit` 设置为 `ask`。

## Shell 与冲突

文件工具 `edit/write/patch/apply_patch/multiedit` 会自动精确捕获。shell 写操作需要在第一行声明输出路径：

```bash
# oc-review-writes: ["src/a.ts", "src/b.ts"]
sed -i 's/old/new/g' src/a.ts src/b.ts
```

`git merge/rebase/cherry-pick/revert/pull/am/commit/checkout/switch/reset/restore/stash` 会自动记录命令前后的 tracked dirty 路径和 commit tree 变化；发生冲突时保存 `base / ours / theirs`，可从冲突文件菜单分别与当前工作区比较。会删除未跟踪文件的 `git clean`、`stash -u/--all` 和 `checkout -f` 仍需声明准确写路径。

未知 shell/custom tool 默认生成 coverage gap，接受 epoch 前必须显式确认。将 `ocReview.shellPolicy` 设为 `strict` 可直接阻止未知工具。

## Quick Ask

选中任意代码后按 `Ctrl+Alt+A`。Quick Ask 会 fork 最相关的 OpenCode session 以保留上下文，并禁用 edit、write、patch、shell 和 task 工具；问答不会污染原工作 session，也不会生成待审核写入。

Quick Ask 需要可访问的 OpenCode server。捕获和审查本身不依赖 server/SSE，只依赖本地 companion journal。

## 工位离线部署

只需要携带 `oc-review-0.12.0.vsix`：

```bash
code --install-extension oc-review-0.12.0.vsix --force
```

随后在目标 VS Code 环境运行 companion 安装命令并重启 OpenCode。默认数据位置：

- Linux/WSL/SSH：`~/.local/share/opencode-review`
- Windows：`%LOCALAPPDATA%\opencode-review`
- 自定义：`OC_REVIEW_HOME`

运行 `OC Review: Diagnose` 可查看 companion 版本、journal、数据目录、coverage gap 和 server 状态。

完整设计、配置和已知边界见 [GitHub repository](https://github.com/aleygey/opencode-review)。
