import { runDetachedProcess } from "./process.ts"
import type { SandboxProvider, SandboxRunRequest, SandboxRunResult } from "./types.ts"

export class NoneSandbox implements SandboxProvider {
  readonly kind = "none" as const

  run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    return runDetachedProcess({ request, argv: request.command })
  }
}
