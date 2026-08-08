import assert from "node:assert/strict"
import test from "node:test"
import { createJiti } from "jiti"

const jiti = createJiti(import.meta.url)
const { deriveStages } = await jiti.import("../src/workflow.ts")

test("derives branch-local stage and HITL gate state from append-only events", () => {
  const stages = deriveStages([
    {
      type: "entered",
      stage: { id: "stage-1", index: 1, name: "Literature search", createdAt: 10, requiresApproval: false },
    },
    { type: "completed", stageId: "stage-1", completedAt: 20, summary: "12 papers retained" },
    {
      type: "entered",
      stage: { id: "stage-2", index: 2, name: "Run analysis", createdAt: 30, requiresApproval: true },
    },
  ])

  assert.deepEqual(stages.map((stage) => stage.status), ["completed", "awaiting-approval"])
  assert.equal(stages[0].summary, "12 papers retained")
})

test("approval resumes a gated stage and rejection remains terminal", () => {
  const base = {
    type: "entered",
    stage: { id: "stage-1", index: 1, name: "Experiment", createdAt: 10, requiresApproval: true },
  }

  assert.equal(
    deriveStages([base, { type: "decision", stageId: "stage-1", decision: "approved", decidedAt: 20 }])[0].status,
    "running",
  )
  assert.equal(
    deriveStages([base, { type: "decision", stageId: "stage-1", decision: "rejected", decidedAt: 20 }])[0].status,
    "rejected",
  )
})

test("cannot bypass a gate or rewrite a terminal stage with appended events", () => {
  const gated = {
    type: "entered",
    stage: { id: "stage-1", index: 1, name: "Experiment", createdAt: 10, requiresApproval: true },
  }
  const bypassed = deriveStages([
    gated,
    { type: "completed", stageId: "stage-1", completedAt: 20 },
  ])
  assert.equal(bypassed[0].status, "awaiting-approval")

  const completed = deriveStages([
    gated,
    { type: "decision", stageId: "stage-1", decision: "approved", decidedAt: 20 },
    { type: "completed", stageId: "stage-1", completedAt: 30 },
    { type: "decision", stageId: "stage-1", decision: "rejected", decidedAt: 40 },
  ])
  assert.equal(completed[0].status, "completed")

  const rejected = deriveStages([
    gated,
    { type: "decision", stageId: "stage-1", decision: "rejected", decidedAt: 20 },
    { type: "decision", stageId: "stage-1", decision: "approved", decidedAt: 30 },
  ])
  assert.equal(rejected[0].status, "rejected")
})

test("ignores malformed or orphaned events instead of corrupting stage state", () => {
  const stages = deriveStages([
    { type: "completed", stageId: "missing", completedAt: 1 },
    { type: "entered", stage: { id: "stage-1", index: 1, name: "Valid", createdAt: 2, requiresApproval: false } },
    { type: "unknown", value: true },
  ])

  assert.equal(stages.length, 1)
  assert.equal(stages[0].name, "Valid")
})
