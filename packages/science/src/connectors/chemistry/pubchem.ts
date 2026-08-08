import type { Connector, ConnectorHit } from "../types"
import { getJSON, NCBI_RATE_LIMIT, orNotFound } from "../http"
import { arr, asRecord, num, str } from "../json"

/**
 * PubChem — NCBI's public chemical database (PUG REST). No key required.
 *   search: name -> CIDs (word match), then a batched property table.
 *     GET /rest/pug/compound/name/<query>/cids/JSON?name_type=word
 *     GET /rest/pug/compound/cid/<csv>/property/<fields>/JSON
 *   fetch:  GET /rest/pug/compound/cid/<CID>/JSON  (full compound record)
 */
const BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
const FIELDS = "Title,MolecularFormula,MolecularWeight,ConnectivitySMILES,InChIKey,IUPACName"

interface Property {
  CID?: number
  Title?: string
  IUPACName?: string
  MolecularFormula?: string
  MolecularWeight?: string
  ConnectivitySMILES?: string
  InChIKey?: string
}

function property(value: unknown): Property {
  const record = asRecord(value)
  return {
    CID: num(record.CID),
    Title: str(record.Title),
    IUPACName: str(record.IUPACName),
    MolecularFormula: str(record.MolecularFormula),
    MolecularWeight: str(record.MolecularWeight),
    ConnectivitySMILES: str(record.ConnectivitySMILES),
    InChIKey: str(record.InChIKey),
  }
}

function summarize(p: Property): string | undefined {
  const parts = [
    p.MolecularFormula ? `Formula ${p.MolecularFormula}` : undefined,
    p.MolecularWeight ? `MW ${p.MolecularWeight}` : undefined,
    p.ConnectivitySMILES ? `SMILES ${p.ConnectivitySMILES}` : undefined,
    p.InChIKey ? p.InChIKey : undefined,
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : undefined
}

export const pubchem: Connector = {
  id: "pubchem",
  name: "PubChem",
  domain: "chemistry",
  description: "Chemical compounds, structures, and properties from NCBI PubChem.",
  homepage: "https://pubchem.ncbi.nlm.nih.gov",

  async search(query, opts) {
    const limit = Math.min(opts?.limit ?? 10, 25)
    const cidUrl = `${BASE}/compound/name/${encodeURIComponent(query)}/cids/JSON?name_type=word`
    const cidData = asRecord(await orNotFound(
      getJSON<unknown>(cidUrl, { signal: opts?.signal, rateLimit: NCBI_RATE_LIMIT }),
      {},
      opts?.signal,
    ))
    const cids = arr(asRecord(cidData.IdentifierList).CID)
      .map(num)
      .filter((cid): cid is number => cid !== undefined)
      .slice(0, limit)
    if (!cids.length) return []

    const propUrl = `${BASE}/compound/cid/${cids.join(",")}/property/${FIELDS}/JSON`
    const propData = asRecord(await orNotFound(
      getJSON<unknown>(propUrl, { signal: opts?.signal, rateLimit: NCBI_RATE_LIMIT }),
      {},
      opts?.signal,
    ))
    const props = arr(asRecord(propData.PropertyTable).Properties).map(property)

    return props.map<ConnectorHit>((p) => {
      const cid = p.CID != null ? String(p.CID) : ""
      return {
        id: cid,
        title: p.Title ?? p.IUPACName ?? (cid ? `CID ${cid}` : "(unknown compound)"),
        summary: summarize(p),
        url: cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}` : undefined,
      }
    })
  },

  async fetch(id, opts) {
    const url = `${BASE}/compound/cid/${encodeURIComponent(id)}/JSON`
    return getJSON(url, { signal: opts?.signal, rateLimit: NCBI_RATE_LIMIT })
  },
}
