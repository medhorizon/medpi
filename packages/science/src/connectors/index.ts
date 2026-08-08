// Curated minimum from MedHorizon v0.3.21 (Apache-2.0).
// One or two public, keyless sources per initial science workflow are registered;
// the remaining MedHorizon connectors stay at source until a real consumer needs them.
import { pubchem } from "./chemistry/pubchem"
import { ensembl } from "./genomics/ensembl"
import { arxiv } from "./literature/arxiv"
import { crossref } from "./literature/crossref"
import { pubmed } from "./literature/pubmed"
import { geo } from "./omics/geo"
import { reactome } from "./pathways/reactome"
import { uniprot } from "./proteins/uniprot"
import { ConnectorRegistry } from "./types"

export const registry = new ConnectorRegistry()

for (const connector of [arxiv, crossref, pubmed, pubchem, ensembl, uniprot, reactome, geo]) {
  registry.register(connector)
}

export { ConnectorRegistry } from "./types"
export type {
  CatalogEntry,
  Connector,
  ConnectorDomain,
  ConnectorHit,
  FetchOptions,
  SearchOptions,
} from "./types"
