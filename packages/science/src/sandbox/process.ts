import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"
import path from "node:path"
import type { SandboxProcess, SandboxRunRequest, SandboxRunResult } from "./types.ts"

export function killProcessGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
}

function pipeToFile(stream: NodeJS.ReadableStream | null | undefined, file: string): Promise<void> {
  if (!stream) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file, { mode: 0o600 })
    stream.pipe(out)
    out.on("finish", resolve)
    out.on("error", reject)
    stream.on("error", reject)
  })
}

/** Start a detached process group. The caller owns stream framing and logs. */
export function startDetachedProcess(input: {
  request: SandboxRunRequest
  argv: string[]
}): SandboxProcess {
  const { request, argv } = input
  if (!argv.length) throw new Error("sandbox command must not be empty")

  const startedAt = new Date().toISOString()
  const cwd = request.cwd ?? request.projectRoot
  const child: ChildProcess = spawn(argv[0]!, argv.slice(1), {
    cwd,
    env: { ...process.env, ...request.env },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  if (child.pid == null) throw new Error("failed to spawn sandbox process")

  const pid = child.pid
  let cancelled = false
  const closed = new Promise<SandboxRunResult>((resolve) => {
    let settled = false
    const finish = (
      status: SandboxRunResult["status"],
      exitCode: number | null,
      signal: NodeJS.Signals | number | null,
    ) => {
      if (settled) return
      settled = true
      request.signal?.removeEventListener("abort", onAbort)
      resolve({ status, exitCode, signal, pid, startedAt, endedAt: new Date().toISOString() })
    }
    const onAbort = () => {
      cancelled = true
      killProcessGroup(pid)
    }
    if (request.signal) {
      if (request.signal.aborted) onAbort()
      else request.signal.addEventListener("abort", onAbort, { once: true })
    }
    child.on("error", () => finish(cancelled ? "cancelled" : "error", null, null))
    child.on("close", (code, signal) => {
      finish(cancelled || request.signal?.aborted ? "cancelled" : code === 0 ? "ok" : "error", code, signal)
    })
  })

  return {
    pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    closed,
    interrupt: () => {
      cancelled = true
      killProcessGroup(pid)
    },
  }
}

/** Spawn a detached process group, stream logs, honor AbortSignal. */
export function runDetachedProcess(input: {
  request: SandboxRunRequest
  argv: string[]
}): Promise<SandboxRunResult> {
  const stdoutLog = path.join(input.request.runDir, "stdout.log")
  const stderrLog = path.join(input.request.runDir, "stderr.log")
  const process = startDetachedProcess(input)
  process.stdin?.end()
  const stdoutDone = pipeToFile(process.stdout, stdoutLog)
  const stderrDone = pipeToFile(process.stderr, stderrLog)
  return process.closed.then(async (result) => {
    await Promise.allSettled([stdoutDone, stderrDone])
    return result
  })
}
