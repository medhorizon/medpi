export interface LabMessageToolInput {
  cwd: string;
  meetingId: string;
  senderSessionId: string;
  toRoles: string[];
  body: string;
  replyTo?: string;
  idempotencyKey?: string;
}

export interface LabOrchestrateToolInput {
  cwd: string;
  actorSessionId: string;
  action: string;
  payload: unknown;
}

export interface LabScienceDatabaseAuthorizationInput {
  cwd: string;
  sessionId: string;
  undergradTaskId?: string;
  database: string;
  operation: "search" | "fetch";
}

export interface LabRuntime {
  sendMessage(input: LabMessageToolInput): Promise<unknown>;
  orchestrate(input: LabOrchestrateToolInput): Promise<unknown>;
  authorizeScienceDatabase?(input: LabScienceDatabaseAuthorizationInput): Promise<void>;
}

const RUNTIME_KEY = Symbol.for("medpi.lab.runtime");

function runtimeSlot(): { runtime?: LabRuntime } {
  const globals = globalThis as typeof globalThis & { [RUNTIME_KEY]?: { runtime?: LabRuntime } };
  return globals[RUNTIME_KEY] ??= {};
}

/** Bound by the web server; extensions never call the web API or import its code. */
export function configureLabRuntime(next: LabRuntime): void {
  runtimeSlot().runtime = next;
}

export function getLabRuntime(): LabRuntime {
  const runtime = runtimeSlot().runtime;
  if (!runtime) throw new Error("Lab runtime is unavailable");
  return runtime;
}

/**
 * A missing lab runtime means this is an ordinary science session. Group-meeting
 * sessions are checked by the Web-bound runtime using their real Pi session id.
 */
export async function authorizeLabScienceDatabase(input: LabScienceDatabaseAuthorizationInput): Promise<void> {
  await runtimeSlot().runtime?.authorizeScienceDatabase?.(input);
}
