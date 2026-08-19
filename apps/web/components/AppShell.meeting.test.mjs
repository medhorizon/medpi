import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("restores explicit and recent meetings while keeping their cwd in navigation", () => {
  assert.match(source, /useGroupMeeting\(meetingCwd, meetingMode \? initialNavigation\.meetingId : null\)/);
  assert.match(source, /const opened = await openMeeting\(\)/);
  assert.match(source, /buildMeetingNavigationUrl\(opened\.meetingId, opened\.cwd\)/);
});

test("guards desktop meeting creation and preserves the previous chat", () => {
  assert.match(source, /meetingButtonDisabled = meetingCreating \|\| meetingConfiguring \|\| meetingDeleting \|\| \(!meetingMode && \(!meetingCwd \|\| isMobile\)\)/);
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

test("meeting mode adds the role configuration card to the lower-left sidebar", () => {
  assert.match(source, /meetingMode && meeting && \(\s*<GroupMeetingConfigCard/);
  assert.match(source, /onSave=\{handleMeetingSettingsSave\}/);
  assert.match(source, /setModelsRefreshKey\(\(key\) => key \+ 1\)/);
  assert.match(source, /meetingCreating \|\| meetingConfiguring/);
});

test("meeting mode exposes a confirmed delete button immediately left of New", () => {
  assert.match(source, /window\.confirm\(translate\("meeting\.deleteConfirm"\)\)/);
  assert.match(source, /onDeleteMeeting=\{meetingMode && meeting/);
  const deleteButton = sidebarSource.indexOf("{onDeleteMeeting && (");
  const newButton = sidebarSource.indexOf("onClick={handleNewSession}", deleteButton);
  assert.ok(deleteButton >= 0 && newButton > deleteButton);
});

test("meeting file links retain their member session authorization", () => {
  assert.match(source, /handleOpenMeetingFile = useCallback\(\(filePath: string, sessionId: string\)/);
  assert.match(source, /sourceSessionId: sessionId/);
  assert.match(source, /onOpenFile=\{handleOpenMeetingFile\}/);
});
