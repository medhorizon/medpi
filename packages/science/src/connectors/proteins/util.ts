/**
 * Small shared helpers for the protein connector.
 *
 * These are deliberately defensive: every external API returns loosely-typed
 * JSON that changes shape over time, so the connectors narrow values through
 * these helpers instead of trusting a fixed schema.
 */

/** Clamp a requested limit into `[1, max]`, defaulting when unset. */
export function clampLimit(limit: number | undefined, def: number, max: number): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : def
  return Math.min(Math.max(1, n), max)
}

/** Return the first non-empty string among the candidates, else undefined. */
export function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim().length > 0) return v
  return undefined
}

/** Narrow an unknown value to an array (empty array otherwise). */
export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

