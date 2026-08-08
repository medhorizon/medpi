import path from "node:path"
import type { ProvenanceStore } from "../provenance.ts"
import { createCheckpoint } from "./rollback.ts"
import { prepareRunDir } from "./run-dir.ts"
import type { SandboxProvider, SandboxRunResult } from "./types.ts"

export interface RunSandboxedInput {
  projectRoot: string
  command: string[]
  provenance: ProvenanceStore
  sandbox: SandboxProvider
  signal?: AbortSignal
  env?: Record<string, string>
  cwd?: string
  sessionId?: string
  /** When true, create a git archive point before spawning. */
  checkpoint?: boolean
}

export interface RunSandboxedOutcome {
  runDir: string
  runId: string
  runNodeId: string
  stdoutLog: string
  stderrLog: string
  result: SandboxRunResult
  checkpointSha?: string
}

export async function runSandboxed(input: RunSandboxedInput): Promise<RunSandboxedOutcome> {
  const projectRoot = path.resolve(input.projectRoot)
  const runDir = await prepareRunDir(projectRoot)
  const runId = path.basename(runDir)
  const stdoutLog = path.join(runDir, "stdout.log")
  const stderrLog = path.join(runDir, "stderr.log")

  let checkpointSha: string | undefined
  if (input.checkpoint) {
    checkpointSha = (await createCheckpoint(projectRoot, runId)).sha
  }

  const result = await input.sandbox.run({
    projectRoot,
    runDir,
    command: input.command,
    env: input.env,
    cwd: input.cwd,
    signal: input.signal,
  })

  const node = await input.provenance.record({
    kind: "run",
    label: `sandbox ${input.sandbox.kind}: ${input.command.join(" ")}`.slice(0, 500),
    tool: "science_run",
    sessionId: input.sessionId,
    inputs: {
      command: input.command,
      runId,
      sandbox: input.sandbox.kind,
      checkpointSha,
    },
    status: result.status,
    meta: {
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      exitCode: result.exitCode,
      signal: result.signal,
      pid: result.pid,
      stdoutLog,
      stderrLog,
      // Discipline: never put credentials into provenance/logs.
    },
  })

  return {
    runDir,
    runId,
    runNodeId: node.id,
    stdoutLog,
    stderrLog,
    result,
    checkpointSha,
  }
}