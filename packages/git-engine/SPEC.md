# git-engine — 规格(已实测硬化)

多仓库 git checkpoint / diff / rollback 引擎。纯 Node,无 VSCode 依赖。是整个扩展里正确性最关键的核心。

> 本规格由并行 agent 在真实 git(2.51,MSYS,语义等同 WSL/Linux 部署目标)上**实测**得出:三个配方 agent + 三个对抗 agent(数据丢失 / 结果错误 / 嵌套边界)+ 合成。每条命令与不变量都有对应测试(见测试矩阵)。

## 背景约束

- opencode **直接改盘**(无暂存)。本项目**不用权限门控**,edit 自由落盘,事后审查。
- 工作区 = 一个顶层目录,内部各级子目录散布**多个相互独立的 git 仓库**(非 submodule)。
- opencode 快照与 OpenCodeGUI 都用单一扁平 shadow git → git 把嵌套 `.git` 当 gitlink 不递归 → **子仓库改动被静默漏掉**。本引擎必须避免。

## 数据类型

```ts
type RepoInfo = {
  repoRoot: string          // 绝对、归一化、正斜杠
  relToWorkspace: string
  nestedChildren: string[]  // 仓库内相对路径,指向每个嵌套子仓库,如 'nested'、'a/b/c'
}

type CheckpointRef = {
  repoRoot: string
  commit: string            // sha
  ref: string               // refs/opencode/cp/<id>,存在 SHADOW 仓库里
  hadHead: boolean
}

type Hunk = { header: string /* @@ 行 */, body: string, agentAttributed: boolean }

type ChangeItem = {
  repoRoot: string
  path: string              // 仓库内相对路径
  oldPath?: string
  status: 'add' | 'mod' | 'del' | 'rename'
  isBinary: boolean
  modeChange?: { from: string, to: string }
  hunks: Hunk[]             // 仅文本
  patchHeader: string       // diff --git / index / --- / +++ 行
  coTouchedByUser?: boolean // 用户也动过 → 非安全可回滚
}

// opencode 提供:它自己写了哪些文件/内容(P1 接入层从 SSE 工具事件攒出)
type AgentWriteRecord = Map<string /*absPath*/, string /*agent 最后写入的内容*/>
```

## API

| 函数 | 行为要点 |
|---|---|
| `discoverRepos(workspaceRoot)` | 递归找每个 `.git`(**文件或目录**,用 `test -e` 或 `rev-parse --show-toplevel`,不能只 `test -d`)。为每个 repo 算 `nestedChildren`(严格在其下的其他 repo,仓库内相对路径)—— 这份清单对 checkpoint 排除和回滚边界都是**载荷关键**。按 root 排序以便最长前缀路由。 |
| `checkpoint(repos, {shadowDir, id})` | 每 repo 用**临时 index**(`GIT_INDEX_FILE`)把整棵工作树(含未跟踪、遵守 .gitignore)快照成 commit,对象 **push 到外部 shadow bare 仓库**,对用户 index/worktree/branch/HEAD/stash **零副作用**。 |
| `collectChanges(checkpoints, repos, {agentWrites?})` | 每 repo 独立 diff worktree vs checkpoint,聚合成 ChangeItem[]。**逐 repo 归属**,不做文件系统路由。带 agentWrites 时逐 hunk 标注 `agentAttributed` / `coTouchedByUser`。 |
| `revertFile(item, checkpoints, repos)` | 整文件回到 checkpoint,**raw blob write** 字节精确。先过边界守卫;`coTouchedByUser` 拒绝或先备份;add 文件则 `rm`(绝不 `git rm --cached`)。 |
| `revertHunk(item, hunk, repos)` | 仅逆用一个 agent 归属的 hunk:`patchHeader + @@块` → `git -C <repo> apply -R`。`!agentAttributed` 或 `coTouchedByUser` 拒绝。 |
| `revertRepo(repoRoot, checkpoints, changes, repos)` | 整仓库回到 checkpoint:(A) `ls-tree` 枚举 + raw blob write 每个文件;(B) 仅 `rm` agent 新增的文件;(C) 全程边界守卫。**绝不 `git clean` / `read-tree --reset` / `reset --hard`**。 |

## 已验证 git 配方

### checkpoint 一个 repo(零副作用、字节精确、排除嵌套、shadow 存储)
```bash
HAS_HEAD=$(git -C "$repo" rev-parse --verify -q HEAD >/dev/null 2>&1 && echo 1 || echo 0)
TMPIDX="$osTemp/oc-cp-$repoId-$rand"; rm -f "$TMPIDX"        # 唯一,.git 之外
# EXCL = 每个 nestedChild 一条 :(exclude,literal)<child>  —— 不要用 <rel>/** 的 glob 形式(会误伤 mod[a] vs moda)
GIT_INDEX_FILE="$TMPIDX" git -C "$repo" -c core.autocrlf=false -c core.safecrlf=false -c advice.addEmbeddedRepo=false add -A -- . $EXCL
TREE=$(GIT_INDEX_FILE="$TMPIDX" git -C "$repo" -c core.autocrlf=false write-tree)   # 空仓库 → 4b825dc6
if [ "$HAS_HEAD" = 1 ]; then CP=$(git -C "$repo" commit-tree "$TREE" -p HEAD -m 'opencode checkpoint');
else CP=$(git -C "$repo" commit-tree "$TREE" -m 'opencode checkpoint'); fi        # 无 HEAD 时不加 -p
git -C "$repo" push -q "$shadowDir/$repoKey.git" "$CP:refs/opencode/cp/$id"        # 对象拷出可被删的工作树
rm -f "$TMPIDX"   # finally
```

### collect 一个 repo(两边都 autocrlf=false、逐 repo 归属、不做 fs 路由)
```bash
TMPIDX="$osTemp/oc-col-$repoId-$rand"; rm -f "$TMPIDX"
GIT_INDEX_FILE="$TMPIDX" git -C "$repo" -c core.autocrlf=false add -A -- . $EXCL
GIT_INDEX_FILE="$TMPIDX" git -C "$repo" -c core.autocrlf=false diff-index -z --no-renames --name-status refs/opencode/cp/$id -- . $EXCL
GIT_INDEX_FILE="$TMPIDX" git -C "$repo" -c core.autocrlf=false diff-index --numstat  refs/opencode/cp/$id -- "$file"   # '-\t-' → binary
GIT_INDEX_FILE="$TMPIDX" git -C "$repo" -c core.autocrlf=false diff-index -p --unified=1 refs/opencode/cp/$id -- "$file"
GIT_INDEX_FILE="$TMPIDX" git -C "$repo" -c core.autocrlf=false diff-index -p --binary  refs/opencode/cp/$id -- "$file"
rm -f "$TMPIDX"
# 纯 chmod:numstat 0/0、无 @@,从 -p 的 'old mode'/'new mode' 解析,作为一等 modeChange。丢弃任何 160000 gitlink 行。
```

### revert 整文件(raw blob write,边界守卫)
```bash
# 守卫:path 不在任何 nestedChild 下、无 '..';coTouchedByUser → 拒绝或先备份
blob=$(git -C "$repo" rev-parse refs/opencode/cp/$id:"$path")
git -C "$repo" cat-file blob "$blob" > "$absPath"    # 唯一字节精确法(非 checkout-index/read-tree)
# status=add(checkpoint 无此文件):rm -f "$absPath"（绝不 git rm --cached）
# modeChange:按 ls-tree 的 mode chmod
```

### revert 单 hunk(逆用,仅 agent 归属)
```bash
# 拒绝 !agentAttributed / coTouchedByUser;守卫同上
printf '%s%s' "$patchHeader" "$hunkBlock" > "$osTemp/oc-hunk-$rand.patch"
git -C "$repo" apply -R "$osTemp/oc-hunk-$rand.patch"   # 只回该 hunk,CRLF 安全
# 二进制:git -C "$repo" apply -R --binary "$binaryPatch"
```

### revert 整仓库(无 git clean,保住用户文件 + 嵌套仓库)
```bash
git -C "$repo" ls-tree -r --name-only refs/opencode/cp/$id                # (A) 枚举;逐个(守卫)
blob=$(git -C "$repo" rev-parse refs/opencode/cp/$id:"$path"); git -C "$repo" cat-file blob "$blob" > "$repo/$path"   # + 恢复 mode
rm -f "$repo/$agentAddedPath"    # (B) 只删 agent 新增;绝不 git clean / git rm --cached
# (C) 若 agent 删了嵌套 repo 目录:从 shadow 恢复 → git init → raw blob write
```

## 测试矩阵(27 例)

T1 checkpoint 外层含嵌套:tree 无 160000;status/HEAD/branch/stash/真 index 的 write-tree 前后一致;只多一条 shadow ref。
T2 无排除 → 复现 gitlink 吞文件(证明排除是载荷)。
T3 CRLF/LF 在 autocrlf=true 下用 `-c core.autocrlf=false` → blob 字节精确。
T4 无 HEAD / 空仓库:不加 -p;空 → 4b825dc6;无误建分支。
T5 detached HEAD:commit-tree -p HEAD 成功,HEAD 仍 detached。
T6 嵌套 `.git` 是文件(--separate-git-dir):仍被发现并排除。
T7 `:(exclude)mod[a]/**` 误伤 `moda/` → 用 `:(exclude,literal)mod[a]` 修正。
T8 未改 CRLF 文件、collect 少了 autocrlf=false → 幻影 M;加上后消失且单行改动最小化。
T9 未跟踪 add / gitignore / 删除 / 二进制:临时 index 捕获 add、忽略 ignore、报 D、`-\t-` 标二进制。
T10 rename+edit 的 -z name-status 解析(R### \0old\0new\0)。
T11 无关的同内容 删+增 → -M 假造 R100;--no-renames 正确报 D+A(权威回滚模型)。
T12 纯 chmod(filemode=true):M + numstat 0/0 + 'old/new mode',作为一等 modeChange。
T13 删文件+空目录后用 `$(dirname) --show-toplevel` 路由 → FATAL;逐 repo diff-index 正确。
T14 checkout-index 回滚 LF(autocrlf=true)→ 变 CRLF;raw blob write 字节精确。
T15 in-tree `.gitattributes eol=crlf` 击穿 autocrlf=false 的 checkout-index;只有 raw blob write 精确。
T16 二进制经 `apply -R --binary` / raw blob write 往返字节一致。
T17 两处分离改动只回其一:附 patchHeader 后 `apply -R` 只回该 hunk。
T18 agent 改 l2 紧邻用户改 l3:-U0 也合并成一个 hunk → 必须标 coTouchedByUser 并拒绝。
T19 用户也改了同文件:整文件 blob 还原会吞用户改动 → 检测到与 checkpoint 和 agent 写入都不同 → 拒绝/备份。
T20 `git clean -fd/-ffd` → 删用户文件、毁整个嵌套仓库(证明 clean 禁用)。
T21 安全整仓库回滚:raw blob write 全部 + 只 rm agent 新增 → 用户文件、嵌套仓库、被删文件都保住,真 index 不变。
T22 `read-tree -u --reset` 无 GIT_INDEX_FILE → 毁用户暂存(证明必须临时 index / raw blob)。
T23 父层 `git -C outer apply` 用 nested/ 路径 → 泄漏进子仓库(证明 -C 不挡边界,需前缀守卫)。
T24 agent `rm -rf nested/` 后:存 repo 内 → 基线不可恢复;存外部 shadow → ref 仍在,可恢复整棵嵌套基线。
T25 嵌套 repo 本身被 .gitignore 忽略(如 `.opencode`/`source_code`):`:(exclude)` pathspec 点名被忽略路径会让 `git add` 报 "paths are ignored" 并退出 1 → 用 check-ignore 过滤,被忽略的子仓库不发 exclude(add -A 本就整体跳过);checkpoint/collect 成功且 tree 仍无该子树。
T26 collect 复用**持久化 index**(warm stat 缓存,大仓库把 refresh 从 O(整库) 降到 O(改动数)):连续多次 collect(改 → 再改+新增+删除 → 全还原)每次都对齐到当前工作区,零幻影条目;正确性靠 `isUnderNested` 后置过滤兜底 stale 的嵌套条目(故 checkpoint 不能复用、仍从空 index 起)。corrupt index 自愈:add 失败则删掉重试一次。
T25 用 `.git/index` 的 md5 当不变量是**假的**(git 读时 stat-refresh);真不变量 = status + HEAD + for-each-ref + stash + 真 index 的 write-tree。

## 开放风险 / 集成依赖

1. **安全回滚依赖 `AgentWriteRecord`**(opencode 提供它写了什么)。缺失时无法区分 agent 与用户对同一 hunk 的改动(T18/T19),必须保守拒绝共同触碰的文件/hunk,否则静默丢用户数据。这是对 opencode 的集成依赖,引擎单靠一次 worktree 快照无法解决。
2. **边界安全全靠 `discoverRepos` 找全每个嵌套 repo**(含 .git-as-file,T6)且排除清单完整;`-C` 不挡边界。每个写路径强制最长前缀守卫 + 硬拒 160000 gitlink。agent 可能新建/移动/删除 repo 时需重跑或增量更新 discoverRepos。
3. **shadow 对象库**须 GC 安全,且按 repo 身份(如首提交 sha / 存标记)而非路径映射,以免 repo 被移动后基线找不到。
4. **mode/symlink 保真受 git 平台约束**:Linux/WSL(filemode/symlinks=true)保留 100755/120000;Windows 原生 git 会丢失。raw blob write 内容处处字节精确,但 mode 需从 checkpoint tree 显式恢复(T12),Windows 上 symlink 可能退化为文本 blob —— 记为平台注意项。
5. `--no-renames` 作权威回滚模型 → 真实大重命名被建模为 删+增,回滚为两步(重建旧、删新);如需原子重命名回滚可另做展示层,但执行仍按 add/del 粒度避免耦合无关文件。
6. `-U1` hunk 因对着精确 checkpoint 而干净可用;若曾对漂移的 worktree 逆用可能失败 → `apply -R` 失败时回退整文件 raw blob write 并暴露冲突。
7. 并发:`GIT_INDEX_FILE` 与 hunk patch 临时文件须唯一命名、finally 清理;真 `.git/index` 从不打开,故崩溃不会损坏它,但预存的陈旧临时 index 会被当种子复用 → 用前必 `rm -f`。
