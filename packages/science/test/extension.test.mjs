import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent"
import { createJiti } from "jiti"

const root = path.resolve(import.meta.dirname, "..")
const extension = path.join(root, "extensions", "index.ts")
const prompt = path.join(root, "prompts", "science-review.md")
const jiti = createJiti(import.meta.url)
const { registry } = await jiti.import("../src/connectors/index.ts")
const { ProvenanceStore, contentId } = await jiti.import("../src/provenance.ts")
const { default: science } = await jiti.import("../extensions/index.ts")

function scienceTools() {
  const tools = new Map()
  science({
    on() {},
    registerTool(definition) { tools.set(definition.name, { definition }) },
  })
  return tools
}

function trustedContext(cwd) {
  return {
    cwd,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "science-session" },
  }
}

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
      "science_kernel",
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
  await assert.rejects(
    result.extensions[0].tools.get("science_kernel").definition.execute(
      "kernel-1",
      { action: "status", language: "python" },
      undefined,
      undefined,
      untrusted,
    ),
    /trusted project/,
  )
})

test("search and fetch persist backend-derived source provenance", async (context) => {
  const originalGet = registry.get.bind(registry)
  context.after(() => { registry.get = originalGet })
  registry.get = () => ({
    search: async () => [{ id: "PMID:1", title: "Evidence", summary: "source text", url: "https://example.test/1", score: 1 }],
    fetch: async () => ({ title: "Evidence", authors: ["Researcher"], doi: "10.1/example" }),
  })
  const cwd = await mkdtemp(path.join(os.tmpdir(), "medpi-source-provenance-"))
  const tools = scienceTools()
  const search = await tools.get("science_search").definition.execute(
    "search-1",
    { database: "pubmed", query: "TP53", limit: 1 },
    undefined,
    undefined,
    trustedContext(cwd),
  )
  const fetch = await tools.get("science_fetch").definition.execute(
    "fetch-1",
    { database: "pubmed", id: "PMID:1" },
    undefined,
    undefined,
    trustedContext(cwd),
  )
  const nodes = await new ProvenanceStore(path.join(cwd, ".medpi", "provenance.json")).list()
  const sources = nodes.filter((node) => node.kind === "source")

  assert.equal(sources.length, 2)
  assert.equal(search.details.sourceProvenanceId, sources.find((node) => node.meta.tool === "science_search").id)
  assert.equal(fetch.details.sourceProvenanceId, sources.find((node) => node.meta.tool === "science_fetch").id)
  const searchSource = sources.find((node) => node.meta.tool === "science_search")
  assert.deepEqual(searchSource.meta.content.hits, [{ id: "PMID:1", title: "Evidence", summary: "source text", url: "https://example.test/1", score: 1 }])
  assert.equal(searchSource.id, contentId({
    kind: "source",
    label: "science_search pubmed: TP53",
    meta: searchSource.meta,
  }))
})

test("failed or aborted source calls never write successful provenance", async (context) => {
  const originalGet = registry.get.bind(registry)
  context.after(() => { registry.get = originalGet })
  const cwd = await mkdtemp(path.join(os.tmpdir(), "medpi-source-provenance-failure-"))
  const tools = scienceTools()
  registry.get = () => ({
    search: async () => { throw new Error("source unavailable") },
    fetch: async () => { throw new Error("source unavailable") },
  })
  await assert.rejects(
    tools.get("science_search").definition.execute("search-error", { database: "pubmed", query: "TP53" }, undefined, undefined, trustedContext(cwd)),
    /source unavailable/,
  )
  registry.get = () => ({
    search: async (_query, options) => {
      options.signal?.throwIfAborted?.()
      return [{ id: "PMID:1", title: "Evidence" }]
    },
    fetch: async () => ({ id: "PMID:1" }),
  })
  const controller = new AbortController()
  controller.abort(new Error("cancelled"))
  await assert.rejects(
    tools.get("science_search").definition.execute("search-aborted", { database: "pubmed", query: "TP53" }, controller.signal, undefined, trustedContext(cwd)),
    /cancelled/,
  )
  assert.equal((await new ProvenanceStore(path.join(cwd, ".medpi", "provenance.json")).list()).length, 0)
})
