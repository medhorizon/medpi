import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { validateGroupMeeting, validateGroupMeetingList } = await jiti.import("./useGroupMeeting.ts");
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

test("validates persisted meeting lists", () => {
  const first = validMeeting();
  const second = { ...validMeeting(), meetingId: "meeting-2" };
  assert.deepEqual(validateGroupMeetingList({ meetings: [first, second] }, first.cwd), [first, second]);
  assert.throws(() => validateGroupMeetingList({ meetings: [first] }, "/tmp/other"), /Invalid group meeting response/);
});

test("locks opening and restores the latest ready meeting before creating", () => {
  assert.match(hookSource, /if \(!cwd \|\| openingRef\.current\) return null/);
  assert.match(hookSource, /openingRef\.current = true/);
  assert.match(hookSource, /useGroupMeeting\(cwd: string \| null, meetingId: string \| null = null\)/);
  assert.match(hookSource, /`\/api\/meetings\/\$\{encodeURIComponent\(normalizedId\)\}\?cwd=\$\{encodeURIComponent\(cwd\)\}`/);
  const lookup = hookSource.indexOf("fetch(`/api/meetings?cwd=");
  const creation = hookSource.indexOf('fetch("/api/meetings"', lookup);
  assert.ok(lookup >= 0 && creation > lookup);
  assert.match(hookSource, /find\(\(candidate\) => candidate\.status === "ready"\)/);
  assert.match(hookSource, /if \(cwd && meetingId\)[\s\S]*loadMeeting\(meetingId\)/);
  assert.match(hookSource, /Project cwd is required to load a meeting/);
});

test("preserves backend diagnostics for preflight failures", () => {
  const responseCheck = hookSource.indexOf("if (!response.ok)", hookSource.indexOf("const openMeeting"));
  const successValidation = hookSource.indexOf("const nextMeeting", responseCheck);
  assert.ok(responseCheck >= 0 && successValidation > responseCheck);
  assert.match(hookSource, /failedCandidate[\s\S]*responseError\(payload, response\.status\)/);
});

test("updates meeting settings through the meeting endpoint and adopts the verified response", () => {
  const update = hookSource.indexOf("const updateMeetingSettings");
  assert.ok(update >= 0);
  assert.match(hookSource.slice(update), /method: "PATCH"/);
  assert.match(hookSource.slice(update), /body: JSON\.stringify\(\{ members \}\)/);
  assert.match(hookSource.slice(update), /const updated = validateGroupMeeting\(payload, cwd\)/);
  assert.match(hookSource.slice(update), /setMeeting\(updated\)/);
});

test("deletes the active meeting through its endpoint and clears local state", () => {
  const deletion = hookSource.indexOf("const deleteMeeting");
  assert.ok(deletion >= 0);
  const deleteSource = hookSource.slice(deletion);
  assert.match(deleteSource, /method: "DELETE"/);
  assert.match(deleteSource, /activeMeetingIdRef\.current = null/);
  assert.match(deleteSource, /setMeeting\(null\)/);
});
