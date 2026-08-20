/**
 * Meeting checkpoint generation.
 *
 * Before a meeting member session is context-compacted, the lab extension dumps
 * a readable checkpoint so the meeting's structured state and recent discussion
 * survive the summarization step. This module is Pi-independent: it only builds
 * markdown from plain data (a LabWorkflow-shaped object plus a list of recent
 * message lines), so it can be unit-tested without a Pi session.
 */

export type CompactReason = "manual" | "threshold" | "overflow";

export interface RecentMessageLine {
  role: string;
  text: string;
  timestamp?: string;
}

export interface CheckpointInput {
  meetingId: string;
  sessionId: string;
  cwd: string;
  reason: CompactReason;
  createdAt: string;
  /** A LabWorkflow-shaped object (get_state result). Treated defensively. */
  workflow: unknown;
  recentLines: RecentMessageLine[];
}

const REASON_LABEL: Record<CompactReason, string> = {
  manual: "manual /compact",
  threshold: "上下文达到阈值（自动压缩）",
  overflow: "上下文溢出恢复（自动压缩）",
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (value !== null && typeof value === "object") return value as Record<string, unknown>;
  if (label) throw new Error(`Expected ${label} to be an object`);
  return {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function firstText(value: unknown, fallback = "-"): string {
  const t = text(value).trim();
  return t ? t : fallback;
}

function truncate(value: string, max = 500): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/**
 * Extract the textual content of an AgentMessage `content` field (string or
 * block array) into a single string. Tool calls are collapsed to one line.
 */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      parts.push(`[thinking] ${b.thinking}`);
    } else if (b.type === "toolCall") {
      const name = typeof b.name === "string" ? b.name : "?";
      parts.push(`[toolCall: ${name}]`);
    }
  }
  return parts.join("\n");
}

function hasTextContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (block === null || typeof block !== "object") return false;
    const b = block as Record<string, unknown>;
    return (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0)
      || (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim().length > 0);
  });
}

/**
 * Build a bounded digest of the most recent user/assistant messages from a
 * session entry list (SessionEntry[]). Tool results and custom entries are
 * skipped; assistant messages with only tool calls are skipped as well.
 */
export function digestRecentMessages(
  entries: ReadonlyArray<unknown>,
  maxCount = 12,
  maxCharsPerMessage = 400,
): RecentMessageLine[] {
  const lines: RecentMessageLine[] = [];
  for (let i = entries.length - 1; i >= 0 && lines.length < maxCount; i--) {
    const entry = record(entries[i], "entry");
    if (entry.type !== "message") continue;
    const message = record(entry.message, "entry.message");
    const role = text(message.role);
    if (role !== "user" && role !== "assistant") continue;
    if (role === "assistant" && !hasTextContent(message.content)) continue;
    const body = textOfContent(message.content).trim();
    if (!body) continue;
    const timestamp = typeof message.timestamp === "string" || typeof message.timestamp === "number"
      ? String(message.timestamp)
      : undefined;
    lines.unshift({ role, text: truncate(body, maxCharsPerMessage), timestamp });
  }
  return lines;
}

function renderBrief(brief: unknown): string {
  if (brief === undefined || brief === null) return "-";
  if (typeof brief === "string") return truncate(brief.trim(), 2000) || "-";
  const obj = record(brief, "brief");
  const title = firstText(obj.title);
  const objective = firstText(obj.objective);
  const scope = firstText(obj.scope);
  const constraints = stringList(obj.constraints);
  const lines = [
    `- 标题: ${title}`,
    `- 目标: ${truncate(objective, 600)}`,
    `- 范围: ${truncate(scope, 600)}`,
  ];
  if (constraints.length) lines.push(`- 约束: ${constraints.join("；")}`);
  return lines.join("\n");
}

function renderWorkPackages(workflow: Record<string, unknown>): string {
  const items = Array.isArray(workflow.workPackages) ? workflow.workPackages : [];
  if (!items.length) return "-（无）";
  return items.map((wp) => {
    const obj = record(wp, "workPackage");
    const id = firstText(obj.workPackageId);
    const doctor = firstText(obj.doctorRole);
    const mode = firstText(obj.mode);
    const status = firstText(obj.status);
    const taskIds = stringList(obj.undergradTaskIds);
    const preMaster = obj.preMasterJudgment !== undefined
      ? `, preMaster=${firstText(record(obj.preMasterJudgment, "preMasterJudgment").judgment, "已提交").slice(0, 60)}`
      : "";
    return `- ${id} [${status}] doctor=${doctor} mode=${mode} tasks=[${taskIds.join(",")}]${preMaster}`;
  }).join("\n");
}

function renderTasks(workflow: Record<string, unknown>): string {
  const items = Array.isArray(workflow.undergradTasks) ? workflow.undergradTasks : [];
  if (!items.length) return "-（无）";
  return items.map((task) => {
    const obj = record(task, "task");
    const id = firstText(obj.taskId);
    const status = firstText(obj.status);
    const purpose = firstText(obj.purpose);
    const workType = firstText(obj.workType);
    const threads = `${stringList(obj.threadIds).length}/${typeof obj.maxThreads === "number" ? obj.maxThreads : "?"}`;
    const title = firstText(obj.title);
    return `- ${id} [${status}] ${purpose}/${workType} threads=${threads}\n  - ${truncate(title, 240)}`;
  }).join("\n");
}

function renderThreads(workflow: Record<string, unknown>): string {
  const items = Array.isArray(workflow.undergradThreads) ? workflow.undergradThreads : [];
  if (!items.length) return "-（无）";
  return items.map((thread) => {
    const obj = record(thread, "thread");
    const id = firstText(obj.threadId);
    const status = firstText(obj.status);
    const task = firstText(obj.parentTaskId);
    const attempt = typeof obj.attempt === "number" ? String(obj.attempt) : "?";
    const title = firstText(obj.title);
    const session = typeof obj.sessionId === "string" && obj.sessionId ? ` session=${obj.sessionId.slice(0, 8)}` : "";
    return `- ${id} [${status}] task=${task} attempt=${attempt}${session}\n  - ${truncate(title, 240)}`;
  }).join("\n");
}

function renderReservations(workflow: Record<string, unknown>): string {
  const items = Array.isArray(workflow.masterReservations) ? workflow.masterReservations : [];
  if (!items.length) return "-（无）";
  return items.map((res) => {
    const obj = record(res, "reservation");
    const id = firstText(obj.requestId);
    const status = firstText(obj.status);
    const master = firstText(obj.masterRole);
    const wp = firstText(obj.workPackageId);
    return `- ${id} [${status}] master=${master} workPackage=${wp}`;
  }).join("\n");
}

function renderReport(report: unknown): string {
  if (report === undefined || report === null) return "-（未生成）";
  const obj = record(report, "report");
  const title = firstText(obj.title);
  const summary = firstText(obj.executiveSummary);
  const lines = [
    `- 标题: ${title}`,
    `- 摘要: ${truncate(summary, 1000)}`,
  ];
  for (const [label, key] of [["结论", "conclusions"], ["假说", "hypotheses"], ["拟议方法", "proposedMethods"], ["未决问题", "openQuestions"]] as const) {
    const items = stringList(obj[key]);
    if (items.length) lines.push(`- ${label}: ${items.join("；")}`);
  }
  return lines.join("\n");
}

function renderNotices(workflow: Record<string, unknown>): string {
  const items = Array.isArray(workflow.notices) ? workflow.notices : [];
  if (!items.length) return "-（无）";
  return items.map((notice) => {
    const obj = record(notice, "notice");
    const id = firstText(obj.noticeId);
    const status = firstText(obj.status);
    const event = firstText(obj.event);
    const to = firstText(obj.toRole);
    return `- ${id} [${status}] ${event} → ${to}`;
  }).join("\n");
}

function renderClarifications(workflow: Record<string, unknown>): string {
  const cards = Array.isArray(workflow.clarificationCards) ? workflow.clarificationCards : [];
  const responses = Array.isArray(workflow.clarificationResponses) ? workflow.clarificationResponses : [];
  if (!cards.length && !responses.length) return "-（无）";
  const lines: string[] = [];
  for (const card of cards) {
    const obj = record(card, "card");
    lines.push(`- ${firstText(obj.questionId)}: ${truncate(firstText(obj.question), 300)}`);
  }
  for (const res of responses) {
    const obj = record(res, "response");
    lines.push(`- → ${firstText(obj.questionId)}: ${stringList(obj.selectedOptionIds).join(",") || firstText(obj.freeText)}`);
  }
  return lines.join("\n");
}

/**
 * Render the full checkpoint markdown document.
 */
export function buildMeetingCheckpoint(input: CheckpointInput): string {
  const workflow = record(input.workflow, "workflow");
  const sections = [
    "# 组会上下文 Checkpoint（压缩前落盘）",
    "",
    `- meetingId: ${input.meetingId}`,
    `- sessionId: ${input.sessionId}`,
    `- cwd: ${input.cwd}`,
    `- 触发原因: ${REASON_LABEL[input.reason]}`,
    `- 落盘时间: ${input.createdAt}`,
    `- 工作流状态: ${firstText(workflow.status)}`,
    `- 工作流更新时间: ${firstText(workflow.updatedAt)}`,
    "",
    "## 简报 (Brief)",
    renderBrief(workflow.brief),
    "",
    "## 工作包 (WorkPackages)",
    renderWorkPackages(workflow),
    "",
    "## 本科生任务 (UndergradTasks)",
    renderTasks(workflow),
    "",
    "## 线程 (UndergradThreads)",
    renderThreads(workflow),
    "",
    "## Master 预约 (MasterReservations)",
    renderReservations(workflow),
    "",
    "## 澄清 (Clarifications)",
    renderClarifications(workflow),
    "",
    "## 最终报告 (FinalReport)",
    renderReport(workflow.finalReport),
    "",
    "## 通知 (Notices)",
    renderNotices(workflow),
    "",
    "## 近期会话摘要",
    ...(input.recentLines.length
      ? input.recentLines.map((line) => {
          const ts = line.timestamp ? ` (${line.timestamp})` : "";
          return `- **[${line.role}]${ts}** ${line.text.replace(/\n/g, " ")}`;
        })
      : ["-（无）"]),
  ];
  return `${sections.join("\n")}\n`;
}
