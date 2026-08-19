import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { allowFileRoot } = await jiti.import("./file-access.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const {
  createGroupMeetingFromRoster,
  GroupMeetingError,
  getGroupMeetingSessionPolicy,
  listGroupMeetings,
  readGroupMeeting,
  resolveGroupMeetingRoster,
  resolveGroupMeetingSettings,
  resolveGroupMeetingSessionPolicy,
  updateGroupMeetingSettings,
} = await jiti.import("./group-meeting-server.ts");
const { GROUP_MEETING_TOOL_POLICY_VERSION, getGroupMeetingRoleSystemPrompt, getGroupMeetingToolNames } = await jiti.import("./group-meeting.ts");
const { getLabRuntime } = await jiti.import("@medpi/lab/runtime");

test("importing the group meeting server cold-binds the lab runtime without a module cycle", () => {
  const runtime = getLabRuntime();
  assert.equal(typeof runtime.sendMessage, "function");
  assert.equal(typeof runtime.orchestrate, "function");
  assert.equal(typeof runtime.authorizeScienceDatabase, "function");
});

function model(id, provider, { max = true, xhigh = true } = {}) {
  return {
    id,
    provider,
    name: id,
    api: "openai-responses",
    reasoning: true,
    thinkingLevelMap: {
      xhigh: xhigh ? "xhigh" : null,
      max: max ? "max" : null,
    },
    contextWindow: 128000,
    maxTokens: 32000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function availableModels() {
  return [
    model("gpt-5.6-sol", "openai-codex"),
    model("deepseek-v4-pro", "deepseek"),
    model("gpt-5.6-terra", "openai-codex"),
    model("deepseek-v4-flash", "deepseek"),
    model("gpt-5.6-luna", "openai-codex"),
  ];
}

test("resolves the fixed six-role roster without guessing providers", () => {
  const roster = resolveGroupMeetingRoster(availableModels());
  assert.deepEqual(roster.map(({ role, provider, modelId, thinkingLevel }) => ({ role, provider, modelId, thinkingLevel })), [
    { role: "pi", provider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: "max" },
    { role: "phd-1", provider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: "high" },
    { role: "phd-2", provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "max" },
    { role: "master-1", provider: "openai-codex", modelId: "gpt-5.6-terra", thinkingLevel: "xhigh" },
    { role: "master-2", provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "max" },
    { role: "undergraduate", provider: "openai-codex", modelId: "gpt-5.6-luna", thinkingLevel: "max" },
  ]);
});

test("uses the fixed M2 tool boundary for every meeting role", () => {
  for (const role of ["pi", "phd-1", "phd-2", "master-1", "master-2"]) {
    const toolNames = getGroupMeetingToolNames(role);
    assert.ok(toolNames.includes("lab_send_message"));
    assert.ok(toolNames.includes("lab_orchestrate"));
    assert.ok(!toolNames.includes("bash"));
  }
  for (const role of ["pi", "phd-1", "phd-2", "master-1", "master-2", "undergraduate"]) {
    assert.ok(!getGroupMeetingToolNames(role).includes("science_stage"));
    assert.ok(!getGroupMeetingToolNames(role).includes("provenance_review"));
  }
  const undergradTools = getGroupMeetingToolNames("undergraduate");
  assert.ok(undergradTools.includes("lab_orchestrate"));
  assert.ok(!undergradTools.includes("lab_send_message"));
  assert.ok(!undergradTools.includes("science_inspect"));
  assert.ok(!undergradTools.includes("science_run"));
  assert.ok(!undergradTools.includes("science_kernel"));
});

test("reports the role for missing, ambiguous, and unsupported models", () => {
  assert.throws(
    () => resolveGroupMeetingRoster(availableModels().filter((entry) => entry.id !== "deepseek-v4-pro")),
    (error) => error instanceof GroupMeetingError && error.code === "model_unavailable"
      && error.role === "phd-2" && /不可见或未认证/.test(error.message),
  );
  assert.throws(
    () => resolveGroupMeetingRoster([...availableModels(), model("gpt-5.6-sol", "other-provider")]),
    (error) => error instanceof GroupMeetingError && error.code === "model_ambiguous"
      && error.role === "pi" && /多个 provider/.test(error.message)
      && /openai-codex/.test(error.message) && /other-provider/.test(error.message),
  );
  assert.throws(
    () => resolveGroupMeetingRoster(availableModels().map((entry) => entry.id === "gpt-5.6-terra"
      ? model(entry.id, entry.provider, { xhigh: false })
      : entry)),
    (error) => error instanceof GroupMeetingError && error.code === "thinking_unsupported"
      && error.role === "master-1" && /不支持 thinking level xhigh/.test(error.message),
  );
});

test("validates explicit model and thinking settings without provider guessing", () => {
  const settings = resolveGroupMeetingRoster(availableModels()).map(({ role, provider, modelId, thinkingLevel }) => ({
    role,
    provider,
    modelId,
    thinkingLevel,
  }));
  assert.deepEqual(resolveGroupMeetingSettings(availableModels(), settings), settings);
  assert.throws(
    () => resolveGroupMeetingSettings(availableModels(), settings.map((entry, index) => (
      index === 0 ? { ...entry, provider: "other-provider" } : entry
    ))),
    (error) => error instanceof GroupMeetingError && error.code === "model_unavailable" && error.role === "pi",
  );
  assert.throws(
    () => resolveGroupMeetingSettings(availableModels().map((entry) => entry.id === "gpt-5.6-sol"
      ? model(entry.id, entry.provider, { max: false })
      : entry), settings),
    (error) => error instanceof GroupMeetingError && error.code === "thinking_unsupported" && error.role === "pi",
  );
});

test("creates six distinct sessions, persists them atomically, and restores the same ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "medpi-meeting-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
  allowFileRoot(cwd);
  let sequence = 0;
  const seenOptions = [];
  const seenCommands = [];
  const persistedSnapshots = [];
  const fakeCreate = async (_cwd, command, options) => {
    const [projectDirectory] = await readdir(join(agentDir, "meetings"));
    const [meetingFile] = await readdir(join(agentDir, "meetings", projectDirectory));
    persistedSnapshots.push(JSON.parse(await readFile(join(agentDir, "meetings", projectDirectory, meetingFile), "utf8")));
    seenOptions.push(options);
    seenCommands.push(command);
    sequence += 1;
    return {
      sessionId: `session-${sequence}`,
      data: null,
      model: { provider: command.provider, modelId: command.modelId },
      thinkingLevel: command.thinkingLevel,
    };
  };
  const roster = resolveGroupMeetingRoster(availableModels());
  const meeting = await createGroupMeetingFromRoster(cwd, roster, {
    agentDir,
    projectRoot: "/project/root",
    createSession: fakeCreate,
  });

  assert.equal(meeting.status, "ready");
  assert.equal(meeting.projectRoot, "/project/root");
  assert.equal(meeting.toolPolicyVersion, GROUP_MEETING_TOOL_POLICY_VERSION);
  assert.equal(new Set(meeting.members.map((member) => member.sessionId)).size, 6);
  assert.deepEqual(
    seenOptions,
    roster.map((member) => ({
      persistStartupPreferences: false,
      persistSession: true,
      fixedToolNames: getGroupMeetingToolNames(member.role),
      fixedSystemPrompt: getGroupMeetingRoleSystemPrompt(member.role),
    })),
  );
  assert.deepEqual(seenCommands.map((command) => command.toolNames), roster.map((member) => getGroupMeetingToolNames(member.role)));
  assert.equal(persistedSnapshots[0].status, "creating");
  assert.deepEqual(persistedSnapshots[0].members.map((member) => member.status), Array(6).fill("creating"));
  for (let index = 1; index < persistedSnapshots.length; index += 1) {
    assert.deepEqual(
      persistedSnapshots[index].members.map((member) => member.status),
      [...Array(index).fill("ready"), ...Array(6 - index).fill("creating")],
    );
  }
  const restored = await readGroupMeeting(cwd, meeting.meetingId, agentDir);
  assert.deepEqual(restored?.members.map((member) => member.sessionId), meeting.members.map((member) => member.sessionId));
  const originalPolicy = getGroupMeetingSessionPolicy(meeting, meeting.members[5].sessionId);
  const restoredPolicy = await resolveGroupMeetingSessionPolicy(meeting.members[5].sessionId, agentDir);
  assert.deepEqual(restoredPolicy, originalPolicy);
  assert.deepEqual(restoredPolicy?.toolNames, getGroupMeetingToolNames("undergraduate"));
  assert.equal(restoredPolicy?.systemPrompt, getGroupMeetingRoleSystemPrompt("undergraduate"));
  const [projectDirectory] = await readdir(join(agentDir, "meetings"));
  await writeFile(join(agentDir, "meetings", projectDirectory, `${meeting.meetingId}.workflow.json`), "{}");
  assert.deepEqual((await listGroupMeetings(cwd, agentDir)).map((entry) => entry.meetingId), [meeting.meetingId]);
  assert.equal(sequence, 6, "GET-style reads must not create replacement sessions");
  const projectDirs = await readdir(join(agentDir, "meetings"));
  const files = await readdir(join(agentDir, "meetings", projectDirs[0]));
  assert.deepEqual(files.sort(), [`${meeting.meetingId}.json`, `${meeting.meetingId}.workflow.json`].sort());
});

test("applies only changed settings and persists the six-role configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "medpi-meeting-settings-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  allowFileRoot(cwd);
  let sequence = 0;
  const roster = resolveGroupMeetingRoster(availableModels());
  const meeting = await createGroupMeetingFromRoster(cwd, roster, {
    agentDir,
    createSession: async (_cwd, command) => ({
      sessionId: `settings-session-${++sequence}`,
      data: null,
      model: { provider: command.provider, modelId: command.modelId },
      thinkingLevel: command.thinkingLevel,
    }),
  });
  const settings = roster.map(({ role, provider, modelId, thinkingLevel }, index) => ({
    role,
    provider,
    modelId,
    thinkingLevel: index === 0 ? "high" : thinkingLevel,
  }));
  const applied = [];
  const updated = await updateGroupMeetingSettings(cwd, meeting.meetingId, settings, {
    agentDir,
    visibleModels: availableModels(),
    applySettings: async (member, requested) => {
      applied.push({ sessionId: member.sessionId, ...requested });
      return requested;
    },
  });

  assert.deepEqual(applied, [{
    sessionId: meeting.members[0].sessionId,
    ...settings[0],
  }]);
  assert.equal(updated.members[0].thinkingLevel, "high");
  assert.equal((await readGroupMeeting(cwd, meeting.meetingId, agentDir)).members[0].thinkingLevel, "high");
});

test("cold-restores an undergraduate child with the fixed isolated policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "medpi-child-policy-"));
  const agentDir = join(root, "agent");
  const projectDirectory = join(agentDir, "meetings", "project-key");
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(join(projectDirectory, "meeting.workflow.json"), JSON.stringify({
    version: 1,
    meetingId: "meeting-id",
    cwd: join(root, "project"),
    undergradTasks: [],
    undergradThreads: [{ sessionId: "child-session" }],
  }));

  const policy = await resolveGroupMeetingSessionPolicy("child-session", agentDir);
  assert.equal(policy?.role, "undergraduate");
  assert.deepEqual(policy?.toolNames, ["science_search", "science_fetch", "lab_orchestrate"]);
  assert.match(policy?.systemPrompt ?? "", /isolated child worker/i);
});

test("concurrent creates never merge meeting or session ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "medpi-meeting-concurrent-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
  allowFileRoot(cwd);
  let sequence = 0;
  const fakeCreate = async (_cwd, command) => ({
    sessionId: `session-${++sequence}`,
    data: null,
    model: { provider: command.provider, modelId: command.modelId },
    thinkingLevel: command.thinkingLevel,
  });
  const roster = resolveGroupMeetingRoster(availableModels());
  const meetings = await Promise.all([
    createGroupMeetingFromRoster(cwd, roster, { agentDir, createSession: fakeCreate }),
    createGroupMeetingFromRoster(cwd, roster, { agentDir, createSession: fakeCreate }),
  ]);

  assert.notEqual(meetings[0].meetingId, meetings[1].meetingId);
  assert.equal(new Set(meetings.flatMap((meeting) => meeting.members.map((member) => member.sessionId))).size, 12);
  assert.equal((await listGroupMeetings(cwd, agentDir)).length, 2);
});

test("a member creation failure persists a diagnosable failed meeting, never ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "medpi-meeting-failed-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
  allowFileRoot(cwd);
  let sequence = 0;
  const fakeCreate = async (_cwd, command) => {
    sequence += 1;
    if (sequence === 3) throw new Error("provider unavailable");
    return {
      sessionId: `session-${sequence}`,
      data: null,
      model: { provider: command.provider, modelId: command.modelId },
      thinkingLevel: command.thinkingLevel,
    };
  };

  await assert.rejects(
    () => createGroupMeetingFromRoster(cwd, resolveGroupMeetingRoster(availableModels()), { agentDir, createSession: fakeCreate }),
    (error) => error instanceof GroupMeetingError && error.code === "session_create_failed"
      && error.role === "phd-2" && error.meeting?.status === "failed",
  );
  const meetings = await listGroupMeetings(cwd, agentDir);
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].status, "failed");
  assert.equal(meetings[0].members[2].error, "provider unavailable");
  assert.equal(meetings[0].members.length, 6);
});

test("meeting POST applies request-origin and JSON checks before creation", async () => {
  const source = await readFile(new URL("../app/api/meetings/route.ts", import.meta.url), "utf8");
  const originCheck = source.indexOf("isApiRequestAllowed(req)");
  const contentTypeCheck = source.indexOf("hasJsonContentType(req)");
  const creation = source.indexOf("createGroupMeeting(cwd)");
  assert.ok(originCheck >= 0 && contentTypeCheck > originCheck && creation > contentTypeCheck);
  assert.match(source, /code: "untrusted_request"/);
  assert.match(source, /code: error\.code/);
});

test("meeting settings PATCH applies request security before updating sessions", async () => {
  const source = await readFile(new URL("../app/api/meetings/[id]/route.ts", import.meta.url), "utf8");
  const patch = source.indexOf("export async function PATCH");
  const originCheck = source.indexOf("isApiRequestAllowed(req)", patch);
  const contentTypeCheck = source.indexOf("hasJsonContentType(req)", patch);
  const update = source.indexOf("updateGroupMeetingSettings(cwd, id, body.members)", patch);
  assert.ok(patch >= 0 && originCheck > patch && contentTypeCheck > originCheck && update > contentTypeCheck);
});

test("an empty session is durably recoverable after the in-memory registry is cleared", async () => {
  const root = await mkdtemp(join(tmpdir(), "medpi-empty-session-"));
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
  const manager = SessionManager.create(cwd, sessionDir);
  const inner = { sessionManager: manager, sessionId: manager.getSessionId() };
  const wrapper = new AgentSessionWrapper(inner);

  wrapper.ensurePersistedSession();
  wrapper.ensurePersistedSession();
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile && existsSync(sessionFile));
  assert.match(await readFile(sessionFile, "utf8"), /"type":"session"/);

  globalThis.__piSessions?.clear();
  const recovered = SessionManager.open(sessionFile, sessionDir);
  assert.equal(recovered.getSessionId(), manager.getSessionId());
  assert.equal(recovered.getCwd(), cwd);
});
