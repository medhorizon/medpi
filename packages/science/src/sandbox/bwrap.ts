import path from "node:path"
import { runDetachedProcess, startDetachedProcess } from "./process.ts"
import type { SandboxProcess, SandboxProvider, SandboxRunRequest, SandboxRunResult } from "./types.ts"

export interface BwrapSandboxOptions {
  /** Extra paths that must be writable inside the sandbox (e.g. virtualenvs). */
  writablePaths?: string[]
  bwrapPath?: string
}

function uniqueResolved(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of paths) {
    const resolved = path.resolve(value)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    out.push(resolved)
  }
  return out
}

export function buildBwrapArgv(
  request: SandboxRunRequest,
  options: BwrapSandboxOptions = {},
): string[] {
  if (!request.command.length) {
    throw new Error("sandbox command must not be empty")
  }

  const projectRoot = path.resolve(request.projectRoot)
  const runDir = path.resolve(request.runDir)
  const cwd = path.resolve(request.cwd ?? projectRoot)
  const writable = uniqueResolved([
    projectRoot,
    runDir,
    ...(options.writablePaths ?? []),
    ...(process.env.VIRTUAL_ENV ? [process.env.VIRTUAL_ENV] : []),
    ...(process.env.CONDA_PREFIX ? [process.env.CONDA_PREFIX] : []),
  ])

  const argv = [
    options.bwrapPath ?? "bwrap",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    // Keep a private tmp so accidental writes outside the project fail closed.
    "--tmpfs",
    "/tmp",
  ]

  for (const dir of writable) {
    argv.push("--bind", dir, dir)
  }

  argv.push("--chdir", cwd, "--", ...request.command)
  return argv
}

export class BwrapSandbox implements SandboxProvider {
  readonly kind = "bwrap" as const

  constructor(private readonly options: BwrapSandboxOptions = {}) {}

  run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    return runDetachedProcess({
      request,
      argv: buildBwrapArgv(request, this.options),
    })
  }

  start(request: SandboxRunRequest): SandboxProcess {
    return startDetachedProcess({
      request,
      argv: buildBwrapArgv(request, this.options),
    })
  }
}
