/**
 * UniProt — the reference protein sequence & functional annotation database.
 *
 * REST API: https://rest.uniprot.org (open, no key). We hit the UniProtKB
 * search + entry endpoints and normalize into ConnectorHit.
 */
import type { Connector, ConnectorHit, FetchOptions, SearchOptions } from "../types"
import { getJSON, getText, orNotFound } from "../http"
import { arr, asRecord, num, str } from "../json"
import { asArray, clampLimit, firstString } from "./util"

interface UValue {
  value?: string
}
interface UName {
  fullName?: UValue
}
interface UDescription {
  recommendedName?: UName
  submissionNames?: UName[]
  alternativeNames?: UName[]
}
interface UComment {
  commentType?: string
  texts?: UValue[]
}
interface UOrganism {
  scientificName?: string
}
interface UEntry {
  primaryAccession?: string
  uniProtkbId?: string
  proteinDescription?: UDescription
  comments?: UComment[]
  organism?: UOrganism
  annotationScore?: number
}
function entry(value: unknown): UEntry {
  const record = asRecord(value)
  const description = asRecord(record.proteinDescription)
  const recommended = asRecord(description.recommendedName)
  const recommendedFull = asRecord(recommended.fullName)
  const names = (key: "submissionNames" | "alternativeNames") => arr(description[key]).map((item) => {
    const name = asRecord(item)
    return { fullName: { value: str(asRecord(name.fullName).value) } }
  })
  return {
    primaryAccession: str(record.primaryAccession),
    uniProtkbId: str(record.uniProtkbId),
    proteinDescription: {
      recommendedName: { fullName: { value: str(recommendedFull.value) } },
      submissionNames: names("submissionNames"),
      alternativeNames: names("alternativeNames"),
    },
    comments: arr(record.comments).map((item) => {
      const comment = asRecord(item)
      return {
        commentType: str(comment.commentType),
        texts: arr(comment.texts).map((text) => ({ value: str(asRecord(text).value) })),
      }
    }),
    organism: {
      scientificName: str(asRecord(record.organism).scientificName),
    },
    annotationScore: num(record.annotationScore),
  }
}

function entryTitle(e: UEntry): string {
  const d = e.proteinDescription
  return (
    firstString(
      d?.recommendedName?.fullName?.value,
      d?.submissionNames?.[0]?.fullName?.value,
      d?.alternativeNames?.[0]?.fullName?.value,
      e.uniProtkbId,
      e.primaryAccession,
    ) ?? "Unknown protein"
  )
}

function entrySummary(e: UEntry): string | undefined {
  const fn = asArray<UComment>(e.comments).find((c) => c.commentType === "FUNCTION")
  const org = e.organism?.scientificName
  return firstString(fn?.texts?.[0]?.value, org ? `Organism: ${org}` : undefined)
}

export const uniprot: Connector = {
  id: "uniprot",
  name: "UniProt",
  domain: "proteomics",
  description: "Protein sequences with function, GO terms, domains, and pathways (UniProtKB).",
  homepage: "https://www.uniprot.org",

  async search(query, opts?: SearchOptions): Promise<ConnectorHit[]> {
    const size = clampLimit(opts?.limit, 10, 25)
    const term = opts?.organism ? `${query} AND organism_id:${opts.organism}` : query
    const url = `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(term)}&format=json&size=${size}`
    const data = asRecord(await orNotFound(getJSON<unknown>(url, { signal: opts?.signal }), {}, opts?.signal))
    return arr(data.results).map(entry).map<ConnectorHit>((e) => {
      const id = e.primaryAccession ?? e.uniProtkbId ?? "unknown"
      return {
        id,
        title: entryTitle(e),
        summary: entrySummary(e),
        url: `https://www.uniprot.org/uniprotkb/${id}`,
        score: e.annotationScore,
      }
    })
  },

  async fetch(id, opts?: FetchOptions): Promise<unknown> {
    const format = opts?.format ?? "json"
    const base = `https://rest.uniprot.org/uniprotkb/${encodeURIComponent(id)}`
    if (format === "json") return getJSON(`${base}?format=json`, { signal: opts?.signal })
    return getText(`${base}?format=${encodeURIComponent(format)}`, { signal: opts?.signal })
  },
}
