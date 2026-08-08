import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { arr, asRecord, num, str } from "../json"
import { snippet } from "./shared"

/**
 * Crossref REST API — DOI metadata for ~150M scholarly works.
 *
 * Abstracts, when present, are JATS XML and are stripped to plain text.
 * MedPi intentionally omits the former product contact address; deployments may
 * add a valid contact at the Gateway without impersonating the source project.
 */

const BASE = "https://api.crossref.org/works"

interface Author {
  given?: string
  family?: string
  name?: string
}

interface Work {
  DOI?: string
  title?: string[]
  subtitle?: string[]
  abstract?: string
  author?: Author[]
  "container-title"?: string[]
  publisher?: string
  type?: string
  URL?: string
  score?: number
  "is-referenced-by-count"?: number
  issued?: { "date-parts"?: number[][] }
}

function work(value: unknown): Work {
  const record = asRecord(value)
  const issued = asRecord(record.issued)
  return {
    DOI: str(record.DOI),
    title: arr(record.title).map(str).filter((item): item is string => item !== undefined),
    subtitle: arr(record.subtitle).map(str).filter((item): item is string => item !== undefined),
    abstract: str(record.abstract),
    author: arr(record.author).map((item) => {
      const author = asRecord(item)
      return { given: str(author.given), family: str(author.family), name: str(author.name) }
    }),
    "container-title": arr(record["container-title"]).map(str).filter((item): item is string => item !== undefined),
    publisher: str(record.publisher),
    type: str(record.type),
    URL: str(record.URL),
    score: num(record.score),
    "is-referenced-by-count": num(record["is-referenced-by-count"]),
    issued: {
      "date-parts": arr(issued["date-parts"]).map((part) => arr(part).map(num).filter((item): item is number => item !== undefined)),
    },
  }
}

function year(w: Work): number | undefined {
  return w.issued?.["date-parts"]?.[0]?.[0]
}

function authors(w: Work): string | undefined {
  const names = (w.author ?? []).map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean)
  if (names.length === 0) return undefined
  return names.length > 4 ? `${names.slice(0, 4).join(", ")} et al.` : names.join(", ")
}

function toHit(w: Work): ConnectorHit {
  const meta = [authors(w), w["container-title"]?.[0], year(w)].filter(Boolean).join(". ")
  return {
    id: w.DOI ?? "",
    title: snippet([w.title?.[0], w.subtitle?.[0]].filter(Boolean).join(": "), 300) ?? w.DOI ?? "Untitled",
    summary: snippet(w.abstract) ?? (meta.length ? meta : undefined),
    url: w.URL ?? (w.DOI ? `https://doi.org/${w.DOI}` : undefined),
    score: typeof w.score === "number" ? w.score : undefined,
  }
}

export const crossref: Connector = {
  id: "crossref",
  name: "Crossref",
  domain: "literature",
  description: "Cross-publisher DOI metadata: titles, authors, venues, references, and citations.",
  homepage: "https://www.crossref.org",

  async search(query, opts) {
    const rows = Math.min(opts?.limit ?? 10, 50)
    const data = asRecord(await getJSON<unknown>(
      `${BASE}?query=${encodeURIComponent(query)}&rows=${rows}&select=DOI,title,subtitle,abstract,author,container-title,URL,score,issued`,
      { signal: opts?.signal },
    ))
    return arr(asRecord(data.message).items).map(work).map(toHit)
  },

  async fetch(id, opts) {
    const doi = id.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim()
    const data = asRecord(await getJSON<unknown>(`${BASE}/${encodeURIComponent(doi)}`, {
      signal: opts?.signal,
    }))
    return data.message === undefined ? null : work(data.message)
  },
}
