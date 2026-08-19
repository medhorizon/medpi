import { runDetachedProcess, startDetachedProcess } from "./process.ts"
import type { SandboxProcess, SandboxProvider, SandboxRunRequest, SandboxRunResult } from "./types.ts"

export class NoneSandbox implements SandboxProvider {
  readonly kind = "none" as const

  run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    return runDetachedProcess({ request, argv: request.command })
  }

  start(request: SandboxRunRequest): SandboxProcess {
    return startDetachedProcess({ request, argv: request.command })
  }
}
