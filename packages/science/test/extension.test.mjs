import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent"

const root = path.resolve(import.meta.dirname, "..")
const extension = path.join(root, "extensions", "index.ts")
const prompt = path.join(root, "prompts", "science-review.md")

test("Pi loads exactly the active science tools and reviewer prompt", async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "medpi-agent-"))
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    additionalExtensionPaths: [extension],
    additionalPromptTemplatePaths: [prompt],
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
  })
  await loader.reload()

  const result = loader.getExtensions()
  assert.deepEqual(result.errors, [])
  assert.equal(result.extensions.length, 1)
  assert.deepEqual(
    [...result.extensions[0].tools.keys()].sort(),
    [
      "provenance_query",
      "provenance_record",
      "provenance_review",
      "science_fetch",
      "science_inspect",
      "science_list_dbs",
      "science_rollback",
      "science_run",
      "science_search",
      "science_stage",
    ],
  )
  assert.ok(loader.getPrompts().prompts.some((value) => value.name === "science-review"))

  const untrusted = { isProjectTrusted: () => false }
  await assert.rejects(
    result.extensions[0].tools.get("science_inspect").definition.execute(
      "inspect-1",
      { path: "sample.csv" },
      undefined,
      undefined,
      untrusted,
    ),
    /trusted project/,
  )
  await assert.rejects(
    result.extensions[0].tools.get("provenance_query").definition.execute(
      "query-1",
      {},
      undefined,
      undefined,
      untrusted,
    ),
    /trusted project/,
  )
})
