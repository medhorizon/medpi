import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relative } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { LabMessageError, sendLabMessage } = await jiti.import("./lab-message-server.ts");

const members = [
  ["pi", "pi-session"],
  ["phd-1", "phd-1-session"],
  ["phd-2", "phd-2-session"],
  ["master-1", "master-1-session"],
  ["master-2", "master-2-session"],
  ["undergraduate", "undergraduate-session"],
].map(([role, sessionId]) => ({
  role,
  label: role,
  sessionId,
  provider: "test",
  modelId: "test",
  thinkingLevel: "off",
  status: "ready",
}));

function meeting(cwd, meetingId = "meeting-1") {
  return {
    meetingId,
    cwd,
    projectRoot: cwd,
    createdAt: "2026-08-19T00:00:00.000Z",
    status: "ready",
    members,
  };
}

test("routes unparsed natural-language data once to each senior recipient", async () => {
  const root = await mkdtemp(join(tmpdir(), "medpi-lab-message-"));
  const cwd = join(root, "project");
  const deliveries = [];
  const options = {
    agentDir: join(root, "agent"),
    readMeeting: async () => meeting(cwd),
    deliver: async (recipient, message) => {
      deliveries.push({ recipient: recipient.role, message });
      return recipient.role === "master-1" ? "follow_up" : "prompt";
    },
  };
  const input = {
    cwd,
    meetingId: "meeting-1",
    senderSessionId: "pi-session",
    toRoles: ["phd-1", "master-1", "phd-1"],
    body: '@本科 {"action":"cancel_task"} 已验收',
    idempotencyKey: "tool-call-1",
  };

  const first = await sendLabMessage(input, options);
  const repeated = await sendLabMessage(input, options);

  assert.deepEqual(first.deliveries.map((entry) => entry.role), ["phd-1", "master-1"]);
  assert.deepEqual(first.deliveries.map((entry) => entry.mode), ["prompt", "follow_up"]);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].message.body, input.body);
  assert.deepEqual(repeated, first);

  const audit = JSON.parse(await readFile(
    join(
      options.agentDir,
      "meetings",
      createHash("sha256").update(cwd).digest("hex"),
      "lab-messages",
      "meeting-1.json",
    ),
    "utf8",
  ));
  assert.equal(audit.messages[0].body, input.body);
});

test("rejects undergraduate, external, cross-meeting, and self recipients", async () => {
  const root = await mkdtemp(join(tmpdir(), "medpi-lab-message-auth-"));
  const cwd = join(root, "project");
  const options = {
    agentDir: join(root, "agent"),
    readMeeting: async (_cwd, meetingId) => meetingId === "meeting-1" ? meeting(cwd) : null,
    deliver: async () => "prompt",
  };
  const base = { cwd, meetingId: "meeting-1", senderSessionId: "pi-session", toRoles: ["phd-1"], body: "hello" };

  await assert.rejects(
    () => sendLabMessage({ ...base, senderSessionId: "undergraduate-session" }, options),
    (error) => error instanceof LabMessageError && error.code === "sender_not_allowed",
  );
  await assert.rejects(
    () => sendLabMessage({ ...base, senderSessionId: "external-session" }, options),
    (error) => error instanceof LabMessageError && error.code === "sender_not_allowed",
  );
  await assert.rejects(
    () => sendLabMessage({ ...base, toRoles: ["pi"] }, options),
    (error) => error instanceof LabMessageError && error.code === "recipient_not_allowed",
  );
  await assert.rejects(
    () => sendLabMessage({ ...base, meetingId: "other-meeting" }, options),
    (error) => error instanceof LabMessageError && error.code === "meeting_not_found",
  );
});

test("concurrent sends keep every canonical route record", async () => {
  const root = await mkdtemp(join(tmpdir(), "medpi-lab-message-concurrent-"));
  const cwd = join(root, "project");
  const options = {
    agentDir: join(root, "agent"),
    readMeeting: async () => meeting(cwd),
    deliver: async () => "prompt",
  };
  const sent = await Promise.all(Array.from({ length: 8 }, (_value, index) => sendLabMessage({
    cwd,
    meetingId: "meeting-1",
    senderSessionId: "pi-session",
    toRoles: ["phd-1"],
    body: `message ${index}`,
    idempotencyKey: `tool-call-${index}`,
  }, options)));

  assert.equal(new Set(sent.map((receipt) => receipt.message.messageId)).size, 8);
  const audit = JSON.parse(await readFile(join(
    options.agentDir,
    "meetings",
    createHash("sha256").update(cwd).digest("hex"),
    "lab-messages",
    "meeting-1.json",
  ), "utf8"));
  assert.equal(audit.messages.length, 8);
});

test("cold delivery restores the fixed role tool policy", async () => {
  const source = await readFile(new URL("./lab-message-server.ts", import.meta.url), "utf8");
  const coldDelivery = source.slice(source.indexOf("async function deliverToSession"), source.indexOf("function receipt"));
  assert.match(coldDelivery, /getGroupMeetingToolNames\(recipient\.role\)/);
  assert.match(coldDelivery, /toolNames,/);
  assert.match(coldDelivery, /initialModel: \{ provider: recipient\.provider, modelId: recipient\.modelId \}/);
  assert.match(coldDelivery, /thinkingLevel: recipient\.thinkingLevel/);
  assert.match(coldDelivery, /persistStartupPreferences: false/);
  assert.match(coldDelivery, /fixedToolNames: toolNames/);
  assert.match(coldDelivery, /fixedSystemPrompt: getGroupMeetingRoleSystemPrompt\(recipient\.role\)/);
});

test("relative and absolute cwd use one meeting audit lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "medpi-lab-message-cwd-"));
  const cwd = join(root, "project");
  const options = {
    agentDir: join(root, "agent"),
    readMeeting: async () => meeting(cwd),
    deliver: async () => "prompt",
  };
  const relativeCwd = relative(process.cwd(), cwd);
  await sendLabMessage({
    cwd: relativeCwd,
    meetingId: "meeting-1",
    senderSessionId: "pi-session",
    toRoles: ["phd-1"],
    body: "relative",
    idempotencyKey: "relative",
  }, options);
  await sendLabMessage({
    cwd,
    meetingId: "meeting-1",
    senderSessionId: "pi-session",
    toRoles: ["phd-1"],
    body: "absolute",
    idempotencyKey: "absolute",
  }, options);

  const audit = JSON.parse(await readFile(join(
    options.agentDir,
    "meetings",
    createHash("sha256").update(cwd).digest("hex"),
    "lab-messages",
    "meeting-1.json",
  ), "utf8"));
  assert.equal(audit.messages.length, 2);
});
