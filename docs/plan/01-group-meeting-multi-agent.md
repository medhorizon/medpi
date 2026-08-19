# 01. 组会：六智能体协作 UI 实施计划

- **状态**：M1 补丁已实现并通过当前验证；模型配置尚未满足 ready 条件；PI 编排待规划。
- **范围**：Pi-web 的本地、单用户、trusted-project 开发基线；不改变现有 `science_*`、kernel 或 notebook-cell 边界。
- **已有基础**：Pi-web 已可由 `/api/agent/new` 创建独立 `AgentSession`、按 session SSE 流式显示消息，并在 `rpc-manager.ts` 保持进程内 registry。当前 ModelsConfig 可见 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`deepseek-v4-flash`；未发现 `deepseek-v4-pro`，所以该角色在其 provider/认证配置完成前不得启动。

## 1. 已定需求

### 1.1 固定首届成员（恰好 6 个）

点击 WebUI “组会”按钮后，为当前项目创建一个会议，并唤醒六个彼此独立的 Pi session。表内模型 ID/思考等级是默认值；provider 必须由当前 Pi `ModelRuntime` 实际解析，不能从模型 ID 猜测。

| 角色 | 数量 | 默认模型 | 默认 thinking / reasoning effort | 首期交互权限 |
|---|---:|---|---|---|
| PI | 1 | `gpt-5.6-sol` | `max` | 唯一有用户输入框的主智能体 |
| 博士 1 | 1 | `gpt-5.6-sol` | `high` | 仅展示独立对话 |
| 博士 2 | 1 | `deepseek-v4-pro` | `max` | 仅展示独立对话 |
| 硕士 1 | 1 | `gpt-5.6-terra` | `xhigh` | 仅展示独立对话 |
| 硕士 2 | 1 | `deepseek-v4-flash` | `max` | 仅展示独立对话 |
| 本科 | 1 | `gpt-5.6-luna` | `max` | 仅展示独立对话 |

首个补丁中，“唤醒”只表示创建并持久化六个空 session，确认各自模型/思考等级并订阅 SSE；不自动发送任务，不触发模型推理。

### 1.2 UI

- 在现有会话顶栏或新会话入口加入可访问的“组会”按钮，具备创建中、成功、失败状态，防重复点击。
- 会议保留现有左侧会话栏、右侧文件栏；中间栏显示六个独立聊天窗。每个 pane **只含现有聊天中间栏内容**，不复制 sidebar、顶栏或文件面板。桌面端为清晰、可滚动的 3×2 网格，每格显示角色、实际模型、运行状态与该 session 的完整流式消息。
- 每格复用现有消息渲染、工具状态、SSE 重连和历史读取；不复制 `ChatWindow` 的消息协议。
- 仅 PI 格保留 `ChatInput`；其余五格明确显示“等待 PI 编排”，没有隐藏输入、自动 prompt 或假进度。
- 实现前以 `useIsMobile` 和现有布局约束确定窄屏策略。若六格不能保持可读，首个补丁显示“组会仅支持桌面”的明确状态，不挤压为不可用界面。

## 2. 暂缓设计（首期不得暗中实现）

- PI 如何分解、派发、追问、汇总、终止其他成员；成员间是否通信。
- 自动任务启动、共享上下文、工具/文件权限继承、成本或并发预算、跨会议恢复语义。
- reviewer 的身份与交互。当前六人名单**不含 reviewer**；未来若加入，PI 对 reviewer“不统筹”是权限约束，不得在首期创建第七个 session。
- 多用户、公开服务、跨浏览器同步、独立编排服务、Research Graph/GEPA/MCP sidecar，或任何 MedHorizon runtime 迁移。
- `.ipynb` 文档、第二套消息存储、第二套 agent runtime，或绕过 Pi `AgentSession`/ModelRuntime 的模型直连。

## 3. 数据与生命周期

### 3.1 一份会议元数据，六份既有 Pi session

新增最小会议记录：稳定 `meetingId`、创建时间、项目 `cwd`/project root、六个固定 `role`、每个角色的 `sessionId`、实际 `{provider, modelId, thinkingLevel}` 与状态（`creating`、`ready`、`failed`、`closed`）。不复制消息或 token；消息仍只在 Pi session `.jsonl` 中保存。

记录放在已有 Pi 用户数据范围、按项目隔离，并采用现有 session 等价的原子写入方式。记录实际模型选择，使历史会议不需要重新解析到另一个模型。

### 3.2 创建、失败与恢复

1. 前端请求创建；服务端校验项目路径、trust、六个模型可见且已认证、thinking level 可被 Pi runtime 接受。
2. 服务端逐一调用既有创建路径创建空 `AgentSession`（`type: "ensure_session"`），从实际返回值记录 session ID、模型和等级；不可只相信前端默认值。
3. 六个全部成功后才原子标为 `ready` 并返回会议描述，前端再建立六条 SSE/状态连接。
4. 任一步失败，返回失败角色及可修复诊断（如缺少 `deepseek-v4-pro`）；不静默降级模型。已创建但未 ready 的 session 必须显式清理或保留为可追踪失败记录，待复用 Pi session 生命周期 API 后定案。
5. 刷新从会议元数据恢复同一六个 session，绝不重建。关闭会议仅停页面订阅/运行时 wrapper，不删除用户 session 历史；删除/归档另行设计。

### 3.3 并发边界

- 六个 session 可同时运行，但首期无自动 prompt，因此创建不产生六模型推理费用。
- 沿用 `rpc-manager.ts` 的 `globalThis` registry、每-session start lock、idle shutdown、SSE reconnect；会议层只聚合 session 引用。
- PI 输入仅发送 PI 的 `sessionId`。获得明确编排协议前，任何代码不得把 PI 文本复制给五位成员。

## 4. API 与前端边界

### 服务端

- 新增会议资源路由（建议 `/api/meetings`）：`POST` 创建，`GET` 按项目读/列出可恢复会议，`GET /api/meetings/[id]` 读单会议。首期不提供“向成员发消息”的会议 API。
- 从 `/api/agent/new` 背后抽取共享的 session 创建函数，供原路由与会议创建路由共同调用；该函数复用 `startRpcSession()` 与 `AgentSessionWrapper.send({ type: "get_state" })`。可见模型和 thinking 校验复用 `resolveVisibleModels()` 与已有规则，不通过 HTTP 调用该路由或复制其创建逻辑，也不手写兼容表。
- session 状态/事件继续走既有 `/api/agent/[id]` 与 `/api/agent/[id]/events`，不新增转发 SSE、轮询器或 WebSocket。

### 前端

- 新建小型 `GroupMeetingView`/`MeetingAgentPane`；以六次受控单-session 状态绑定角色，避免把六份可变消息塞进一个大 hook。
- `AppShell` 只负责进出会议、传递当前项目路径，普通会话/side bar/file panel 行为不变。
- PI pane 复用 `ChatInput` 和现有 command 路径；非 PI pane 为只读。消息复用 `MessageView`，保留 Markdown、工具调用、Notebook cell renderer 和安全转义。
- 运行时校验 API 返回值：固定六角色、role/sessionId 无重复、项目匹配当前视图。异常数据只显示错误，不猜测修复。

## 5. 分阶段实施与验收

### 阶段 A：会议合同与预检查

产物：共享 TypeScript meeting types、会议记录读写、模型可用性检查、会议创建/读取 API，以及对应单元/API 测试。

- 未配置或未认证 `deepseek-v4-pro` 时，明确指出对应博士角色并拒绝创建 ready 会议；不替换模型。
- 六模型均可用时，一次创建得到六个不同 `sessionId`，角色/实际模型/等级符合表 1.1；刷新读取同一 IDs。
- 并发两次创建不合并为同一 session，也不产生角色重复的 ready 会议。
- 阶段 A 的同一补丁必须同步加入并运行上述 roster、模型缺失、ID 不重复、持久化恢复和并发创建验收测试。

### 阶段 B：桌面会议视图

产物：入口、创建状态、3×2 `GroupMeetingView`、六个独立流式窗、PI 输入，以及对应组件/交互测试。

- 点击后六格在同一中间栏可见；每格只显示绑定 session 的历史/流。
- 向 PI 发送测试消息只影响 PI；五个非 PI 格无输入且不收到该消息。
- 一格 SSE 重连不影响其余格；模型/启动错误在对应角色格可见。
- 按钮/PI 输入可键盘操作，网格有语义标签；窄屏显示可理解降级提示。
- 阶段 B 的同一补丁必须同步加入并运行六 pane 事件归属、PI-only 输入、窄屏提示和 accessibility 验收测试。

### 阶段 C：生命周期、回归与文档

产物：刷新恢复、失败路径、跨阶段集成回归、用户文档。

- 重开会议不再调用六次创建；切回普通会话不丢 `.jsonl` 历史，不泄漏 idle wrapper。
- 现有单会话创建、fork、模型范围、SSE 重连、sidebar running state、notebook renderer 回归通过。
- 阶段 C 只补跨阶段集成回归（包含历史恢复与现有会话能力），不替代阶段 A/B 已要求的同步验收测试。
- 跑既有 `npm test`、typecheck、lint、`git diff --check`；开发期间不运行 `next build`。

## 6. 最小首个功能补丁边界

首个代码补丁完成阶段 A/B 的最小可用闭环：按钮真实创建（或明确拒绝）会议、会议可持久化/恢复、桌面 3×2 格绑定六个独立 session，且 PI 可真实输入并仅发送至自身 session。它不含 PI 调度、成员自动回复、reviewer、新模型配置、共享任务上下文、删除/归档、移动端密集交互优化。

编码的唯一阻塞前置是：用户在 ModelsConfig 配置并认证可解析为 `deepseek-v4-pro` 的 provider/model。代码不得保存或伪造 API key；若真实 model ID 不同，更新此默认表和测试，不能代码内做别名回退。

## 7. 里程碑与用户决策

| 里程碑 | 交付 | 需要确认 |
|---|---|---|
| M1 | 六角色会议可靠创建、恢复、独立展示 | `deepseek-v4-pro` 的 provider/模型 ID/认证已可用 |
| M2 | PI 可向指定成员分派/查看回执 | PI→成员协议、成员工具/文件权限、自动执行时机 |
| M3 | 汇总、审阅与治理 | reviewer 是否加入及独立性、审批点、成本/并发预算、完成判定 |

在 M1 验收前，不启动 M2/M3 的 scheduler、background loop 或 Agent-to-Agent 协议。

## 8. 2026-08-17 M1 实施结果

M1 已按本计划落地为未提交补丁：

- 新增固定六角色合同、已认证模型唯一匹配和 thinking-level 严格预检查；不猜 Provider、不降级。
- 新增会议创建、列表和按 ID 读取 API；会议元数据按项目私有原子写入，状态从 `creating` 逐成员推进到 `ready` 或 `failed`。
- 空 Pi session 会立即落 JSONL，刷新或进程 registry 丢失后仍能按原 session ID 恢复；组会创建不会覆盖用户的默认模型和 thinking 偏好。
- WebUI 顶栏新增“组会”按钮；桌面中间栏显示 3×2 六个独立 pane，复用原 Session/SSE/MessageView；仅 PI 可输入，其余五个完全只读。
- 会议 URL 使用 `meeting` 与 `cwd` 显式恢复；退出会议保留原 session 历史；会议 pane 的文件链接保留各自 session 授权来源。
- PI→成员派发、自动 prompt、成员间通信和 reviewer 仍未实现。

当前真实环境的创建失败路径已通过浏览器验证，会在创建任何 session 前报告具体角色。当前首先报告 `gpt-5.6-sol` 同时来自 `new-provider` 与 `new-provider-1`；此外仍缺少 `deepseek-v4-pro`，现有 `gpt-5.6-terra` 也不支持要求的 `xhigh`。因此代码闭环已经具备，但必须先校准 ModelsConfig 才能产生 `ready` 的六窗会议。
