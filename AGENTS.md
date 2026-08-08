# MedPi Agent Notes

- `apps/web` is the editable pi-web source baseline. Run it with `npm run dev`; do not run `next build` during development.
- MedHorizon-derived behavior belongs in `packages/science`, not in Pi core or copied legacy runtimes.
- Do not copy whole MedHorizon directories. Every migrated file must be listed in `docs/science-platform-migration.md` with a current consumer.
- Keep Pi types inside `packages/science/extensions`; domain modules under `src` must remain Pi-independent.
- Scientific network requests must be abortable, bounded, and restricted to declared source hosts.
- Sandboxed project runs go through `science_run` / `packages/science/src/sandbox` (default provider `none`; Linux optional `bwrap`) with permission owner, audit, abort, and rollback. Do not add R/notebook/kernel UI or unsandboxed exec paths; keep credentials out of logs/provenance.
- Do not commit `node_modules`, `.next`, credentials, sessions, runtime data, or generated artifacts.
