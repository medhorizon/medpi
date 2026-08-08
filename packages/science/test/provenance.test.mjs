import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createJiti } from "jiti"

const jiti = createJiti(import.meta.url)
const { ProvenanceStore } = await jiti.import("../src/provenance.ts")

async function store() {
  const root = await mkdtemp(path.join(os.tmpdir(), "medpi-provenance-"))
  return new ProvenanceStore(path.join(root, "graph.json"))
}

test("content IDs are stable for nested metadata with different key order", async () => {
  const graph = await store()
  const first = await graph.record({
    kind: "source",
    label: "Dataset",
    meta: { query: { organism: "human", term: "TP53" }, page: 1 },
  })
  const second = await graph.record({
    kind: "source",
    label: "Dataset",
    meta: { page: 1, query: { term: "TP53", organism: "human" } },
  })

  assert.equal(first.id, second.id)
  assert.equal(first.id.length, 64)
  assert.equal((await graph.list()).length, 1)
})

test("rejects oversized provenance payloads before writing project state", async () => {
  const graph = await store()
  await assert.rejects(
    graph.record({ kind: "claim", label: "x".repeat(70 * 1024) }),
    /payload exceeds/,
  )
  assert.equal((await graph.list()).length, 0)
})

test("links deduplicate and lineage queries traverse the connected graph", async () => {
  const graph = await store()
  const source = await graph.record({ kind: "source", label: "PubMed PMID 1" })
  const run = await graph.record({ kind: "run", label: "Extraction", tool: "science_fetch", status: "ok" })
  const artifact = await graph.record({ kind: "artifact", label: "Evidence table", artifactType: "dataset" })

  await graph.link({ from: source.id, to: run.id, relation: "consumed" })
  await graph.link({ from: run.id, to: artifact.id, relation: "produced" })
  await graph.link({ from: run.id, to: artifact.id, relation: "produced" })

  const lineage = await graph.query(artifact.id)
  assert.deepEqual(new Set(lineage.nodes.map((node) => node.id)), new Set([source.id, run.id, artifact.id]))
  assert.equal(lineage.edges.length, 2)
})

test("review findings create an append-only evidence edge", async () => {
  const graph = await store()
  const claim = await graph.record({ kind: "claim", label: "Treatment improves survival" })
  const result = await graph.review({
    target: claim.id,
    finding: {
      claim: "Treatment improves survival",
      issue: "The cited study reports response rate, not survival",
      severity: "major",
      evidence: "PMID:1, Results paragraph 2",
    },
    verdict: "refutes",
    reviewer: "science-reviewer",
  })

  const lineage = await graph.query(claim.id)
  assert.equal(result.relation, "refutes")
  assert.ok(lineage.edges.some((edge) => edge.from === result.node.id && edge.to === claim.id))
})
