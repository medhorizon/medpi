import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { validateLabWorkflow } = await jiti.import("./useLabWorkflow.ts");
const { GROUP_MEETING_ROSTER } = await jiti.import("../lib/group-meeting.ts");
const hookSource = await readFile(new URL("./useLabWorkflow.ts", import.meta.url), "utf8");

function meeting() {
  return {
    meetingId: "meeting-1",
    cwd: "/tmp/project",
    projectRoot: "/tmp/project",
    createdAt: "2026-08-19T00:00:00.000Z",
    status: "ready",
    members: GROUP_MEETING_ROSTER.map((member, index) => ({
      ...member,
      sessionId: `session-${index + 1}`,
      provider: "openai",
      status: "ready",
    })),
  };
}

function workflow(currentMeeting) {
  return {
    version: 1,
    meetingId: currentMeeting.meetingId,
    cwd: currentMeeting.cwd,
    status: "clarifying",
    clarificationCards: [],
    clarificationResponses: [],
    workPackages: [],
    undergradTasks: [],
    undergradThreads: [],
    masterReservations: [],
  };
}

test("accepts only workflow data for the active meeting and cwd", () => {
  const currentMeeting = meeting();
  const value = workflow(currentMeeting);
  assert.equal(validateLabWorkflow(value, currentMeeting), value);
  assert.throws(
    () => validateLabWorkflow({ ...value, cwd: "/tmp/other" }, currentMeeting),
    /Invalid lab workflow response/,
  );
});

test("uses the PI session with one GET endpoint and one action POST endpoint", () => {
  assert.match(hookSource, /member\.role === "pi"/);
  assert.match(hookSource, /\/api\/meetings\/\$\{encodeURIComponent\(request\.meetingId\)\}\/workflow\?cwd=/);
  assert.match(hookSource, /sessionId=\$\{encodeURIComponent\(request\.sessionId\)\}/);
  assert.match(hookSource, /method: "POST"/);
  assert.match(hookSource, /JSON\.stringify\(\{ cwd: active\.cwd, sessionId: active\.sessionId, action: nextAction \}\)/);
  assert.doesNotMatch(hookSource, /setInterval|setTimeout/);
});
