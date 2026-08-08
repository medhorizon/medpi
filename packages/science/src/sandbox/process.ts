import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"
import path from "node:path"
import type { SandboxRunRequest, SandboxRunResult } from "./types.ts"

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

/** Spawn a detached process group, stream logs, honor AbortSignal. */
export function runDetachedProcess(input: {
  request: SandboxRunRequest
  argv: string[]
}): Promise<SandboxRunResult> {
  const { request, argv } = input
  if (!argv.length) {
    return Promise.reject(new Error("sandbox command must not be empty"))
  }

  const startedAt = new Date().toISOString()
  const cwd = request.cwd ?? request.projectRoot
  const stdoutLog = path.join(request.runDir, "stdout.log")
  const stderrLog = path.join(request.runDir, "stderr.log")

  const child: ChildProcess = spawn(argv[0]!, argv.slice(1), {
    cwd,
    env: { ...process.env, ...request.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })

  if (child.pid == null) {
    return Promise.reject(new Error("failed to spawn sandbox process"))
  }
  const pid = child.pid
  const stdoutDone = pipeToFile(child.stdout, stdoutLog)
  const stderrDone = pipeToFile(child.stderr, stderrLog)

  return new Promise((resolve) => {
    let settled = false
    let cancelled = false

    const finish = async (
      status: SandboxRunResult["status"],
      exitCode: number | null,
      signal: NodeJS.Signals | number | null,
    ) => {
      if (settled) return
      settled = true
      request.signal?.removeEventListener("abort", onAbort)
      await Promise.allSettled([stdoutDone, stderrDone])
      resolve({
        status,
        exitCode,
        signal,
        pid,
        startedAt,
        endedAt: new Date().toISOString(),
      })
    }

    const onAbort = () => {
      cancelled = true
      killProcessGroup(pid)
    }

    if (request.signal) {
      if (request.signal.aborted) {
        onAbort()
      } else {
        request.signal.addEventListener("abort", onAbort, { once: true })
      }
    }

    child.on("error", () => {
      void finish(cancelled ? "cancelled" : "error", null, null)
    })

    child.on("close", (code, signal) => {
      if (cancelled || request.signal?.aborted) {
        void finish("cancelled", code, signal)
        return
      }
      void finish(code === 0 ? "ok" : "error", code, signal)
    })
  })
}
