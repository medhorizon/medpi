import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { validateGroupMeeting } = await jiti.import("./useGroupMeeting.ts");
const { GROUP_MEETING_ROSTER } = await jiti.import("../lib/group-meeting.ts");
const hookSource = await readFile(new URL("./useGroupMeeting.ts", import.meta.url), "utf8");

function validMeeting() {
  return {
    meetingId: "meeting-1",
    cwd: "/tmp/project",
    projectRoot: "/tmp/project",
    createdAt: "2026-08-17T00:00:00.000Z",
    status: "ready",
    members: GROUP_MEETING_ROSTER.map((member, index) => ({
      role: member.role,
      label: member.label,
      sessionId: `session-${index + 1}`,
      provider: member.modelId.startsWith("deepseek") ? "deepseek" : "openai",
      modelId: member.modelId,
      thinkingLevel: member.thinkingLevel,
      status: "ready",
    })),
  };
}

test("accepts the fixed six-member meeting contract", () => {
  const meeting = validMeeting();
  assert.equal(validateGroupMeeting(meeting, meeting.cwd), meeting);
});

test("rejects cross-project and reordered meeting data", () => {
  const meeting = validMeeting();
  assert.throws(() => validateGroupMeeting(meeting, "/tmp/other"), /Invalid group meeting response/);
  [meeting.members[0], meeting.members[1]] = [meeting.members[1], meeting.members[0]];
  assert.throws(() => validateGroupMeeting(meeting, meeting.cwd), /Invalid group meeting member response/);
});

test("rejects duplicate session ids and incomplete ready members", () => {
  const duplicate = validMeeting();
  duplicate.members[1].sessionId = duplicate.members[0].sessionId;
  assert.throws(() => validateGroupMeeting(duplicate, duplicate.cwd), /Duplicate group meeting session/);

  const incomplete = validMeeting();
  incomplete.members[2].provider = null;
  assert.throws(() => validateGroupMeeting(incomplete, incomplete.cwd), /Ready group meeting has an incomplete member/);
});

test("accepts a persisted creating meeting without inventing sessions", () => {
  const creating = validMeeting();
  creating.status = "creating";
  creating.members = creating.members.map((member) => ({
    ...member,
    sessionId: null,
    status: "creating",
  }));
  assert.equal(validateGroupMeeting(creating, creating.cwd), creating);
});

test("locks creation and restores only an explicitly selected meeting id", () => {
  assert.match(hookSource, /if \(!cwd \|\| creatingRef\.current\) return null/);
  assert.match(hookSource, /creatingRef\.current = true/);
  assert.match(hookSource, /useGroupMeeting\(cwd: string \| null, meetingId: string \| null = null\)/);
  assert.match(hookSource, /`\/api\/meetings\/\$\{encodeURIComponent\(normalizedId\)\}\?cwd=\$\{encodeURIComponent\(cwd\)\}`/);
  assert.doesNotMatch(hookSource, /fetch\(`\/api\/meetings\?cwd=/);
  assert.match(hookSource, /if \(cwd && meetingId\)[\s\S]*loadMeeting\(meetingId\)/);
  assert.match(hookSource, /Project cwd is required to load a meeting/);
});

test("preserves backend diagnostics for preflight failures", () => {
  const responseCheck = hookSource.indexOf("if (!response.ok)", hookSource.indexOf("const createMeeting"));
  const successValidation = hookSource.indexOf("const nextMeeting", responseCheck);
  assert.ok(responseCheck >= 0 && successValidation > responseCheck);
  assert.match(hookSource, /failedCandidate[\s\S]*responseError\(payload, response\.status\)/);
});
