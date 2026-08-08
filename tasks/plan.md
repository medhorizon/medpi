# Implementation Plan: 极宽松沙箱（P3 最小闭环）

## Overview

按 `docs/plan/00-sandbox.md` 实现可插拔沙箱：默认 `none`、Linux 可选 `bwrap`；含 permission owner（默认自动放行）、audit（provenance `run` + 日志）、abort（杀进程组 + 清理）、rollback（git 存档点 + 隔离目录）。资源配额无限；不做 redaction / R / notebook UI / SEA 打包（打包另任务）。

## Architecture Decisions

- 领域代码在 `packages/science/src/sandbox/`（Pi-independent）；Pi tool 仅在 `extensions/`。
- Provider 接口：`none | bwrap`（podman 接口预留，v1 不实现）。
- 编排：`createCheckpoint` → `spawn` → 流式日志 → 结束写 provenance → 失败/中止可 `rollback`。
- 隔离目录：`<project>/.medpi/runs/<runId>/`（workdir、stdout.log、stderr.log）。
- 测试：真实 FS/进程，不 mock。

## Task List

### Phase 1: Foundation
- [x] Task 1: sandbox 类型 + none provider（spawn/abort/cleanup）
- [x] Task 2: audit（provenance run + 日志文件）

### Checkpoint: Foundation
- [x] `npm run test:science` 通过；可 spawn python、abort 无残留

### Phase 2: Safety loop
- [x] Task 3: rollback（git 存档点 + 清隔离目录）
- [x] Task 4: permission owner + `science_run` tool glue

### Checkpoint: Core loop
- [x] 验收 1/3/4/5 对 none provider 成立

### Phase 3: Optional hard boundary
- [x] Task 5: Linux bwrap provider（只读外盘、可写项目/环境）
- [x] Task 6: 更新迁移清单与文档

### Checkpoint: Complete
- [x] `00-sandbox.md` §7 验收标准覆盖；bwrap 在本机可用时测通过，否则 skip（本机 AppArmor 拒 userns → skipped）

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| AppArmor 拒 bwrap | Med | 默认 none；bwrap 测试检测失败则 skip |
| abort 杀不干净 | High | `detached` + 负 pid kill 进程组；`--die-with-parent`（bwrap） |
| 非 git 项目无法 rollback | Med | 无 git 时拒绝启用 rollback 或明确报错 |

## Open Questions

- 无（决策已在 `00-sandbox.md` §9 冻结）
