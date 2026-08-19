import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { randomUUID } from "crypto";
import { allowFileRoot } from "./file-access";
import { startRpcSession } from "./rpc-manager";
import { invalidateSessionListCache } from "./session-reader";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface NewAgentSessionCommand {
  provider?: string;
  modelId?: string;
  toolNames?: string[];
  thinkingLevel?: unknown;
  type?: unknown;
  [key: string]: unknown;
}

export interface NewAgentSessionResult {
  sessionId: string;
  data: unknown;
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string | undefined;
}

export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Invalid thinking level: ${String(value)}`);
}

/** Create one real Pi session without routing an internal HTTP request. */
export async function createNewAgentSession(
  cwd: string,
  command: NewAgentSessionCommand,
  options: { persistStartupPreferences?: boolean; persistSession?: boolean; fixedToolNames?: string[]; fixedSystemPrompt?: string } = {},
): Promise<NewAgentSessionResult> {
  const { provider, modelId, toolNames, thinkingLevel, ...promptCommand } = command;
  if ((provider && !modelId) || (!provider && modelId)) {
    throw new Error("provider and modelId must be provided together");
  }
  const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);

  // startRpcSession coalesces callers sharing a key, so every new session gets
  // an unguessable one-use key even when several meetings start concurrently.
  const tempKey = `__new__${randomUUID()}`;
  const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, {
    ...(toolNames ? { toolNames } : {}),
    ...(options.fixedToolNames ? { fixedToolNames: options.fixedToolNames } : {}),
    ...(options.fixedSystemPrompt ? { fixedSystemPrompt: options.fixedSystemPrompt } : {}),
    ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
    ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
    persistStartupPreferences: options.persistStartupPreferences ?? true,
  });

  allowFileRoot(cwd);
  invalidateSessionListCache();

  const state = await session.send({ type: "get_state" }) as {
    model?: { id: string; provider: string };
    thinkingLevel?: string;
  };
  const data = promptCommand.type === "ensure_session"
    ? null
    : await session.send(promptCommand);
  if (options.persistSession) session.ensurePersistedSession();

  return {
    sessionId: realSessionId,
    data,
    model: state.model
      ? { provider: state.model.provider, modelId: state.model.id }
      : null,
    thinkingLevel: state.thinkingLevel,
  };
}
