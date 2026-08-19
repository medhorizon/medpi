export interface NotebookCellDetails {
  kind: "medpi.notebook-cell.v1";
  language: string;
  kernelId: string;
  cellId: string;
  executionCount: number;
  status: string;
  code: string;
  stdout: string;
  stderr: string;
  value: unknown;
  startedAt: string | number;
  endedAt: string | number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function parseNotebookCellDetails(value: unknown): NotebookCellDetails | null {
  if (!isRecord(value) || value.kind !== "medpi.notebook-cell.v1") return null;
  if (
    typeof value.language !== "string" ||
    typeof value.kernelId !== "string" ||
    typeof value.cellId !== "string" ||
    !Number.isFinite(value.executionCount) ||
    typeof value.status !== "string" ||
    typeof value.code !== "string" ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    !("value" in value) ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.endedAt)
  ) {
    return null;
  }

  return value as unknown as NotebookCellDetails;
}

function timestampMs(value: string | number): number | null {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatDuration(startedAt: string | number, endedAt: string | number): string {
  const start = timestampMs(startedAt);
  const end = timestampMs(endedAt);
  if (start === null || end === null || end < start) return "duration unavailable";
  const milliseconds = end - start;
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch {
    return String(value);
  }
}

function isFailure(status: string): boolean {
  return /error|failed|cancelled/i.test(status);
}

function Output({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <section>
      <div style={{ marginBottom: 4, color: tone ?? "var(--text-dim)", fontSize: 11, fontWeight: 600 }}>{label}</div>
      <pre
        style={{
          margin: 0,
          padding: "7px 9px",
          maxHeight: 240,
          overflow: "auto",
          borderRadius: 5,
          background: "var(--bg)",
          color: tone ?? "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {value || "(none)"}
      </pre>
    </section>
  );
}

export function NotebookCellResult({ details }: { details: NotebookCellDetails }) {
  const failed = isFailure(details.status);

  return (
    <div
      data-testid="notebook-cell-result"
      style={{
        border: `1px solid ${failed ? "rgba(248,113,113,0.45)" : "rgba(34,197,94,0.3)"}`,
        borderRadius: 7,
        overflow: "hidden",
        background: failed ? "rgba(248,113,113,0.05)" : "rgba(34,197,94,0.04)",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", padding: "7px 10px", color: "var(--text-muted)" }}>
        <span style={{ color: failed ? "#f87171" : "#16a34a", fontFamily: "var(--font-mono)", fontWeight: 600 }}>science_kernel</span>
        <span>{details.language}</span>
        <span>#{details.executionCount}</span>
        <span>{details.status}</span>
        <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{formatDuration(details.startedAt, details.endedAt)}</span>
      </div>
      <div style={{ display: "grid", gap: 10, padding: "0 10px 10px", borderTop: "1px solid var(--border)" }}>
        <details open>
          <summary style={{ padding: "8px 0", color: "var(--text-dim)", cursor: "pointer" }}>Code</summary>
          <pre style={{ margin: 0, padding: "7px 9px", overflow: "auto", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{details.code}</pre>
        </details>
        <Output label="stdout" value={details.stdout} />
        <Output label="stderr" value={details.stderr} tone={details.stderr ? "#f87171" : undefined} />
        <Output label="value" value={formatValue(details.value)} />
      </div>
    </div>
  );
}
