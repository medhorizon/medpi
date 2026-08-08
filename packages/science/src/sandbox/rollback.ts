import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { cleanupRunDir } from "./run-dir.ts"

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 })
  return stdout.trim()
}

export interface Checkpoint {
  sha: string
  label: string
}

export async function createCheckpoint(projectRoot: string, label: string): Promise<Checkpoint> {
  const cwd = path.resolve(projectRoot)
  await git(cwd, ["rev-parse", "--is-inside-work-tree"]).catch(() => {
    throw new Error(`rollback requires a git repository: ${cwd}`)
  })

  await git(cwd, ["add", "-A"])
  const status = await git(cwd, ["status", "--porcelain"])
  if (status) {
    await git(cwd, ["commit", "-m", `medpi-sandbox-checkpoint: ${label}`.slice(0, 200)])
  } else {
    // Ensure an empty commit exists so the sha uniquely marks this pre-run point.
    await git(cwd, ["commit", "--allow-empty", "-m", `medpi-sandbox-checkpoint: ${label}`.slice(0, 200)])
  }

  const sha = await git(cwd, ["rev-parse", "HEAD"])
  return { sha, label }
}

export async function rollbackToCheckpoint(input: {
  projectRoot: string
  sha: string
  runDir?: string
}): Promise<void> {
  const cwd = path.resolve(input.projectRoot)
  if (!/^[0-9a-f]{7,40}$/i.test(input.sha)) {
    throw new Error(`invalid checkpoint sha: ${input.sha}`)
  }
  await git(cwd, ["reset", "--hard", input.sha])
  if (input.runDir) {
    await cleanupRunDir(input.runDir)
  }
}
