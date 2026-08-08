import { BwrapSandbox, type BwrapSandboxOptions } from "./bwrap.ts"
import { NoneSandbox } from "./none.ts"
import type { SandboxKind, SandboxProvider } from "./types.ts"

export function createSandbox(
  kind: SandboxKind = "none",
  options?: BwrapSandboxOptions,
): SandboxProvider {
  if (kind === "none") return new NoneSandbox()
  if (kind === "bwrap") return new BwrapSandbox(options)
  throw new Error(`unknown sandbox kind: ${String(kind)}`)
}
