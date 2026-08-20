import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildMeetingCheckpoint, digestRecentMessages, textOfContent } from "../src/checkpoint.ts";

const SAMPLE_WORKFLOW = {
  meetingId: "ad7c0c22-4aed-4b83-a8e1-a70433aaab64",
  cwd: "/home/wei/temp",
  status: "running",
  updatedAt: "2026-08-20T09:30:00.000Z",
  brief: { title: "EB 研究", objective: "锁定自体移植物文献", scope: "pubmed", constraints: ["LAMB3/JEB"] },
  workPackages: [
    { workPackageId: "wp-1", doctorRole: "phd-1", mode: "robust", status: "retrieval_accepted", undergradTaskIds: ["t1"] },
  ],
  undergradTasks: [
    { taskId: "t1", status: "running", purpose: "scientific_retrieval", workType: "literature_search", threadIds: ["th1"], maxThreads: 3, title: "LAMB3 自体移植物" },
  ],
  undergradThreads: [
    { threadId: "th1", parentTaskId: "t1", attempt: 1, status: "running", title: "thread A", sessionId: "01abc123" },
  ],
  masterReservations: [
    { requestId: "r1", workPackageId: "wp-1", masterRole: "master-1", status: "submitted" },
  ],
  finalReport: { title: "报告", executiveSummary: "sum", conclusions: ["c1"], openQuestions: ["q1"] },
  notices: [{ noticeId: "n1", status: "delivered", event: "undergrad_thread_submitted", toRole: "phd-1" }],
};

test("buildMeetingCheckpoint renders workflow state sections", () => {
  const md = buildMeetingCheckpoint({
    meetingId: SAMPLE_WORKFLOW.meetingId,
    sessionId: "01a01d7a",
    cwd: "/home/wei/temp",
    reason: "threshold",
    createdAt: "2026-08-20T09:31:00.000Z",
    workflow: SAMPLE_WORKFLOW,
    recentLines: [{ role: "user", text: "你好" }],
  });
  assert.match(md, /# 组会上下文 Checkpoint/);
  assert.match(md, /meetingId: ad7c0c22/);
  assert.match(md, /触发原因: 上下文达到阈值/);
  assert.match(md, /工作流状态: running/);
  assert.match(md, /## 简报 \(Brief\)/);
  assert.match(md, /## 工作包 \(WorkPackages\)/);
  assert.match(md, /wp-1 \[retrieval_accepted\] doctor=phd-1 mode=robust/);
  assert.match(md, /## 本科生任务 \(UndergradTasks\)/);
  assert.match(md, /t1 \[running\] scientific_retrieval\/literature_search threads=1\/3/);
  assert.match(md, /## 线程 \(UndergradThreads\)/);
  assert.match(md, /th1 \[running\] task=t1 attempt=1 session=01abc123/);
  assert.match(md, /## Master 预约 \(MasterReservations\)/);
  assert.match(md, /r1 \[submitted\] master=master-1 workPackage=wp-1/);
  assert.match(md, /## 最终报告 \(FinalReport\)/);
  assert.match(md, /结论: c1/);
  assert.match(md, /## 近期会话摘要/);
  assert.match(md, /\*\*\[user\]\*\* 你好/);
});

test("buildMeetingCheckpoint handles empty workflow defensively", () => {
  const md = buildMeetingCheckpoint({
    meetingId: "m1",
    sessionId: "s1",
    cwd: "/tmp",
    reason: "manual",
    createdAt: "2026-08-20T00:00:00.000Z",
    workflow: { meetingId: "m1" },
    recentLines: [],
  });
  assert.match(md, /触发原因: manual \/compact/);
  assert.match(md, /（无）/);
  assert.match(md, /-（无）/);
});

test("digestRecentMessages keeps text-bearing user/assistant messages and truncates", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "first question", timestamp: 1 } },
    { type: "message", message: { role: "toolResult", content: "huge tool output", timestamp: 2 } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: 3 } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "lab_orchestrate", arguments: "{}" }], timestamp: 4 } },
    { type: "message", message: { role: "user", content: "x".repeat(900), timestamp: 5 } },
    { type: "compaction", summary: "old", firstKeptEntryId: "a", tokensBefore: 1 },
  ];
  const lines = digestRecentMessages(entries, 10, 100);
  assert.equal(lines.length, 3); // user, assistant-text, user(truncated) — toolCall-only assistant skipped
  assert.equal(lines[0].role, "user");
  assert.equal(lines[0].text, "first question");
  assert.equal(lines[1].role, "assistant");
  assert.equal(lines[1].text, "first answer");
  assert.equal(lines[2].role, "user");
  assert.equal(lines[2].text.length, 101); // 100 + ellipsis
  assert.match(lines[2].text, /…$/);
});

test("textOfContent handles strings and block arrays", () => {
  assert.equal(textOfContent("plain"), "plain");
  assert.equal(textOfContent([{ type: "text", text: "a" }, { type: "thinking", thinking: "t" }, { type: "toolCall", name: "x" }]), "a\n[thinking] t\n[toolCall: x]");
  assert.equal(textOfContent(null), "");
});

test("lab extension registers session_before_compact checkpoint", async () => {
  const source = await readFile(new URL("../extensions/index.ts", import.meta.url), "utf8");
  assert.match(source, /pi\.on\("session_before_compact"/);
  assert.match(source, /writeMeetingCheckpoint/);
  assert.match(source, /digestRecentMessages/);
  assert.match(source, /checkpoints/);
});
