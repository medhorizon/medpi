import { randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"

export async function prepareRunDir(projectRoot: string, runId = randomUUID()): Promise<string> {
  const root = path.resolve(projectRoot)
  const runDir = path.join(root, ".medpi", "runs", runId)
  await mkdir(runDir, { recursive: true, mode: 0o700 })
  return runDir
}

export async function cleanupRunDir(runDir: string): Promise<void> {
  const resolved = path.resolve(runDir)
  if (!resolved.includes(`${path.sep}.medpi${path.sep}runs${path.sep}`)) {
    throw new Error(`refusing to cleanup non-run directory: ${runDir}`)
  }
  await rm(resolved, { recursive: true, force: true })
}
