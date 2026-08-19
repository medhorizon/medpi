# MedPi Agent Notes

- `apps/web` is the editable pi-web source baseline. Run it with `npm run dev`; do not run `next build` during development.
- MedHorizon-derived behavior belongs in `packages/science`, not in Pi core or copied legacy runtimes.
- Do not copy whole MedHorizon directories. Every migrated file must be listed in `docs/science-platform-migration.md` with a current consumer.
- Keep Pi types inside `packages/science/extensions`; domain modules under `src` must remain Pi-independent.
- Scientific network requests must be abortable, bounded, and restricted to declared source hosts.
- Sandboxed project runs go through `science_run` / `packages/science/src/sandbox` (default provider `none`; Linux optional `bwrap`) with permission owner, audit, abort, and rollback. Do not add unsandboxed exec paths; keep credentials out of logs/provenance.
- Python/R stateful cells use the Pi-native `science_kernel`: a persistent kernel is scoped to one trusted project, Pi session, and language; its only actions are execute, status, interrupt, and shutdown. It reuses the sandbox/permission-owner boundary, detached process-group abort, bounded code and inline output, per-cell logs/provenance, and checkpoint/rollback. The notebook UI is only a thin Pi-native cell-result renderer, not a `.ipynb` editor—do not copy MedHorizon kernel code or introduce a second API, store, or notebook document format.
- Group meetings reuse exactly six ordinary Pi `AgentSession`s and the existing session/SSE/message paths. The M2 protocol permits senior-member `lab_send_message` routing and only the typed `lab_orchestrate` state transitions; natural-language text never creates tasks or changes state. Keep PI as the only human-input pane; do not add a reviewer session, free-form agent scheduling, a second runtime, provider guessing, or model/thinking-level downgrade.
- After completing each user-requested change, commit the files changed for that request before sending the final response. Never include unrelated user changes in that commit.
- Do not commit `node_modules`, `.next`, credentials, sessions, runtime data, or generated artifacts.
