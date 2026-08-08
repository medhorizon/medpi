// Adapted from MedHorizon v0.3.21 science/provenance (Apache-2.0).
// The legacy app-global/Bun persistence is replaced by an explicit, atomic store.
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import z from "zod"

const MAX_NODE_BYTES = 64 * 1024
const MAX_EDGE_BYTES = 16 * 1024
const MAX_GRAPH_BYTES = 16 * 1024 * 1024

export const NodeKind = z.enum(["artifact", "run", "source", "claim"])
export type NodeKind = z.infer<typeof NodeKind>

export const EdgeRelation = z.enum(["produced", "consumed", "derived-from", "supports", "refutes"])
export type EdgeRelation = z.infer<typeof EdgeRelation>

const Meta = z.record(z.string(), z.unknown())

const Base = z.object({
  id: z.string().min(1).max(64),
  kind: NodeKind,
  label: z.string().min(1).max(500),
  recordedAt: z.string(),
  meta: Meta.optional(),
})

const Artifact = Base.extend({
  kind: z.literal("artifact"),
  artifactType: z.string().min(1).max(100),
  path: z.string().max(4096).optional(),
  contentHash: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
})

const Run = Base.extend({
  kind: z.literal("run"),
  tool: z.string().min(1).max(200),
  sessionId: z.string().optional(),
  inputs: Meta.optional(),
  status: z.enum(["ok", "error", "cancelled", "timeout"]).optional(),
})

const Source = Base.extend({ kind: z.literal("source") })
const Claim = Base.extend({ kind: z.literal("claim") })

export const ProvenanceNode = z.discriminatedUnion("kind", [Artifact, Run, Source, Claim])
export type ProvenanceNode = z.infer<typeof ProvenanceNode>

export const ProvenanceEdge = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  relation: EdgeRelation,
  meta: Meta.optional(),
})
export type ProvenanceEdge = z.infer<typeof ProvenanceEdge>

const Graph = z.object({
  version: z.literal(1),
  nodes: z.record(z.string(), ProvenanceNode),
  edges: z.array(ProvenanceEdge),
})
type Graph = z.infer<typeof Graph>

interface CommonInput {
  label: string
  meta?: Record<string, unknown>
}

export type ProvenanceInput =
  | (CommonInput & {
      kind: "artifact"
      artifactType: string
      path?: string
      contentHash?: string
      size?: number
    })
  | (CommonInput & {
      kind: "run"
      tool: string
      sessionId?: string
      inputs?: Record<string, unknown>
      status?: "ok" | "error" | "cancelled" | "timeout"
    })
  | (CommonInput & { kind: "source" | "claim" })

export type Severity = "blocking" | "major" | "minor" | "info"

export interface Finding {
  claim: string
  issue: string
  severity: Severity
  evidence: string
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
  return `{${entries.join(",")}}`
}

export function contentId(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

function assertSize(value: unknown, limit: number, kind: string) {
  const size = Buffer.byteLength(canonical(value), "utf8")
  if (size > limit) throw new Error(`${kind} payload exceeds ${limit} bytes`)
}

function empty(): Graph {
  return { version: 1, nodes: {}, edges: [] }
}

export class ProvenanceStore {
  readonly file: string
  private queue: Promise<void> = Promise.resolve()

  constructor(file: string) {
    this.file = path.resolve(file)
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async load(): Promise<Graph> {
    const info = await stat(this.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (info === undefined) return empty()
    if (info.size > MAX_GRAPH_BYTES) throw new Error(`Provenance graph exceeds ${MAX_GRAPH_BYTES} bytes`)
    const data: unknown = JSON.parse(await readFile(this.file, "utf8"))
    const parsed = Graph.safeParse(data)
    if (!parsed.success) throw new Error(`Invalid provenance graph at ${this.file}: ${parsed.error.message}`)
    return parsed.data
  }

  private async save(graph: Graph) {
    await mkdir(path.dirname(this.file), { recursive: true })
    const temp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${process.pid}.${randomUUID()}.tmp`)
    await writeFile(temp, `${JSON.stringify(graph, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(temp, this.file)
  }

  record(input: ProvenanceInput): Promise<ProvenanceNode> {
    return this.serial(async () => {
      assertSize(input, MAX_NODE_BYTES, "Provenance node")
      const graph = await this.load()
      const id = contentId(input)
      const existing = graph.nodes[id]
      if (existing) return existing
      const node = ProvenanceNode.parse({ ...input, id, recordedAt: new Date().toISOString() })
      graph.nodes[id] = node
      await this.save(graph)
      return node
    })
  }

  link(input: ProvenanceEdge): Promise<ProvenanceEdge> {
    return this.serial(async () => {
      assertSize(input, MAX_EDGE_BYTES, "Provenance edge")
      const edge = ProvenanceEdge.parse(input)
      const graph = await this.load()
      if (!graph.nodes[edge.from]) throw new Error(`Unknown provenance node: ${edge.from}`)
      if (!graph.nodes[edge.to]) throw new Error(`Unknown provenance node: ${edge.to}`)
      const exists = graph.edges.some(
        (value) => value.from === edge.from && value.to === edge.to && value.relation === edge.relation,
      )
      if (!exists) {
        graph.edges.push(edge)
        await this.save(graph)
      }
      return edge
    })
  }

  get(id: string): Promise<ProvenanceNode | undefined> {
    return this.serial(async () => (await this.load()).nodes[id])
  }

  list(): Promise<ProvenanceNode[]> {
    return this.serial(async () => Object.values((await this.load()).nodes))
  }

  query(id?: string): Promise<{ nodes: ProvenanceNode[]; edges: ProvenanceEdge[] }> {
    return this.serial(async () => {
      const graph = await this.load()
      if (!id) return { nodes: Object.values(graph.nodes), edges: graph.edges }
      if (!graph.nodes[id]) return { nodes: [], edges: [] }

      const seen = new Set<string>()
      const stack = [id]
      const edges: ProvenanceEdge[] = []
      while (stack.length > 0) {
        const current = stack.pop()
        if (!current || seen.has(current)) continue
        seen.add(current)
        for (const edge of graph.edges) {
          if (edge.from !== current && edge.to !== current) continue
          edges.push(edge)
          const next = edge.from === current ? edge.to : edge.from
          if (!seen.has(next)) stack.push(next)
        }
      }

      const unique = new Map(edges.map((edge) => [`${edge.from}:${edge.relation}:${edge.to}`, edge]))
      return {
        nodes: [...seen].map((node) => graph.nodes[node]).filter((node) => node !== undefined),
        edges: [...unique.values()],
      }
    })
  }

  async review(input: {
    target: string
    finding: Finding
    verdict?: "refutes" | "supports"
    reviewer?: string
    sessionId?: string
  }) {
    if (!(await this.get(input.target))) throw new Error(`Unknown provenance node: ${input.target}`)
    const relation = input.verdict ?? "refutes"
    const node = await this.record({
      kind: "claim",
      label: `review (${input.finding.severity}): ${input.finding.issue}`.slice(0, 140),
      meta: {
        review: true,
        target: input.target,
        ...input.finding,
        verdict: relation,
        reviewer: input.reviewer ?? "science-reviewer",
        sessionId: input.sessionId,
      },
    })
    await this.link({ from: node.id, to: input.target, relation })
    return { node, relation }
  }
}
