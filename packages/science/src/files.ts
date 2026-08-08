// Adapted from MedHorizon v0.3.21 (Apache-2.0).
// The detector and budgets are preserved; legacy Bun/project-runtime coupling is replaced
// with a small Node-compatible, symlink-safe bounded reader for Pi's Node runtime.
import { constants } from "node:fs"
import { open, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { createGunzip } from "node:zlib"
import z from "zod"

/**
 * ScienceFile — the single, backend-owned source of truth for scientific
 * *project-file* classification.
 *
 * Ownership
 * ---------
 * This module classifies project files only. It never invents session,
 * artifact, tool-output, or graph identities. Consumers use this manifest and
 * must not keep a second scientific extension/magic table or override a
 * successful inspection with a local extension guess.
 *
 * This file performs no unbounded file I/O. `detect` is pure over
 * `{ name, size, head }`; `inspect`/`preview` read fixed leading windows,
 * return a capped text preview, and decompress only the inspected window for
 * `.gz`/`.bgz` double extensions.
 */
export namespace ScienceFile {
  /**
   * Frozen resource budgets. These are contract constants (also asserted by
   * `test/files.test.mjs`) so runtime behaviour can never grow an unbounded
   * read, render, or DOM on the frontend.
   */
  export const Budget = {
    /** Max leading bytes read from a file during inspection. Every magic
     * signature in this manifest fits in the first few dozen bytes; 4 KiB also
     * covers the text content-sniffing window without ever pulling a whole
     * file. */
    INSPECT_HEADER_BYTES: 4096,
    /** Max bytes of text preview content returned to a client. */
    PREVIEW_BYTES: 256 * 1024,
    /** Max preview lines (newline-delimited) returned for text. */
    PREVIEW_LINES: 4096,
    /** Files at or under this size may be fully read and edited inline; larger
     * text files degrade to a bounded preview and larger binaries to
     * metadata-only. */
    FULL_READ_BYTES: 1024 * 1024,
  } as const

  export const Mode = z.enum(["text", "binary"]).meta({ ref: "ScienceFileMode" })
  export type Mode = z.infer<typeof Mode>

  export const Evidence = z.enum(["magic", "extension", "none"]).meta({ ref: "ScienceFileEvidence" })
  export type Evidence = z.infer<typeof Evidence>

  export const Family = z
    .enum(["table", "sequence", "genome", "structure", "document", "binary", "unknown"])
    .meta({ ref: "ScienceFileFamily" })
  export type Family = z.infer<typeof Family>

  export const Capability = z
    .enum(["table", "sequence", "genome", "structure", "document", "pdf", "binary", "text", "unknown"])
    .meta({ ref: "ScienceFileCapability" })
  export type Capability = z.infer<typeof Capability>

  export const ReadPolicy = z
    .enum(["editable-full", "bounded-preview", "metadata-only", "streamed-media"])
    .meta({ ref: "ScienceFileReadPolicy" })
  export type ReadPolicy = z.infer<typeof ReadPolicy>

  export const Format = z
    .enum([
      "csv",
      "tsv",
      "fasta",
      "fastq",
      "bed",
      "gff",
      "gtf",
      "vcf",
      "pdb",
      "mmcif",
      "xyz",
      "mol",
      "sdf",
      "latex",
      "pdf",
      "hdf5",
      "h5ad",
      "loom",
      "parquet",
      "arrow",
      "bam",
      "cram",
      "unknown",
    ])
    .meta({ ref: "ScienceFileFormat" })
  export type Format = z.infer<typeof Format>

  export type MagicSignature = {
    /** Space-separated hex bytes, e.g. "89 48 44 46 0D 0A 1A 0A". */
    hex: string
    /** Byte offset where the signature begins (default 0). */
    offset?: number
    /** Human-readable description surfaced in warnings. */
    description: string
  }

  export type FormatSpec = {
    family: Family
    format: Format
    mode: Mode
    capability: Capability
    readPolicy: ReadPolicy
    /** Common aliases, lower-case, no leading dot. The canonical extension
     * equals `format`. */
    aliases: readonly string[]
    /** Byte signatures. For container formats (h5ad/loom) this is a
     * *requirement* used for header-mismatch warnings; magic ownership for
     * detection lives in SIGNATURES so magic never guesses a sub-format. */
    magic?: readonly MagicSignature[]
    /** Static v1 caveats, merged into every detection result for this format. */
    warnings?: readonly string[]
  }

  const MAGIC_HDF5: MagicSignature = { hex: "89 48 44 46 0D 0A 1A 0A", description: "HDF5 container signature" }
  const MAGIC_PDF: MagicSignature = { hex: "25 50 44 46 2D", description: "PDF header (%PDF-)" }
  const MAGIC_PARQUET: MagicSignature = { hex: "50 41 52 31", description: "Parquet header (PAR1)" }
  const MAGIC_ARROW: MagicSignature = { hex: "41 52 52 4F 57 31", description: "Arrow stream header (ARROW1)" }
  const MAGIC_CRAM: MagicSignature = { hex: "43 52 41 4D", description: "CRAM header (CRAM)" }

  /** Magic ownership. Each signature resolves to exactly one format; a shared
   * container (HDF5) always resolves to the container format (hdf5) — never
   * to h5ad/loom — because distinguishing those requires deep parsing. */
  type SignatureFormat = "hdf5" | "pdf" | "parquet" | "arrow" | "cram"
  const SIGNATURES: ReadonlyArray<{ sig: MagicSignature; format: SignatureFormat }> = [
    { sig: MAGIC_HDF5, format: "hdf5" },
    { sig: MAGIC_PDF, format: "pdf" },
    { sig: MAGIC_PARQUET, format: "parquet" },
    { sig: MAGIC_ARROW, format: "arrow" },
    { sig: MAGIC_CRAM, format: "cram" },
  ]

  export const Manifest: Record<Format, FormatSpec> = {
    // table — text/editable until a bounded table renderer consumes this contract.
    csv: { family: "table", format: "csv", mode: "text", capability: "table", readPolicy: "editable-full", aliases: [] },
    tsv: { family: "table", format: "tsv", mode: "text", capability: "table", readPolicy: "editable-full", aliases: ["tab"] },

    // sequence — sequence/MSA renderer or bounded text summary.
    fasta: { family: "sequence", format: "fasta", mode: "text", capability: "sequence", readPolicy: "editable-full", aliases: ["fa", "fna", "ffn", "faa"] },
    fastq: { family: "sequence", format: "fastq", mode: "text", capability: "sequence", readPolicy: "editable-full", aliases: ["fq"] },

    // genome — bounded text/metadata; v1 does NOT wire GenomeTrack.
    bed: { family: "genome", format: "bed", mode: "text", capability: "genome", readPolicy: "editable-full", aliases: [], warnings: ["v1 does not wire GenomeTrack; bounded text/metadata fallback"] },
    gff: { family: "genome", format: "gff", mode: "text", capability: "genome", readPolicy: "editable-full", aliases: ["gff2", "gff3"], warnings: ["v1 does not wire GenomeTrack; bounded text/metadata fallback"] },
    gtf: { family: "genome", format: "gtf", mode: "text", capability: "genome", readPolicy: "editable-full", aliases: [], warnings: ["v1 does not wire GenomeTrack; bounded text/metadata fallback"] },
    vcf: { family: "genome", format: "vcf", mode: "text", capability: "genome", readPolicy: "editable-full", aliases: [], warnings: ["v1 does not wire GenomeTrack; bounded text/metadata fallback"] },

    // structure — small bounded content may reuse renderers; over-budget → metadata.
    pdb: { family: "structure", format: "pdb", mode: "text", capability: "structure", readPolicy: "editable-full", aliases: [] },
    mmcif: { family: "structure", format: "mmcif", mode: "text", capability: "structure", readPolicy: "editable-full", aliases: ["cif"] },
    xyz: { family: "structure", format: "xyz", mode: "text", capability: "structure", readPolicy: "editable-full", aliases: [] },
    mol: { family: "structure", format: "mol", mode: "text", capability: "structure", readPolicy: "editable-full", aliases: ["molfile"] },
    sdf: { family: "structure", format: "sdf", mode: "text", capability: "structure", readPolicy: "editable-full", aliases: ["sd"] },

    // document — keep existing FileView behaviour.
    latex: { family: "document", format: "latex", mode: "text", capability: "document", readPolicy: "editable-full", aliases: ["tex", "ltx"] },
    pdf: { family: "document", format: "pdf", mode: "binary", capability: "pdf", readPolicy: "streamed-media", aliases: [], magic: [MAGIC_PDF] },

    // binary data — family/evidence/size/capability only; NO deep parsing in v1.
    hdf5: { family: "binary", format: "hdf5", mode: "binary", capability: "binary", readPolicy: "metadata-only", aliases: ["h5", "he5", "hdf"], magic: [MAGIC_HDF5], warnings: ["H5AD/loom are HDF5 containers; distinguishing them requires deep parse (not in v1)"] },
    h5ad: { family: "binary", format: "h5ad", mode: "binary", capability: "binary", readPolicy: "metadata-only", aliases: ["anndata"], magic: [MAGIC_HDF5], warnings: ["requires HDF5 container; H5AD layer not verified without deep parse"] },
    loom: { family: "binary", format: "loom", mode: "binary", capability: "binary", readPolicy: "metadata-only", aliases: [], magic: [MAGIC_HDF5], warnings: ["requires HDF5 container; loom layer not verified without deep parse"] },
    parquet: { family: "binary", format: "parquet", mode: "binary", capability: "binary", readPolicy: "metadata-only", aliases: ["pq"], magic: [MAGIC_PARQUET], warnings: ["no deep parse in v1; metadata-only"] },
    arrow: { family: "binary", format: "arrow", mode: "binary", capability: "binary", readPolicy: "metadata-only", aliases: ["feather"], magic: [MAGIC_ARROW], warnings: ["no deep parse in v1; metadata-only"] },
    bam: { family: "binary", format: "bam", mode: "binary", capability: "binary", readPolicy: "metadata-only", aliases: [], warnings: ["BGZF-compressed BAM; no index/range transport in v1; metadata-only"] },
    cram: { family: "binary", format: "cram", mode: "binary", capability: "binary", readPolicy: "metadata-only", aliases: [], magic: [MAGIC_CRAM], warnings: ["no index/range transport in v1; metadata-only"] },

    // unknown — safe fallback; detect() re-derives mode/capability from content.
    unknown: { family: "unknown", format: "unknown", mode: "text", capability: "unknown", readPolicy: "editable-full", aliases: [] },
  }

  const extensionIndex = new Map<string, Format>()
  for (const spec of Object.values(Manifest)) {
    extensionIndex.set(spec.format, spec.format)
    for (const alias of spec.aliases) extensionIndex.set(alias, spec.format)
  }

  function extensionOf(name: string): string | undefined {
    const base = name.replace(/\.$/, "")
    const idx = base.lastIndexOf(".")
    if (idx < 0) return undefined
    const ext = base.slice(idx + 1).toLowerCase()
    return ext || undefined
  }

  function parseHex(hex: string): number[] {
    const result: number[] = []
    for (const part of hex.trim().split(/\s+/)) result.push(parseInt(part, 16))
    return result
  }

  function matchesSignature(head: Uint8Array, sig: MagicSignature): boolean {
    const bytes = parseHex(sig.hex)
    const offset = sig.offset ?? 0
    if (offset + bytes.length > head.length) return false
    for (let i = 0; i < bytes.length; i++) if (head[offset + i] !== bytes[i]) return false
    return true
  }

  function matchMagic(head: Uint8Array | undefined): { sig: MagicSignature; format: SignatureFormat } | undefined {
    if (!head || head.length === 0) return undefined
    for (const entry of SIGNATURES) if (matchesSignature(head, entry.sig)) return entry
    return undefined
  }

  /** NUL bytes in the first 512 inspected bytes is a strong binary signal. */
  function looksBinary(head: Uint8Array | undefined): boolean {
    if (!head || head.length === 0) return false
    const sample = head.subarray(0, Math.min(head.length, 512))
    for (const byte of sample) if (byte === 0) return true
    return false
  }

  /** Size-aware read policy: streamed-media/metadata-only are fixed; an
   * editable file that outgrows the full-read threshold degrades to a bounded
   * preview instead of silently unbounded reads. */
  function effectiveReadPolicy(base: ReadPolicy, size: number): ReadPolicy {
    if (base === "streamed-media" || base === "metadata-only") return base
    if (base === "bounded-preview") return "bounded-preview"
    return size <= Budget.FULL_READ_BYTES ? "editable-full" : "bounded-preview"
  }

  /** A single project-file classification. It carries no session, artifact,
   * tool-output, or graph identity. */
  export const Detection = z
    .object({
      name: z.string().describe("original file name"),
      size: z.number().int().nonnegative().describe("file size in bytes"),
      family: Family,
      format: Format,
      mode: Mode,
      capability: Capability,
      readPolicy: ReadPolicy,
      evidence: Evidence,
      magic: z.boolean().describe("a magic/header byte signature matched"),
      warnings: z.array(z.string()),
    })
    .meta({ ref: "ScienceFileDetection", description: "Science file detection (project-file contract)" })
  export type Detection = z.infer<typeof Detection>

  const InspectBase = Detection.omit({ mode: true })

  /** Bounded inspect response: text carries a fixed-cap preview
   * (preview/contentBytes/totalBytes/truncated/lines); binary returns metadata
   * only and rejects preview fields. */
  export const Inspect = z
    .discriminatedUnion("mode", [
      InspectBase.extend({
        mode: z.literal("text"),
        preview: z.string().optional().describe("truncated text preview (bounded-preview only)"),
        contentBytes: z.number().int().nonnegative().optional().describe("preview content bytes"),
        totalBytes: z.number().int().nonnegative().optional().describe("total file bytes"),
        truncated: z.boolean().optional().describe("preview was truncated to a fixed budget"),
        lines: z.number().int().nonnegative().optional().describe("preview line count"),
      }),
      InspectBase.extend({ mode: z.literal("binary") }).strict(),
    ])
    .meta({ ref: "ScienceFileInspect", description: "Bounded science file inspect response" })
  export type Inspect = z.infer<typeof Inspect>

  /** Bounded preview route response: text carries a fixed-cap preview;
   * binary returns metadata only and rejects content fields. */
  export const Preview = z
    .discriminatedUnion("mode", [
      z.object({
        name: z.string().describe("original file name"),
        mode: z.literal("text"),
        format: Format,
        readPolicy: ReadPolicy,
        preview: z.string().describe("truncated text preview (bounded-preview only)"),
        contentBytes: z.number().int().nonnegative().describe("preview content bytes"),
        totalBytes: z.number().int().nonnegative().describe("total file bytes"),
        truncated: z.boolean().describe("preview was truncated to a fixed budget"),
        lines: z.number().int().nonnegative().describe("preview line count"),
      }),
      z.object({
        name: z.string().describe("original file name"),
        mode: z.literal("binary"),
      }).strict(),
    ])
    .meta({ ref: "ScienceFilePreview", description: "Bounded science file text preview or binary metadata" })
  export type Preview = z.infer<typeof Preview>

  export type DetectInput = {
    /** Original file name (may be a relative path); extension is
     * case-insensitive. */
    name: string
    /** File size in bytes; 0 is treated as an empty file. */
    size: number
    /** Leading bytes already read from the file (≤ Budget.INSPECT_HEADER_BYTES).
     * Omit when no header was inspected. */
    head?: Uint8Array
  }

  /** Pure classification — no file I/O. Magic/header evidence always wins over
   * the extension; conflicts surface as warnings. An empty file is always
   * unknown (never guessed from an extension); unknown binary content degrades
   * to metadata-only. */
  export function detect(input: DetectInput): Detection {
    const { name, size } = input
    const head = input.head
    const ext = extensionOf(name)
    const warnings: string[] = []

    if (size === 0) {
      return {
        name,
        size,
        family: "unknown",
        format: "unknown",
        mode: "text",
        capability: "text",
        readPolicy: "editable-full",
        evidence: "none",
        magic: false,
        warnings: [...warnings, "empty file"],
      }
    }

    const sig = matchMagic(head)
    if (sig) {
      const spec = Manifest[sig.format]
      if (!ext) {
        warnings.push(`no extension; classified by magic signature (${sig.sig.description})`)
      } else {
        const suggested = extensionIndex.get(ext)
        if (suggested === undefined || suggested !== sig.format) {
          warnings.push(`magic signature for ${sig.format} overrides extension .${ext}`)
        }
      }
      return {
        name,
        size,
        family: spec.family,
        format: spec.format,
        mode: spec.mode,
        capability: spec.capability,
        readPolicy: effectiveReadPolicy(spec.readPolicy, size),
        evidence: "magic",
        magic: true,
        warnings: [...warnings, ...(spec.warnings ?? [])],
      }
    }

    const suggested = ext ? extensionIndex.get(ext) : undefined
    if (suggested) {
      const spec = Manifest[suggested]
      if (spec.magic && spec.magic.length > 0) {
        warnings.push(
          head && head.length > 0
            ? `expected ${spec.magic.map((s) => s.description).join(" or ")} header for ${suggested}; header mismatch (corrupt or truncated)`
            : `no header bytes inspected; classified by extension .${ext} only`,
        )
      }
      return {
        name,
        size,
        family: spec.family,
        format: spec.format,
        mode: spec.mode,
        capability: spec.capability,
        readPolicy: effectiveReadPolicy(spec.readPolicy, size),
        evidence: "extension",
        magic: false,
        warnings: [...warnings, ...(spec.warnings ?? [])],
      }
    }

    // Unknown: content-sniffed, safe fallback (download + details always work).
    const binary = looksBinary(head)
    warnings.push(ext ? `unrecognized extension .${ext}` : "no extension")
    if (binary) warnings.push("unrecognized binary content")
    return {
      name,
      size,
      family: "unknown",
      format: "unknown",
      mode: binary ? "binary" : "text",
      capability: binary ? "binary" : "text",
      readPolicy: binary ? "metadata-only" : effectiveReadPolicy("editable-full", size),
      evidence: "none",
      magic: false,
      warnings,
    }
  }

  // ── Bounded inspection. Only fixed leading windows of the file are read:
  //   INSPECT_HEADER_BYTES for `inspect`, plus a capped PREVIEW_BYTES window
  //   for the text preview. A full read is never performed.
  //   `.gz`/`.bgz` double extensions are resolved by decompressing only the
  //   inspected window (partial-decompress tolerant of a truncated member).

  const COMPRESSION_SUFFIXES = [".gz", ".bgz"] as const

  /** Return the inner name when `name` carries a `.gz`/`.bgz` compression
   * suffix (case-insensitive), else undefined. */
  function compressionSuffix(name: string): string | undefined {
    const lower = name.toLowerCase()
    for (const suffix of COMPRESSION_SUFFIXES) {
      if (lower.endsWith(suffix)) return name.slice(0, -suffix.length)
    }
    return undefined
  }

  type SliceFile = {
    slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> }
  }

  function within(root: string, target: string) {
    const relative = path.relative(root, target)
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  }

  async function requireFile(root: string, requested: string) {
    const base = await realpath(root)
    const input = requested.replace(/^@/, "")
    const candidate = path.resolve(base, input)
    if (!within(base, candidate)) throw new Error(`Science file is outside the allowed root: ${requested}`)
    const absolute = await realpath(candidate)
    if (!within(base, absolute)) throw new Error(`Science file is outside the allowed root: ${requested}`)
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error(`Science path is not a file: ${requested}`)
    return { absolute, size: info.size }
  }

  function nodeFile(absolute: string): SliceFile {
    return {
      slice(start, end) {
        return {
          async arrayBuffer() {
            const length = Math.max(0, end - start)
            if (length === 0) return new ArrayBuffer(0)
            const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
            const buffer = Buffer.alloc(length)
            const result = await handle.read(buffer, 0, length, start).finally(() => handle.close())
            const bytes = new Uint8Array(result.bytesRead)
            bytes.set(buffer.subarray(0, result.bytesRead))
            return bytes.buffer
          },
        }
      },
    }
  }

  /** Bounded leading read — never more than INSPECT_HEADER_BYTES. */
  async function readHead(file: SliceFile, size: number): Promise<Uint8Array> {
    const end = Math.min(size, Budget.INSPECT_HEADER_BYTES)
    if (end <= 0) return new Uint8Array(0)
    return new Uint8Array(await file.slice(0, end).arrayBuffer())
  }

  /** Partial-decompress an inspected gzip window. A `.gz`/`.bgz` inspected head
   * is frequently a truncated gzip member (BGZF blocks can be 64 KiB); instead
   * of failing we return as much decompressed output as the window allows,
   * capped at PREVIEW_BYTES. `complete` is false when the member was truncated. */
  function decompressHead(
    bytes: Uint8Array,
  ): Promise<{ data: Uint8Array | undefined; complete: boolean }> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let total = 0
      const max = Budget.PREVIEW_BYTES
      const gunzip = createGunzip()
      let done = false
      const settle = (data: Uint8Array | undefined, complete: boolean) => {
        if (done) return
        done = true
        resolve({ data, complete })
      }
      gunzip.on("data", (chunk: Buffer) => {
        const remaining = max - total
        if (remaining <= 0) return gunzip.destroy()
        const part = chunk.subarray(0, remaining)
        chunks.push(part)
        total += part.length
        if (total < max) return
        settle(new Uint8Array(Buffer.concat(chunks)), false)
        gunzip.destroy()
      })
      gunzip.on("end", () => settle(Buffer.concat(chunks), true))
      gunzip.on("error", () => {
        // Truncated member — surface the partial output if any.
        settle(chunks.length > 0 ? new Uint8Array(Buffer.concat(chunks)) : undefined, false)
      })
      gunzip.end(bytes)
    })
  }

  /** Cap a decoded text preview to the frozen byte/line budgets. `fullRead`
   * indicates the source covered the whole file, so only the caps can mark the
   * preview truncated. Lines count newline-terminated lines (a trailing newline
   * is not an extra line). */
  function capPreview(content: string, fullRead: boolean) {
    const byteTruncated = Buffer.byteLength(content, "utf8") > Budget.PREVIEW_BYTES
    const clipped = byteTruncated
      ? Buffer.from(content, "utf8").subarray(0, Budget.PREVIEW_BYTES).toString("utf8")
      : content
    const bounded = Buffer.byteLength(clipped, "utf8") > Budget.PREVIEW_BYTES
      ? clipped.slice(0, -1)
      : clipped
    const count = (lines: string[]) => (lines.at(-1) === "" ? lines.length - 1 : lines.length)
    const parts = bounded.split("\n")
    const lineTruncated = count(parts) > Budget.PREVIEW_LINES
    const preview = lineTruncated ? parts.slice(0, Budget.PREVIEW_LINES).join("\n") : bounded
    return {
      preview,
      contentBytes: Buffer.byteLength(preview, "utf8"),
      lines: count(preview.split("\n")),
      truncated: !fullRead || byteTruncated || lineTruncated,
    }
  }

  function decodeText(bytes: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  }

  /**
   * Bounded project-file inspection. Reads only a frozen leading window
   * (never the full file), resolves `.gz`/`.bgz` by decompressing the inspected
   * window, runs the pure detector, and returns a contract-conformant Inspect.
   * Text files carry a fixed-cap preview; binary files are metadata-only.
   */
  export async function inspect(input: { root: string; path: string }): Promise<Inspect> {
    const { absolute, size } = await requireFile(input.root, input.path)
    const file = nodeFile(absolute)
    const head = await readHead(file, size)

    const inner = compressionSuffix(input.path)
    const detectName = inner ?? input.path
    const gz = inner !== undefined
    const decompressed = gz ? await decompressHead(head) : undefined
    const effectiveHead = gz ? (decompressed?.data ?? head) : head

    const base = detect({ name: detectName, size, head: effectiveHead })
    const warnings = gz
      ? [...base.warnings, "gzip-compressed; classified inner extension"]
      : base.warnings

    if (base.mode === "binary") {
      return Inspect.parse({ ...base, name: input.path, warnings })
    }

    const fullRead = !gz && size <= head.length
    const capped = capPreview(decodeText(effectiveHead), fullRead)
    return Inspect.parse({
      ...base,
      name: input.path,
      warnings,
      preview: capped.preview,
      contentBytes: capped.contentBytes,
      totalBytes: size,
      truncated: capped.truncated,
      lines: capped.lines,
    })
  }

  /**
   * Bounded text preview (or binary metadata-only). Reads at most a
   * PREVIEW_BYTES window plus the inspect head; decompresses the window for
   * `.gz`/`.bgz`. Returns fixed byte/line caps with totalBytes/truncated.
   */
  export async function preview(input: { root: string; path: string }): Promise<Preview> {
    const { absolute, size } = await requireFile(input.root, input.path)
    const file = nodeFile(absolute)
    const inner = compressionSuffix(input.path)
    const detectName = inner ?? input.path
    const gz = inner !== undefined
    const data = await (async () => {
      const end = Math.min(size, Budget.PREVIEW_BYTES)
      const source = new Uint8Array(end > 0 ? await file.slice(0, end).arrayBuffer() : new ArrayBuffer(0))
      if (!gz) {
        return {
          head: source.subarray(0, Budget.INSPECT_HEADER_BYTES),
          source,
          full: size <= end,
        }
      }
      const decompressed = await decompressHead(source)
      const output = decompressed.data ?? new Uint8Array(0)
      return {
        head: output.subarray(0, Budget.INSPECT_HEADER_BYTES),
        source: output,
        full: size <= end && decompressed.complete,
      }
    })()

    const base = detect({ name: detectName, size, head: data.head })
    if (base.mode === "binary") {
      return Preview.parse({ name: input.path, mode: "binary" })
    }

    const capped = capPreview(decodeText(data.source), data.full)
    return Preview.parse({
      name: input.path,
      mode: "text",
      format: base.format,
      readPolicy: base.readPolicy,
      preview: capped.preview,
      contentBytes: capped.contentBytes,
      totalBytes: size,
      truncated: capped.truncated,
      lines: capped.lines,
    })
  }
}
