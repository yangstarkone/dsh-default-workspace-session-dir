# dsh-default-workspace-session-dir

给 DeepSeek Harness（DSH）用的 Host 插件：**默认工作区**里每个真正开始干活的会话，自动获得一个以 `年-月-日-时-分` 命名的输出目录；**会话被归档时删除该目录**；**退出应用不删**。

适合把默认工作区当临时会话区的人：每个会话的产物自成一格，用完归档即清，不在工作区根目录留垃圾。

源码 / 问题反馈：<https://github.com/yangstarkone/dsh-default-workspace-session-dir>（MIT，欢迎 issue / PR）

## 安装

NPM 包安装（Web / TUI profile，一条命令）：

```bash
dsh plugin --profile web add dsh-default-workspace-session-dir
```

GitHub 源码安装（未发布 npm 时可用）：

```bash
dsh plugin --profile web add github:yangstarkone/dsh-default-workspace-session-dir
```

DeepSeek Harness Desktop：在「设置 → 插件市场」搜索安装，或用「自定义安装」填入 npm 包名 / GitHub 仓库 / 本地目录。

## 行为

| 场景 | 行为 |
|---|---|
| 会话在默认工作区里第一次真正执行（`agent/pre-step`） | 创建 `<默认工作区>\2026-10-24-11-09\`，并把路径注入会话上下文 |
| 只是打开/浏览会话 | 不创建目录 |
| 同一会话重启应用后再打开 | 复用原目录 |
| 归档 / 删除会话 | 删除该目录（先原子重命名到 `~/.dsh/session-trash`，再删副本；残留下次启动清） |
| 退出应用 | 不删除，目录保留 |
| 子代理 / 团队会话 | 目录嵌套在父会话目录 `subagents\<id>\` 下，随父会话一起删 |
| 其他工作区 | 完全不受影响 |

- 提示注入内容：本会话输出目录 = 实际路径；所有新生成文件写入该目录；只有用户明确要求时才删除。
- 目录冲突自动追加 `-2`、`-3`。
- 每个目录内有 `.dsh-session-dir.json` 标记（sessionId / 工作区路径 / 创建时间）。**没有该标记的目录永远不会被删除**；删除前还会校验路径、时间戳目录名和标记归属。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 中覆盖目标工作区（默认从 workspace 注册表读取 `defaultWorkspaceId` 的路径）：

```yaml
- id: default-workspace-session-dir
  config:
    workspacePath: 'D:\my-default-workspace'
```

## 兼容与依赖

- 已在 DeepSeek Harness Desktop（2026-10 开发预览版）验证；Web profile 使用同一套 Host 事件，理论同样可用（未逐版本验证，欢迎反馈）。
- Node.js >= 22.6。
- 依赖 DSH 的 `agent/pre-step`、`workspace/session-stop`、`domain/changed` 事件与 workspace 注册表（`~/.dsh/storages/workspace.json`）；读不到注册表时退回 `workingDirectory.defaultDirectory`。
- 插件按 profile 安装，只对安装它的 profile 生效。

## 权限与风险（请读）

- 插件运行在 DSH Host 进程内，只读写它自己创建的会话目录。
- **归档即真删**：目录内容（含生成的文件）会被删除；要保留的产物请先拷贝出去。
- 删除放在 `~/.dsh/session-trash` 的副本会在下次应用启动时清空。
- 日志：`~/.dsh/logs/default-workspace-session-dir.log`（只记录创建/复用/删除/拒绝原因，不记录文件内容）。
- 在 Windows 上，如果删除时某个程序正打开着该目录，系统可能短暂保留一个打不开的“删除挂起”目录名；本插件先用重命名移出工作区，避免这种情况出现在工作区里。

## 卸载

- Desktop：插件管理器/插件市场中卸载
- CLI：`dsh plugin --profile web remove dsh-default-workspace-session-dir`

卸载不会删除任何已存在的会话目录。

## English summary

A host-only DeepSeek Harness plugin. In the default workspace, every session that actually runs gets its own timestamped output folder; the folder is removed when the session is archived (not when the app quits). Sub-agent folders are nested under their parent session's folder. Only the default workspace is affected. Marked folders only — anything without the plugin's marker file is never removed.

Install: `dsh plugin --profile web add dsh-default-workspace-session-dir` (or install from GitHub, or via the Desktop plugin market).

## License

[MIT](LICENSE)
