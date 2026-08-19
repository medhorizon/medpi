import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("lab_orchestrate exposes the canonical action vocabulary and payload guidance", async () => {
  const source = await readFile(new URL("../extensions/index.ts", import.meta.url), "utf8");
  for (const action of [
    "get_state",
    "ask_clarification",
    "dispatch_doctor",
    "delegate_undergrad",
    "claim_master",
    "submit_master_analysis",
    "submit_doctor_synthesis",
    "review_doctor_synthesis",
    "complete_meeting",
    "cancel_meeting",
  ]) {
    assert.match(source, new RegExp(`"${action}"`));
  }
  assert.match(source, /action: StringEnum\(LAB_ACTIONS\)/);
  assert.match(source, /promptGuidelines: ORCHESTRATE_GUIDELINES/);
  assert.match(source, /server derives the current meeting from this Pi session/);
  const orchestrateTool = source.slice(source.indexOf('name: "lab_orchestrate"'));
  assert.doesNotMatch(orchestrateTool, /meetingId: Type\.String/);
  assert.match(source, /Every mutating action payload requires a unique requestId/);
  assert.match(source, /Robust synthesis requires counterEvidence, sensitivityChecks, uncertainties/);
  assert.match(source, /databaseScope defaults to \[pubmed,crossref\], may explicitly add arxiv/);
  assert.match(source, /rejects all other databases/);
});
