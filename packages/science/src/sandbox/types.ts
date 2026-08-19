export type SandboxKind = "none" | "bwrap"

export type RunStatus = "ok" | "error" | "cancelled"

export interface SandboxRunRequest {
  projectRoot: string
  runDir: string
  command: string[]
  env?: Record<string, string>
  cwd?: string
  signal?: AbortSignal
}

export interface SandboxRunResult {
  status: RunStatus
  exitCode: number | null
  signal: NodeJS.Signals | number | null
  pid: number
  startedAt: string
  endedAt: string
}

/** A long-lived interpreter process owned by a sandbox provider. */
export interface SandboxProcess {
  readonly pid: number
  readonly stdin: NodeJS.WritableStream | null
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  readonly closed: Promise<SandboxRunResult>
  interrupt(): void
}

export interface SandboxProvider {
  readonly kind: SandboxKind
  run(request: SandboxRunRequest): Promise<SandboxRunResult>
  start(request: SandboxRunRequest): SandboxProcess
}
