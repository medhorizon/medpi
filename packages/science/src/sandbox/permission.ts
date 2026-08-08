/**
 * Permission owner for sandboxed code execution.
 *
 * The owner is the human user. Default is auto-allow ("无需询问");
 * callers may temporarily switch to per-run confirmation.
 */
export type PermissionMode = "auto" | "confirm"

export interface PermissionDecision {
  allowed: boolean
  mode: PermissionMode
}

export class PermissionOwner {
  private mode: PermissionMode

  constructor(mode: PermissionMode = "auto") {
    this.mode = mode
  }

  getMode(): PermissionMode {
    return this.mode
  }

  setMode(mode: PermissionMode) {
    this.mode = mode
  }

  /**
   * Decide whether a run may proceed.
   * When mode is "confirm", `ask` must return the user's yes/no.
   */
  async authorize(input: {
    command: string[]
    ask?: (summary: string) => Promise<boolean>
  }): Promise<PermissionDecision> {
    if (this.mode === "auto") {
      return { allowed: true, mode: "auto" }
    }
    if (!input.ask) {
      throw new Error("permission mode is confirm but no ask callback was provided")
    }
    const summary = `Allow sandboxed run?\n${input.command.join(" ")}`.slice(0, 2_000)
    const allowed = await input.ask(summary)
    return { allowed, mode: "confirm" }
  }
}

/** Process-wide default owner (user). Tests may construct their own. */
export const defaultPermissionOwner = new PermissionOwner("auto")
