import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("restores only the explicit meeting and keeps its cwd in navigation", () => {
  assert.match(source, /useGroupMeeting\(meetingCwd, meetingMode \? initialNavigation\.meetingId : null\)/);
  assert.match(source, /buildMeetingNavigationUrl\(created\.meetingId, created\.cwd\)/);
});

test("guards desktop meeting creation and preserves the previous chat", () => {
  assert.match(source, /meetingButtonDisabled = meetingCreating \|\| \(!meetingMode && \(!meetingCwd \|\| isMobile\)\)/);
  assert.match(source, /initialNavigation\.meetingId \? \{ selectedSession: null, newSessionCwd: null \} : null/);
  assert.match(source, /meetingReturnStateRef\.current = \{ selectedSession, newSessionCwd \}/);
  assert.match(source, /setSelectedSession\(previous\.selectedSession\)/);
  assert.match(source, /setNewSessionCwd\(previous\.newSessionCwd\)/);
});

test("meeting mode owns the center while single-session controls stay hidden", () => {
  assert.match(source, /\{meetingMode \? \(\s*<GroupMeetingView/);
  assert.match(source, /\{showChat && !meetingMode && \(/);
  assert.match(source, /\{showChat && !meetingMode && \(sessionStats \|\| contextUsage\)/);
});

test("meeting file links retain their member session authorization", () => {
  assert.match(source, /handleOpenMeetingFile = useCallback\(\(filePath: string, sessionId: string\)/);
  assert.match(source, /sourceSessionId: sessionId/);
  assert.match(source, /onOpenFile=\{handleOpenMeetingFile\}/);
});
