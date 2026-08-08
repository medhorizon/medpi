import type { Connector, ConnectorHit } from "../types"
import { getJSON, orNotFound } from "../http"
import { arr, asRecord, str } from "../json"
import { asText, clampLimit, snippet, stripTags } from "./util"

const CONTENT = "https://reactome.org/ContentService"

/**
 * Reactome ContentService — curated, peer-reviewed human pathways, reactions,
 * and molecular events. Fully open, no key required.
 */
export const reactome: Connector = {
  id: "reactome",
  name: "Reactome",
  domain: "biology",
  description: "Curated biological pathways, reactions, and molecular events.",
  homepage: "https://reactome.org",

  async search(query, opts) {
    const limit = clampLimit(opts?.limit, 10, 25)
    const params = new URLSearchParams({ query, cluster: "true" })
    const species = asText(opts?.organism)
    if (species) params.set("species", species)
    const url = `${CONTENT}/search/query?${params.toString()}`
    const data = asRecord(await orNotFound(
      getJSON<unknown>(url, { signal: opts?.signal }),
      {},
      opts?.signal,
    ))

    const hits: ConnectorHit[] = []
    for (const groupValue of arr(data.results)) {
      const group = asRecord(groupValue)
      for (const entryValue of arr(group.entries)) {
        const entry = asRecord(entryValue)
        const id = str(entry.stId) ?? str(entry.id) ?? str(entry.dbId)
        if (!id) continue
        hits.push({
          id,
          title: stripTags(str(entry.name)) || id,
          summary: snippet(stripTags(str(entry.summation))) ?? str(entry.exactType),
          url: `https://reactome.org/content/detail/${encodeURIComponent(id)}`,
        })
        if (hits.length >= limit) return hits
      }
    }
    return hits
  },

  async fetch(id, opts) {
    const url = `${CONTENT}/data/query/${encodeURIComponent(id)}`
    return orNotFound(getJSON(url, { signal: opts?.signal }), null, opts?.signal)
  },
}
