/**
 * Base-URL independent role safety for group-meeting members.
 *
 * Pi's openai-completions encoder sends the system prompt as
 * `role: "developer"` when a reasoning model reports
 * `compat.supportsDeveloperRole`. That flag is auto-detected from the
 * provider / Base URL: known upstreams (deepseek.com, together.ai, ...) are
 * treated as non-standard and default to `false`, but any unknown/custom Base
 * URL defaults to `true`. So pointing a meeting model at a new gateway can
 * silently start emitting `developer`, which many upstreams (DeepSeek,
 * Console Go, ...) reject with a 400.
 *
 * `role: "system"` is accepted by every OpenAI-compatible upstream, so the
 * group meeting pins it on: any roster model that would otherwise emit
 * `developer` gets `compat.supportsDeveloperRole = false` in `models.json` at
 * meeting setup. This is idempotent and only ever adds the safe flag — it
 * never removes an explicit user setting.
 */
import type { Api, Model } from "@earendil-works/pi-ai";

export type MeetingModelRoleAutomationAction =
  | "added_system_role"
  | "already_safe"
  | "unreadable"
  | "failed";

export interface MeetingModelRoleAutomation {
  role: string;
  label: string;
  provider: string;
  modelId: string;
  action: MeetingModelRoleAutomationAction;
}

function supportsDeveloperRoleOf(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole;
}

/** True when this model would emit `role:"developer"` for its system prompt. */
export function modelWouldEmitDeveloperRole(model: Model<Api>): boolean {
  return model.api === "openai-completions" && model.reasoning === true && supportsDeveloperRoleOf(model) !== false;
}

/** models.json subset that this module is allowed to touch. */
export interface ModelsJsonConfig {
  providers?: Record<
    string,
    {
      models?: Array<{ id?: string; compat?: Record<string, unknown> }>;
      modelOverrides?: Record<string, { compat?: Record<string, unknown> }>;
    }
  >;
}

/**
 * Pure transform: force `supportsDeveloperRole: false` on a model entry (and
 * its `modelOverrides` entry when present), preserving every other key.
 * Idempotent: returns `already_safe` when the flag is already `false`.
 */
export function applyModelSystemRoleToConfig(
  config: ModelsJsonConfig,
  providerId: string,
  modelId: string,
): { config: ModelsJsonConfig; action: "added" | "already_safe" | "not_found" } {
  const provider = config.providers?.[providerId];
  const modelEntry = provider?.models?.find((m) => m.id === modelId);
  const overrideEntry = provider?.modelOverrides?.[modelId];

  if (!modelEntry && !overrideEntry) {
    return { config, action: "not_found" };
  }

  let alreadySafe = true;
  if (modelEntry) {
    const compat = modelEntry.compat ?? {};
    if (compat.supportsDeveloperRole !== false) {
      alreadySafe = false;
      modelEntry.compat = { ...compat, supportsDeveloperRole: false };
    }
  }
  if (overrideEntry) {
    const compat = overrideEntry.compat ?? {};
    if (compat.supportsDeveloperRole !== false) {
      alreadySafe = false;
      overrideEntry.compat = { ...compat, supportsDeveloperRole: false };
    }
  }

  return { config, action: alreadySafe ? "already_safe" : "added" };
}
