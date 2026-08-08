/**
 * NCBI GEO (Gene Expression Omnibus) connector.
 *
 * Backed by the public NCBI E-utilities REST API over the `gds` (GEO DataSets)
 * database — the same entrez interface used elsewhere in the codebase. No API
 * key required (rate-limited to ~3 req/s for anonymous callers).
 *
 * search()  → esearch + esummary over db=gds, returns Series/DataSet records.
 * fetch(id) → resolves a GEO accession (GSE/GDS/GPL/GSM) or numeric UID to its
 *             full esummary record.
 */
import type { Connector, ConnectorHit } from "../types"
import { getJSON, NCBI_RATE_LIMIT } from "../http"
import { arr, asRecord, num, str } from "../json"

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

interface GeoSummary {
  uid?: string
  accession?: string
  title?: string
  summary?: string
  taxon?: string
  gdstype?: string
  entrytype?: string
  gpl?: string
  gse?: string
  n_samples?: number
  pdat?: string
}

function geoSummary(value: unknown): GeoSummary {
  const record = asRecord(value)
  return {
    uid: str(record.uid),
    accession: str(record.accession),
    title: str(record.title),
    summary: str(record.summary),
    taxon: str(record.taxon),
    gdstype: str(record.gdstype),
    entrytype: str(record.entrytype),
    gpl: str(record.gpl),
    gse: str(record.gse),
    n_samples: num(record.n_samples),
    pdat: str(record.pdat),
  }
}

function ids(value: unknown) {
  return arr(asRecord(asRecord(value).esearchresult).idlist)
    .map(str)
    .filter((id): id is string => id !== undefined)
}

/** Canonical GEO accession URL for a record. */
function geoUrl(accession: string): string {
  return `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${encodeURIComponent(accession)}`
}

function toHit(uid: string, s: GeoSummary | undefined): ConnectorHit {
  const accession = s?.accession && s.accession.length > 0 ? s.accession : uid
  const parts = [s?.taxon, s?.gdstype, s?.pdat].filter((x): x is string => Boolean(x))
  return {
    id: accession,
    title: s?.title ?? accession,
    summary: s?.summary ? s.summary.slice(0, 400) : parts.join(" · ") || undefined,
    url: geoUrl(accession),
  }
}

async function summaries(ids: string[], signal?: AbortSignal): Promise<Record<string, GeoSummary>> {
  if (ids.length === 0) return {}
  const data = asRecord(await getJSON<unknown>(`${EUTILS}/esummary.fcgi?db=gds&id=${ids.join(",")}&retmode=json`, {
    signal,
    rateLimit: NCBI_RATE_LIMIT,
  }))
  const result = asRecord(data.result)
  return Object.fromEntries(ids.map((id) => [id, geoSummary(result[id])]))
}

export const geo: Connector = {
  id: "geo",
  name: "NCBI GEO",
  domain: "genomics",
  description: "Gene Expression Omnibus — functional genomics Series, DataSets, and platforms.",
  homepage: "https://www.ncbi.nlm.nih.gov/geo/",

  async search(query, opts) {
    const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 25)
    const search = await getJSON<unknown>(
      `${EUTILS}/esearch.fcgi?db=gds&term=${encodeURIComponent(query)}&retmode=json&retmax=${limit}`,
      { signal: opts?.signal, rateLimit: NCBI_RATE_LIMIT },
    )
    const found = ids(search)
    if (found.length === 0) return []
    const summ = await summaries(found, opts?.signal)
    return found.map((uid) => toHit(uid, summ[uid]))
  },

  async fetch(id, opts) {
    const trimmed = id.trim()
    const isUid = /^\d+$/.test(trimmed)
    let uid = trimmed
    if (!isUid) {
      const search = await getJSON<unknown>(
        `${EUTILS}/esearch.fcgi?db=gds&term=${encodeURIComponent(trimmed)}[ACCN]&retmode=json&retmax=20`,
        { signal: opts?.signal, rateLimit: NCBI_RATE_LIMIT },
      )
      const found = ids(search)
      if (found.length === 0) return { id: trimmed, found: false }
      const summ = await summaries(found, opts?.signal)
      const match = found.find((value) => summ[value]?.accession === trimmed)
      if (match) return summ[match] ?? { id: trimmed, uid: match }
      uid = found[0]
    }
    const summ = await summaries([uid], opts?.signal)
    return summ[uid] ?? { id: trimmed, uid, found: false }
  },
}
