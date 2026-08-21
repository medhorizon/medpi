# 组会补丁：bug 记录 / debug / 可移植性审计与调整

> 目的：记录组会补丁（M1/M2/M3 + 后续 debug）在生产中冒出的问题、各自根因与修复方式，
> 并从依赖边界上回答"这补丁能否当插件套进 deepseek harness / codex"、以及要做哪些修改。
> 仓库本体（pi-web 基线核心、`packages/science`）一律不改；所有改动只落在组会补丁文件内。

---

## 1. 一组会补丁的范围

组会补丁 = M1/M2/M3 补丁 + 后续 debug，落在以下文件（可移植性审计的边界）：

| 文件 | 作用 |
|---|---|
| `apps/web/lib/rpc-manager.ts` | 会话注册表、生命周期、空闲淘汰、渐进内存回收 |
| `apps/web/lib/group-meeting-server.ts` | 会议持久化、roster、创建/删除/设置、会话回收 |
| `apps/web/lib/lab-message-server.ts` | `lab_send_message` 投递、审计、`LabRuntime` 的 web 端实现 |
| `apps/web/lib/lab-workflow.ts` | M2 工作流状态机、`lab_orchestrate` |
| `apps/web/lib/group-meeting.ts` | 纯类型/roster/角色/工具矩阵 |
| `apps/web/lib/meeting-model-role.ts` | 纯函数：`developer`→`system` role 规范化 |
| `apps/web/lib/project-trust.ts` | 项目信任门 |
| `apps/web/app/api/meetings/*`、`GroupMeetingView` | 会议 UI/路由 |
| `packages/lab/src/*`、`packages/lab/extensions/index.ts` | 域逻辑 + 工具桥 |

---

## 2. Bug 记录：问题 → 根因 → debug → 修复

### 2.1 DeepSeek `developer` role 400
- **现象**：成员 session 发 `messages[0].role: unknown variant 'developer'`，请求被上游 400。
- **根因**（读 `@earendil-works/pi-ai/api/openai-completions` 的转换逻辑）：glob 上 `useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`。
  `supportsDeveloperRole` 按 Base URL **域名启发式自动检测**：未知/自定义域名（如 `newapi.medhorizon.icu`）默认 true，
  reasoning 模型 → 发 `developer`，而 DeepSeek 只收 `system/user/assistant/tool`。
  `model.compat.supportsDeveloperRole ?? detected = undefined ?? true = true`。
- **debug**：在 `models.json` 手动加 `supportsDeveloperRole:false` 后单测 `convertMessages` 复现/验证。
- **修复**：新增 `meeting-model-role.ts`，会议创建/设置成员时对会发射 `developer` 的 roster 模型**自动幂等**写入
  `compat.supportsDeveloperRole:false`，纯 JSON 且保留其它键、原子写（temp+rename、0600）；写不进（含 JS 注释）则返回
  可修复诊断，不静默改。创建响应 `modelRoleAutomations` + 服务端日志上报。
  **结论：换任意 Base URL 都不再复发**（规则恒定：组会成员一律发 `system`）。
- **提交**：`91d480f`。

### 2.2 nginx / 网关 413 Request Entity Too Large
- **现象**：成员压缩（compact）阶段的大请求体被 `413` 拦下（`nginx/1.24.0` 默认 `client_max_body_size 1m`），
  成员 `stopReason:"error"`，自动压缩的摘要请求也出不去 → 该成员**永远无法压缩**（死循环）。
  证据：phd-2 5 次、undergraduate 12 次、pi 1 次。
- **根因**：基础设施层 body 上限，与网关/代理强相关，**不是代码能改的部署栈问题**。
- **修复**：`/etc/nginx/sites-enabled/newapi.medhorizon.icu` 加 `client_max_body_size 64m;` 并 reload；网关侧 `MAX_BODY_BYTES=67108864` 对齐。
- **结论**：413 属部署要求，代码侧无法根治；已在设计文档固化为"换 Base URL 检查清单"。

### 2.3 MedPi 30142 打不开 —— 根因是 JS 堆 OOM
- **现象**：`http://...:30142` 连不上，`ss` 显示 30142 无监听；`next-server` 挂了。
- **根因**（`/tmp/medpi-30142.log` + `journalctl`）：`FATAL ERROR: Ineffective mark-compacts near heap limit ... out of memory`，
  V8 堆爆在 ~7.9GB、进程峰值 11GB、2.6 小时后崩溃；服务 `medpi-30142.service` 是 **disabled**，崩溃后不自愈。
  负载解剖：6 个成员 `AgentSession` 常驻 `globalThis.__piSessions`（每个会话内存态 ≈ jsonl 数倍），
  历代会议每次重建都新起 6 个会话**不回收旧的**，加上 next dev 模式基线内存高。
- **修复**（systemd + 进程内）：
  - 加固 `~/.config/systemd/user/medpi-30142.service`：`NODE_OPTIONS=--max-old-space-size=10240`、
    `MemoryHigh=10G`/`MemoryMax=12G`、`TimeoutStopSec=60`/`KillMode=mixed`、`Restart=on-failure`，并 `enable`。
  - 新增 `medpi-30142-maintain.{service,timer}`：每日 04:30 干净重启回收堆（会话落盘、可懒重建，安全）。
  - 提交 `4d479b0`、`040cb58`。

### 2.4 内存堆积：删会/建会不回收
- **bug**：删除会议只 `unlink` 元数据，6 个成员会话仍赖在注册表直到 10 分钟通用空闲；（反复重建会议）历代会话叠加。
- **修复**（`group-meeting-server.ts`）：`deleteGroupMeeting` 先 `shutdownMeetingMemberSessions(meeting, interruptRunning=true)`
  再删文件；`createGroupMeetingFromRoster` 创建前先回收**同 cwd 旧会议的空闲**成员（运行中的不打断）。提交 `4d479b0`。

### 2.5 会议过程中逐步清理（渐进内存回收）
- **痛点**：长轮次里"先干完的成员"空等别人，仍占几百 MB 堆，直到 10 分钟空闲兜底。
- **护栏先行**：`AgentSessionWrapper.hasPendingActivity()` = `isRunning() || pendingMessageCount>0 ||
  getSteeringMessages().length>0 || getFollowUpMessages().length>0`，防御性 try/catch（探测失败视为"不可回收"）。
- **机制**：`rpc-manager.reclaimIdleRpcSessions(targets)`，只在 **非运行 && 无排队指令** 时 `shutdown()`；
  在 `lab-message-server.sendLabMessage` 每轮投递完成后调用（用已读到的 meeting，不再读盘、无模块环）；
  **pi 协调者角色永不参与**；被回收成员在下次投递时从 `.jsonl` 懒重建。
- **提交**：`040cb58`。跑真实压制会验证 `cgroup peak` 是否被压住。

### 2.6 判定经验：OOM 日志是否遗留
- `/tmp/medpi-30142.log` 是跨重启 append 的，旧崩溃文本会残留。判断"当前是否还有"要用行号对比：`grep -n '✓ Ready' | tail -1` 与
  `grep -n 'FATAL ERROR' | tail -1`，若 `OOM 行 < 最后一个 Ready 行` 则该 OOM 是**旧的**、当前进程健康。

---

## 3. 可移植性审计（能否当插件套进 deepseek harness / codex）

### 3.1 结论
**不能直接当"插件"复用。** 理由两重：

1. **它不是插件**。pi 的插件是 Extension（注册工具/钩子）；而组会补丁是**宿主进程内嵌的 Web 服务层**——
   要在 TUI 主循环之外**编程式创建并同时驾驭 6 个并行 agent 会话**（prompt/follow_up/steer、读 context usage、
   set thinking、订阅事件、abort、`.jsonl` 懒重建），全部依赖 pi 私有的
   `AgentSessionWrapper.send()` RPC + 模型注册表 + `SessionManager` 文件格式 + extension runner。
2. **目标 harness 未必有等价会话 API**。codex CLI / deepseek harness 多为交互式 agent CLI；若它们不暴露
   "可并行驾驭、带 follow_up/steer/context-usage + 固定 system prompt" 的编程式会话接口，宿主层代码没有可适配的东西。

### 3.2 依赖边界（哪些纯、哪些绑死 pi）

| 文件 | pi 依赖 | 结论 |
|---|---|---|
| `packages/lab/src/runtime.ts` | **零** | ✅ 纯——`LabRuntime` 接口 + 工具输入类型 |
| `packages/lab/src/checkpoint.ts` | **零** | ✅ |
| `apps/web/lib/group-meeting.ts` | 零 | ✅（roster/角色/工具矩阵/类型） |
| `apps/web/lib/meeting-model-role.ts` | 仅 `type {Api,Model}`（类型） | ⚠️ 逻辑纯，去类型即可 |
| `apps/web/lib/rpc-manager.ts` | `pi-coding-agent`+`pi-tui`+`pi-agent-core` | ❌ 最重耦合：会话生命周期 |
| `group-meeting-server.ts` | `pi-coding-agent`+`pi-ai`+模型注册表 | ❌ |
| `lab-message-server.ts` | `pi-coding-agent`+`rpc-manager` | ❌（投递走 pi `session.send`） |
| `lab-workflow.ts` | `pi-coding-agent`+`rpc-manager` | ❌ |
| `packages/lab/extensions/index.ts` | `ExtensionAPI`/`ctx.tool` | ❌ 唯一的纯→pi 工具桥 |
| API 路由 + `GroupMeetingView` | pi web | ❌ |

**可复用内核（纯）**：`packages/lab` 的 workflow/checkpoint/runtime + `group-meeting.ts` + `meeting-model-role` 逻辑。

### 3.3 若要跨 harness 可用，改造路径

缺的是"**host 侧驱动成员会话**"这一层（现散在 rpc-manager + 三个组会文件、直接吃 pi 类型）。抽三个端口 + 各 harness 写 adapter：

1. **`MeetingMemberPort`（会话端口，最关键）**
   ```
   ensureSession(opts) -> MemberHandle {
     getSessionId / isAlive / isRunning / hasPendingActivity /
     sendPrompt(text) / sendFollowUp(text) / steer(...) /
     setThinkingLevel(level) / getContextUsage() / onEvent(cb) / dispose()
   }
   ```
   `deliverToSession`、`applyMemberSettings`、`reclaimIdleRpcSessions`、`shutdownMeetingMemberSessions`
   全部只依赖该端口、不摸 pi。
   - **pi adapter** = 现 `rpc-manager.ts`（把 `AgentSessionWrapper` 适配成端口）。
   - **codex/deepseek adapter** = 对它们实现同一端口。**前提：目标 harness 必须暴露该级别的编程式并行会话 API；否则做不了 in-process 6 并行驾驭**，只能走 3.4 降级。

2. **`ProviderResolver`**：把 `resolveVisibleModels` 抽象成 `{ listVisible(): PortModel[], resolveThinking(model, level) }`。pi 用现有实现，别处用自己的模型枚举。

3. **`MeetingFileStore`**：把 `.jsonl`/`SessionManager` 抽象成 `{ persist(handleId, entries), open(handleId) }`。
   **注意**：2.3–2.5 的整套内存策略（懒重建 / 删会建会释放 / 进程中逐步回收）能跨 harness 成立的前提，
   **就是 session 可持久化、可随时释放再从盘拉回**——没有 `MeetingFileStore` 抽象就等于白搭。

4. **工具桥**：`packages/lab/extensions/index.ts` 改成"声明一撮工具 + 处理器"，各 harness 用自己的方式把
   `lab_send_message`/`lab_orchestrate`/`lab_members_*` 挂进其工具集。

5. **host 承载变更**（见 3.4）。

### 3.4 降级方案：目标 harness 无会话 SDK
把 `MeetingMemberPort` 从"进程内句柄"换成"**传输通道**"：成员 = 子进程 stdio 对端 / HTTP peer，互讲 lab message 协议。
这是让 codex / deepseek 能以**原生形态**当组会成员的唯一方式；改动更大（编排、审计、幂等、重试都要走协议层）。

---

## 4. 实施建议顺序
1. 抽 `packages/meeting-core`（纯内核 + `MeetingMemberPort`/`ProviderResolver`/`MeetingFileStore` 端口 + M2 状态机），
   pi 现有实现降级为 adapter —— 先让代码结构"可移植"。
2. 调研 codex / deepseek harness 暴露的会话 API：有 → 进程内 adapter；无 → 走 3.4 跨进程协议。
3. 无论哪种，先跑一场真实压制会验证 2.5 的渐进回收（看 cgroup `peak`），再谈移植。

> 固定经验：**一切内存/role/413 修复都在 host 层（组会补丁），与模型网关无关**。换 newapi 或 sdk2api 只影响
> 网关自身 + body 上限那一层，影响不了 MedPi 进程内 6 会话的堆积——后者必须靠 host 层回收体系（删会/建会/渐进/空闲/每日重启/上限）。