# Pi 运行时与配置架构（`pi-studio`）

本文档记录 `pi-studio` 与本机 `@earendil-works/pi-coding-agent`（`v1.5.2+`）协作的完整边界、RPC 通信协议、设置文件映射及测试替身机制。

## 1. 进程拓扑与发现机制（`src/main/pi/discover.ts`）

1. **CLI 发现优先级**：
   - 未打包开发/测试态下，若设置了环境变量 `STUDIO_TEST_PI`（或兼容旧 E2E 的 `STUDIO_TEST_OMP`），优先使用测试替身 `test/fake-pi/fake-pi.mjs`。
   - 查找 `%LOCALAPPDATA%\pi-studio\runtime`（Windows）或 `<userData>/pi-runtime` 下由 `PiRuntimeManager` 独立维护的 `@earendil-works/pi-coding-agent` 安装。
   - 查找系统 `PATH` 及常见全局目录（npm prefix、Volta、fnm、pnpm、Bun、Homebrew）中的 `pi`。
2. **Windows `.cmd` 直连解析**：
   - Windows 上 npm 全局生成的 `pi.cmd` 若直接交给子进程会多套一层 `cmd.exe`，信号转发与标准输入关闭容易失灵；`discover.ts` 会解析 `pi.cmd` 提取底层 `cli.js`，直接以 `node <cli.js>` 数组参数启动，全程禁用 `shell: true`。
3. **环境变量隔离**：
   - 默认不覆盖 `PI_CODING_AGENT_DIR`，使 `pi-studio` 与用户在终端里运行的 `pi` 天然共享 `~/.pi/agent/`。
   - 测试环境显式传入 `PI_CODING_AGENT_DIR=<临时目录>`，彻底隔离真实 `~/.pi`。

## 2. `pi --mode rpc` 通信与防坑（`src/main/pi/pi-rpc-client.ts`）

- **严格 LF 切帧**：Pi RPC 采用以 `\n` 结尾的 JSON Lines。JavaScript 字符串合法包含 `U+2028`（Line Separator）和 `U+2029`（Paragraph Separator），Node 内置 `readline` 会将它们当作换行符切碎 JSON；因此 `PiRpcClient` 使用 `StringDecoder("utf8")` 手动查找 `\n`（并剥离行尾可选 `\r`）。
- **核心 RPC 命令**：
  - 状态与目录：`get_state`、`get_messages`、`get_available_models`、`get_available_thinking_levels`、`get_commands`、`get_session_stats`
  - 对话与流控：`prompt`（返回 `{ disposition: "started" | "queued" | "handled" }`）、`steer`、`follow_up`、`clear_queue`、`abort`
  - 模型与思考：`set_model`、`cycle_model`、`set_thinking_level`、`cycle_thinking_level`（支持 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）
  - 会话树与维护：`new_session`、`switch_session`、`set_session_name`、`compact`、`export_html`、`get_tree`、`get_entries`、`get_fork_messages`、`fork`、`clone`
  - 扩展交互回包：`extension_ui_response`（针对 `extension_ui_request` 的 `select` / `confirm` / `input` / `editor` 请求，单向写回 stdin，无 `response` 帧）
- **POSIX 管道合并帧竞态防护（`src/main/pi/pi-task-runner.ts`）**：
  - 在 Linux / macOS 管道缓冲下，极快完成的轮次会把 `response(prompt)`、`agent_start`、流式消息、`agent_end` 合并进同一次 `stdout` 读取；同步事件监听器会在 `await client.prompt()` 微任务恢复前跑完整个生命周期并将状态机置回 `idle`。
  - `PiTaskRunner` 通过单调递增的 `#agentLifecycleSeq` 记录 `agent_start` / `agent_end` 序号：`await client.prompt()` 返回后仅当 `#agentLifecycleSeq` 未前进时才补发乐观 `agent_start`。

## 3. 事件桥接与历史水合（`src/main/pi/pi-tsp-bridge.ts`）

- 渲染层复用高性能 `TspView`（支持对话模式与轨迹模式一键切换、代码块语法高亮、Diff 块、Mermaid、KaTeX、工具折叠组与底部交互卡片）。
- `PiTspBridge` 负责两条路径：
  1. **实时流式路径**：将 `PiRpcEvent` 增量转换为 `TspDocMessage` 批次推送给前端。
  2. **离线水合路径**：冷启动或切换历史会话时直接流式解析 `~/.pi/agent/sessions/**/*.jsonl`（兼容 v3 树状 `id`/`parentId` 条目、分支回退、压缩摘要与工具结果），无需先拉起 `pi` 子进程即可秒开历史记录。
- **就地撤回的写入顺序**：`PiTaskRunner.rewindTo` 必须先等旧 Pi 进程退出，再截断同一个会话文件，随后重开进程；整段操作期间 `start()` 等待撤回完成，避免并发发送提前加载旧历史。Pi 1.5.2 的 `switchSession` 会先打开文件再触发旧会话的 `session_shutdown`，扩展此时可能追加仍指向旧叶子的条目；先截断再切换会留下断链，使历史显示为空。截断落盘后立即重新水合文档，即使后续启动失败也保持界面与文件一致（隔离的 fake-pi 集成回归与 Electron E2E 验证）。
- **撤回不等重开进程**：`rewindTo` 只等到“旧进程已退出 + 文件已截断 + 对话已重新水合”就返回（启动 + 握手 + 再读会话放在 `#rewindRestart` 里后台跑），这样确认弹窗和输入框回填是两百毫秒级而不是一次进程启动的时长。`#rewinding` 仍然覆盖整段（含后台重开），`start()` / `close()` / 并发撤回都等它；用户撤回后立刻发新消息时，会先等后台进程就绪再发，不会加载到旧历史。
- **打开模型选择器不重开进程**：`PiTaskRunner.listModels` 只把活进程快照与服务进程现读的目录合并后返回，从不在这里 `restart()`（空闲重开一次 0.4–3 秒，会卡住选择器）；新加的模型选中时 `set_model` 报 `Model not found`，由 `setModel` 重开一次再设。渲染进程用上次的目录先画表（`features/composer/model-list-cache.ts`），骨架屏只在真的一个模型都没有时出现。
- **`starting` 必须是瞬时态**：`PiTaskRunner.#startInternal` 用 `finally` 保证不论怎么退出都落成 `idle`/`error`/`stopped`（看门狗 60 秒），`#ensureStarted` 遇到“状态还是 `starting` 但没在飞的启动”先自愈成 `stopped`。之前启动链上无上限的 `await`（抢名额、发现 pi、读默认模型）一旦不返回，任务就永远停在“启动中…”，而 `#startInternal` 开头的守卫又让 `start()` 直接报错，用户只能重开应用。
- **发送先回显**：`sendPrompt` 在建进程之前就把用户消息画进对话（`appendOptimisticUserMessage` 返回卡片 id），启动失败用 `rollbackOptimisticUserMessage` 撤回；重新水合（fork / 新会话）时 `appendPendingEchoes` 把还没被 Pi 回认的卡片补回末尾，Pi 回认后从待认表里移除，不会重复。
- **宿主标签清洗（`src/shared/ui/clean-title.ts`）**：会话标题提取时自动剥离 `<t3_code_instructions>`、`<system-reminder>`、`<USER_REQUEST>` 等外部宿主注入的闭合或截断 XML 块，避免污染侧栏标题。

## 4. 配置文件映射与安全边界（`src/main/pi/pi-config.ts`）

`pi-studio` 的 8 大设置中心通过 `pi:*` IPC 通道（`src/main/ipc/pi-handlers.ts`）管理以下文件，所有写操作统一走 `atomicWrite` 并保留未知字段：

| 文件路径（全局 `~/.pi/agent/` 或项目 `<cwd>/.pi/`） | 对应设置分区与职责 | 安全约束 |
| --- | --- | --- |
| `settings.json` | 默认 Provider/模型、默认思考强度、`enabledModels`、自动压缩（`compaction`）、队列投递模式、`builtin:*` 扩展开关、工具与 CodeMode、传输/终端高级项 | JSON 合并写，保留未知键 |
| `auth.json` + `.env` | Provider API Key 与 OAuth 凭据状态（配合 `pi /login` 终端登录流） | **密钥只进不出**：前端仅获知布尔状态与脱敏来源（如环境变量名），日志严禁打印密钥 |
| `models.json` | 自定义 OpenAI / Anthropic / Google 兼容网关与模型列表 | 保留非表单字段，API Key 支持引用环境变量 |
| `mcp.json` | 全局与项目级 MCP Server 增删改查 | JSON 校验通过后原子替换 |
| `keybindings.json` | Pi 键位绑定覆盖 | JSON 校验后写入 |
| `AGENTS.md` / `SYSTEM.md` / `APPEND_SYSTEM.md` | 全局与项目级上下文规则、系统提示词覆盖与追加 | 原样保存 UTF-8 文本 |
| `skills/`、`prompts/`、`extensions/` | 本地 Skill 文件夹导入/移入回收站、提示词模板列表、自定义扩展与 `pi install/remove/update` 包管理 | 删除本地 Skill 走系统回收站，包名严格校验防参数注入 |

## 5. 模型能力（思考档位）与模型目录刷新

- **思考档位来自模型自己的显式能力，不看模型名也不硬编码**：`src/shared/pi-model-capability.ts` 的 `piModelThinkingLevels` 与 Pi 的 `getSupportedThinkingLevels`（`@earendil-works/pi-ai` `dist/models.js`）逐条一致——`reasoning` 不为 true 只有 `off`；`off`…`high` 默认支持，除非 `thinkingLevelMap` 里写 `null`；**`xhigh` / `max` 只在 `thinkingLevelMap` 里显式映射了非 null 值时才支持**（Pi 1.5.2 实测：同一份 `models.json`，没写 map 的 reasoning 模型 `get_available_thinking_levels` 只到 `high`，显式映射 `xhigh`/`max` 的模型回到 `off`…`max`）。所以自定义模型想在界面上选到 `xhigh` / `max`，要在 `~/.pi/agent/models.json` 的模型条目里写 `"thinkingLevelMap": { "xhigh": "xhigh", "max": "max" }`（想藏掉某一档就写 `null`）。`toModelOption`（`pi-service.ts`）把推导结果放进 `ModelOption.thinkingEfforts`，草稿/已结束会话的档位、模型选择器、`/effort` 都用它；活进程仍以 `get_available_thinking_levels` 为准。
- **模型表在 Pi 进程启动时读一次**：`ModelRuntime.create` → `ModelConfig.load`，`get_available_models` 返回的是那一刻的快照。所以：
  - 服务进程（草稿、设置页）按 `catalogStamp()` 校验输入指纹，`models.json` / `auth.json` / `.env` / 版本 / key 环境变量变了就重起（`PiService.syncInputs`）；
  - 任务的旧会话（长驻进程）在 `PiTaskRunner.listModels` 里把进程快照和服务进程现读的目录按“模型 + 能力”合并后返回，**不在打开选择器时重开进程**；`setModel` 碰到 `Model not found` 才重开一次再设（同一个会话文件）。

## 6. 斜杠命令体系

- 输入框 `/` 菜单的数据源为 `src/shared/omp-output/slash-table.ts`（定义 Pi 1.5.2 原生 24 条斜杠命令，按模型/配置/会话/分支进行分类）叠加 `pi --mode rpc` 的 `get_commands` 返回的动态扩展命令、Prompt 模板与 Skill 命令。
- `src/renderer/src/features/palette/slash-commands.ts` **不调用** `mergeTuiCommands`，确保旧体系命令不会泄漏到输入框补全列表中（由 `test/pi-slash-table.test.ts` 与 `test/e2e/pi-settings.e2e.ts` 双重守护）。

## 7. 测试替身（`test/fake-pi/fake-pi.mjs`）

- 完整模拟 `pi --mode rpc`、`-p`（单次打印模式，供 `/btw` 使用）、`--version`、`--export` 及 `install/remove/update/list` 子命令。
- 支持确定性触发器以便在无真实模型密钥的 CI 上测试全链路：
  - 普通文本：流式返回思考块与两段增量回复并落盘 v3 `.jsonl` 会话文件；
  - `[tool]` / `[edit]` / `[bash]`：触发完整工具调用与增量输出事件；
  - `[ask:select]` / `[ask:input]` / `[ask:editor]` / `[confirm]`：触发 `extension_ui_request` 并等待前端交互回包；
  - `[slow]`：慢速分块流式输出，供测试中断（`abort`）与忙碌时 `steer` / `followUp` 排队；
  - `[error]`：模拟模型报错返回。
- `test/fake-pi/catalog-rpc.mjs`：只模拟“模型表在启动时读一次”的最小替身——启动时读 `CATALOG_DIR/catalog.json`，`get_available_models` 永远回那一刻的快照，`set_model` 只认快照里的模型；`spawns.log` 记每起一个进程。旧会话补新模型的重开、服务进程输入指纹变化的重起都靠它测（`test/pi-model-catalog-refresh.test.ts`）。
