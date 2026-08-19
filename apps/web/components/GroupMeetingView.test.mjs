import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viewSource = await readFile(new URL("./GroupMeetingView.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const englishSource = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
const chineseSource = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");

test("renders six session-keyed panes in an accessible 3 by 2 desktop grid", () => {
  assert.match(viewSource, /role="group"/);
  assert.match(viewSource, /aria-label=\{t\("meeting\.sixAgentGrid"\)\}/);
  assert.match(viewSource, /grid-cols-3 grid-rows-2/);
  assert.match(viewSource, /meeting\.members\.map\(\(member\) =>/);
  assert.match(viewSource, /key=\{member\.sessionId \?\? member\.role\}/);
  assert.match(viewSource, /<ChatWindow[\s\S]*key=\{session\.id\}[\s\S]*session=\{session\}/);
  assert.match(viewSource, /role="region"/);
  assert.match(viewSource, /data-session-id=\{member\.sessionId \?\? ""\}/);
  assert.match(viewSource, /onOpenFile\?: \(filePath: string, sessionId: string\) => void/);
  assert.match(viewSource, /onOpenFile\?\.\(filePath, member\.sessionId\)/);
  assert.match(viewSource, /onOpenFile=\{handleOpenFile\}/);
});

test("keeps the PI writable and all other panes read-only", () => {
  assert.match(viewSource, /const canPrompt = meeting\.status === "ready" && member\.status === "ready" && member\.role === "pi"/);
  assert.match(viewSource, /readOnly=\{!canPrompt\}/);
  assert.match(viewSource, /data-read-only=\{!canPrompt\}/);
  assert.match(chatWindowSource, /if \(readOnly\) return;[\s\S]*registerAbortHandler\(sessionBusy \? handleAbort : null\)/);
  assert.match(chatWindowSource, /readOnly \? \([\s\S]*meeting\.waitingForPi/);
  assert.match(chatWindowSource, /onFork=\{readOnly \|\|/);
  assert.match(chatWindowSource, /onEditContent=\{readOnly \? undefined/);
  assert.match(chatWindowSource, /onNavigate=\{readOnly \|\| sessionBusy \? undefined/);
  assert.match(chatWindowSource, /prevAssistantEntryId=\{readOnly \|\| sessionBusy \? undefined/);
  assert.match(chatWindowSource, /onDragEnter=\{readOnly \? undefined/);
  assert.match(chatWindowSource, /!readOnly && soundEnabledRef\.current/);
  assert.match(chatWindowSource, /!readOnly && extensionDialog/);
  assert.match(chatWindowSource, /!readOnly && extensionCustomUi/);
});

test("shows role, actual runtime model, thinking level, and pane-local status", () => {
  assert.match(viewSource, /const model = runtime\.model \?\?/);
  assert.match(viewSource, /`\$\{model\.provider\}\/\$\{model\.modelId\}`/);
  assert.match(viewSource, /member\.thinkingLevel \? ` · \$\{member\.thinkingLevel\}`/);
  assert.match(viewSource, /onRuntimeStateChange=\{handleRuntimeStateChange\}/);
  assert.match(viewSource, /role="status"/);
  assert.match(viewSource, /paneError \?\? t\("meeting\.sessionUnavailable"\)/);
  assert.match(viewSource, /projectRoot: meeting\.projectRoot/);
  assert.match(viewSource, /member\.status === "creating"[\s\S]*meeting\.memberCreating/);
});

test("shows a clear narrow-screen fallback instead of squeezing the panes", () => {
  assert.match(viewSource, /const isMobile = useIsMobile\(\)/);
  assert.match(viewSource, /if \(isMobile\)/);
  assert.match(viewSource, /meeting\.desktopOnly/);
  assert.match(englishSource, /"meeting\.desktopOnly": "Group meetings are available on desktop"/);
  assert.match(chineseSource, /"meeting\.desktopOnly": "组会仅支持桌面端"/);
});
