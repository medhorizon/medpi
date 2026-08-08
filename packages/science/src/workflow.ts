// Adapted from MedHorizon v0.3.21 session/stage.ts (Apache-2.0).
// Pi custom entries replace the legacy Session/Bus/Snapshot dependencies so stage
// state follows the active JSONL branch and remains reconstructable after reload.
import z from "zod"

const StageSeed = z.object({
  id: z.string().min(1).max(100),
  index: z.number().int().positive(),
  name: z.string().min(1).max(200),
  summary: z.string().max(10_000).optional(),
  createdAt: z.number().int().nonnegative(),
  requiresApproval: z.boolean(),
})

export const StageEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("entered"), stage: StageSeed }),
  z.object({
    type: z.literal("completed"),
    stageId: z.string().min(1).max(100),
    completedAt: z.number().int().nonnegative(),
    summary: z.string().max(10_000).optional(),
  }),
  z.object({
    type: z.literal("decision"),
    stageId: z.string().min(1).max(100),
    decision: z.enum(["approved", "rejected"]),
    decidedAt: z.number().int().nonnegative(),
    reason: z.string().max(10_000).optional(),
  }),
])

export type StageEvent = z.infer<typeof StageEvent>

export const Stage = StageSeed.extend({
  status: z.enum(["running", "awaiting-approval", "completed", "rejected"]),
  completedAt: z.number().int().nonnegative().optional(),
  decision: z.enum(["approved", "rejected"]).optional(),
  decidedAt: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
})

export type Stage = z.infer<typeof Stage>

/**
 * Derive stage state from append-only entries on the current Pi branch.
 * Invalid and orphaned events are ignored so a partially written extension
 * entry cannot make the entire session unreadable.
 */
export function deriveStages(input: readonly unknown[]): Stage[] {
  const stages = new Map<string, Stage>()

  for (const value of input) {
    const parsed = StageEvent.safeParse(value)
    if (!parsed.success) continue
    const event = parsed.data

    if (event.type === "entered") {
      if (stages.has(event.stage.id)) continue
      stages.set(event.stage.id, {
        ...event.stage,
        status: event.stage.requiresApproval ? "awaiting-approval" : "running",
      })
      continue
    }

    const stage = stages.get(event.stageId)
    if (!stage) continue

    if (event.type === "completed") {
      if (stage.status === "completed" || stage.status === "rejected") continue
      if (stage.requiresApproval && stage.decision !== "approved") continue
      stages.set(event.stageId, {
        ...stage,
        status: "completed",
        completedAt: event.completedAt,
        summary: event.summary ?? stage.summary,
      })
      continue
    }

    if (!stage.requiresApproval || stage.status !== "awaiting-approval") continue
    stages.set(event.stageId, {
      ...stage,
      status: event.decision === "approved" ? "running" : "rejected",
      decision: event.decision,
      decidedAt: event.decidedAt,
      reason: event.reason,
    })
  }

  return [...stages.values()].sort((a, b) => a.index - b.index)
}
