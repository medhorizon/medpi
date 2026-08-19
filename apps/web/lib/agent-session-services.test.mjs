import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createMedPiAgentSessionServices } = await jiti.import("./agent-session-services.ts");

test("registers MedPi extensions without project settings", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "medpi-project-"));
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "medpi-agent-"));
  const services = await createMedPiAgentSessionServices({ cwd, agentDir });
  const loaded = services.resourceLoader.getExtensions();
  const tools = new Set(loaded.extensions.flatMap((extension) => [...extension.tools.keys()]));

  assert.deepEqual(loaded.errors, []);
  assert.ok(loaded.extensions.some((extension) => extension.path === "<inline:medpi-lab>"));
  assert.ok(loaded.extensions.some((extension) => extension.path === "<inline:medpi-science>"));
  assert.ok(tools.has("lab_orchestrate"));
  assert.ok(tools.has("science_fetch"));
});
