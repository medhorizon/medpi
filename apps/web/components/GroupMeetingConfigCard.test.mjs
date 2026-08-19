import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./GroupMeetingConfigCard.tsx", import.meta.url), "utf8");

test("uses the existing models catalogue for all fixed meeting roles", () => {
  assert.match(source, /fetch\(`\/api\/models\?cwd=/);
  assert.match(source, /GROUP_MEETING_ROSTER\.map/);
  assert.match(source, /models\?\.thinkingLevels/);
  assert.doesNotMatch(source, /gpt-5\.6-sol|deepseek-v4-pro/);
});

test("requires an explicit supported thinking level and applies one batch", () => {
  assert.match(source, /supported\.includes\(current\[role\]\.thinkingLevel\)/);
  assert.match(source, /thinkingLevel: supported[\s\S]*: ""/);
  assert.match(source, /await onSave\(GROUP_MEETING_ROSTER\.map/);
  assert.match(source, /disabled=\{loading \|\| configuring \|\| !complete \|\| !dirty\}/);
});
