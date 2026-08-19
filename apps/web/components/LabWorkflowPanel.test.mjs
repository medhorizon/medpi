import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panelSource = await readFile(new URL("./LabWorkflowPanel.tsx", import.meta.url), "utf8");
const viewSource = await readFile(new URL("./GroupMeetingView.tsx", import.meta.url), "utf8");
const englishSource = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
const chineseSource = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");

test("adds a derived workflow summary without creating another meeting view", () => {
  assert.match(viewSource, /<LabWorkflowSummary/);
  assert.match(viewSource, /<LabWorkflowPane/);
  assert.match(viewSource, /workflow=\{workflow\}/);
  assert.match(viewSource, /onWorkflowAction=\{onWorkflowAction\}/);
  assert.doesNotMatch(viewSource, /GroupMeetingStore|WorkflowStore/);
});

test("keeps structured controls limited to PI clarification cards", () => {
  assert.match(panelSource, /member\.role === "pi"/);
  assert.match(panelSource, /action: "submit_clarification"/);
  assert.match(panelSource, /selectedOptionIds: selected/);
  assert.match(panelSource, /freeText: freeText\.trim\(\)/);
  assert.match(panelSource, /card\.selectionMode === "single" \? "radio" : "checkbox"/);
  assert.match(panelSource, /card\.submitLabel \?\? t\("meeting\.workflowSubmit"\)/);
  assert.match(panelSource, /member\.role === "phd-1"/);
  assert.match(panelSource, /member\.role === "master-1"/);
  assert.match(panelSource, /member\.role === "undergraduate"/);
  assert.doesNotMatch(panelSource, /delegate_undergrad|cancel_task|review_undergrad_records/);
});

test("shows role-specific phase and records-only thread information", () => {
  assert.match(panelSource, /data-workflow-doctor=/);
  assert.match(panelSource, /workPackage[.]mode/);
  assert.match(panelSource, /preMasterJudgment/);
  assert.match(panelSource, /masterRequestId/);
  assert.match(panelSource, /data-workflow-master=/);
  assert.match(panelSource, /data-workflow-undergraduate/);
  assert.match(panelSource, /workflowThreadCapacity/);
  assert.match(panelSource, /workflowRecordsOnly/);
});

test("localizes workflow status and clarification labels", () => {
  for (const source of [englishSource, chineseSource]) {
    assert.match(source, /"meeting\.workflowSummary"/);
    assert.match(source, /"meeting\.workflowSubmit"/);
    assert.match(source, /"meeting\.workflowRecordsOnly"/);
  }
});
