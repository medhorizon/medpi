import type { Connector, ConnectorHit } from "../types"
import { getJSON, getText, NCBI_RATE_LIMIT, orNotFound } from "../http"
import { arr, asRecord, str } from "../json"
import { snippet } from "./shared"

/**
 * PubMed via NCBI E-utilities.
 *
 * Search is two hops: ESearch (query → PMID list) then ESummary (PMIDs →
 * citation metadata). Fetch adds the abstract text via EFetch. All endpoints
 * are public and key-free (the shared http helper handles polite rate limits).
 */

const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

interface Author {
  name?: string
}

interface Summary {
  uid?: string
  title?: string
  fulljournalname?: string
  source?: string
  pubdate?: string
  authors?: Author[]
  elocationid?: string
  volume?: string
  issue?: string
  pages?: string
}

function summary(value: unknown): Summary {
  const record = asRecord(value)
  return {
    uid: str(record.uid),
    title: str(record.title),
    fulljournalname: str(record.fulljournalname),
    source: str(record.source),
    pubdate: str(record.pubdate),
    authors: arr(record.authors).map((author) => ({ name: str(asRecord(author).name) })),
    elocationid: str(record.elocationid),
    volume: str(record.volume),
    issue: str(record.issue),
    pages: str(record.pages),
  }
}

function citation(s: Summary): string | undefined {
  const authors = (s.authors ?? [])
    .map((a) => a.name)
    .filter(Boolean)
    .slice(0, 3)
  const lead = authors.length ? `${authors.join(", ")}${(s.authors?.length ?? 0) > 3 ? " et al." : ""}. ` : ""
  const venue = [s.fulljournalname ?? s.source, s.pubdate].filter(Boolean).join(", ")
  const out = `${lead}${venue}`.trim()
  return out.length ? out : undefined
}

export const pubmed: Connector = {
  id: "pubmed",
  name: "PubMed",
  domain: "literature",
  description: "Biomedical literature abstracts and citations from NCBI (MEDLINE/PubMed).",
  homepage: "https://pubmed.ncbi.nlm.nih.gov",

  async search(query, opts) {
    const size = Math.min(opts?.limit ?? 10, 50)
    const esearch = asRecord(await getJSON<unknown>(
      `${BASE}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${size}&term=${encodeURIComponent(query)}`,
      { signal: opts?.signal, rateLimit: NCBI_RATE_LIMIT },
    ))
    const ids = arr(asRecord(esearch.esearchresult).idlist).map(str).filter((id): id is string => id !== undefined)
    if (ids.length === 0) return []

    const esummary = asRecord(await getJSON<unknown>(`${BASE}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`, {
      signal: opts?.signal,
      rateLimit: NCBI_RATE_LIMIT,
    }))
    const result = asRecord(esummary.result)
    return ids
      .map((id) => summary(result[id]))
      .filter((value) => value.uid !== undefined)
      .map<ConnectorHit>((s) => ({
        id: s.uid ?? "",
        title: snippet(s.title, 300) ?? `PMID ${s.uid}`,
        summary: citation(s),
        url: `https://pubmed.ncbi.nlm.nih.gov/${s.uid}/`,
      }))
  },

  async fetch(id, opts) {
    const clean = id.replace(/[^0-9]/g, "")
    const esummary = asRecord(await getJSON<unknown>(`${BASE}/esummary.fcgi?db=pubmed&retmode=json&id=${clean}`, {
      signal: opts?.signal,
      rateLimit: NCBI_RATE_LIMIT,
    }))
    const record = asRecord(esummary.result)[clean]
    const parsed = record === undefined ? undefined : summary(record)

    const abstract = await orNotFound<string | undefined>(
      getText(`${BASE}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&id=${clean}`, {
        signal: opts?.signal,
        rateLimit: NCBI_RATE_LIMIT,
      }),
      undefined,
      opts?.signal,
    )

    return {
      pmid: clean,
      url: `https://pubmed.ncbi.nlm.nih.gov/${clean}/`,
      summary: parsed,
      abstract: abstract?.trim() || undefined,
    }
  },
}
