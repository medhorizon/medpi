import { createHash, randomUUID } from "node:crypto"
import { appendFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ProvenanceStore } from "../provenance.ts"
import { createCheckpoint } from "../sandbox/rollback.ts"
import { prepareRunDir } from "../sandbox/run-dir.ts"
import type { SandboxKind, SandboxProcess, SandboxProvider } from "../sandbox/types.ts"

const MAX_CODE_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = MAX_OUTPUT_BYTES * 3

export type KernelLanguage = "python" | "r"
export type KernelStatus = "running" | "ok" | "error" | "cancelled" | "stopped"

export interface NotebookCellResult {
  kind: "medpi.notebook-cell.v1"
  language: KernelLanguage
  kernelId: string
  cellId: string
  executionCount: number
  status: Exclude<KernelStatus, "running" | "stopped">
  code: string
  stdout: string
  stderr: string
  value: string
  startedAt: string
  endedAt: string
  runDir: string
  checkpointSha: string
  runNodeId: string
  sandbox: SandboxKind
}

interface HelperResult {
  status: "ok" | "error" | "cancelled"
  stdout: string
  stderr: string
  value: string
}

interface PendingCell {
  settle(result: HelperResult): void
}

interface Kernel {
  id: string
  key: string
  language: KernelLanguage
  sandbox: SandboxKind
  runDir: string
  checkpointSha: string
  process: SandboxProcess
  executionCount: number
  pending?: PendingCell
  stderr: string
}

export interface KernelStatusResult {
  language: KernelLanguage
  kernelId?: string
  status: "running" | "stopped"
  executionCount: number
  runDir?: string
  checkpointSha?: string
  sandbox?: SandboxKind
}

declare global {
  var __medpiKernels: Map<string, Kernel> | undefined
}

const kernels = globalThis.__medpiKernels ??= new Map<string, Kernel>()

function bounded(value: string): string {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.length <= MAX_OUTPUT_BYTES) return value
  return `${bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n... (truncated)`
}

function codeHash(code: string) {
  return createHash("sha256").update(code).digest("hex")
}

function helper(language: KernelLanguage): string {
  const name = language === "python" ? "python.py" : "r.R"
  return fileURLToPath(new URL(`./helpers/${name}`, import.meta.url))
}

function runtime(language: KernelLanguage): string[] {
  if (language === "python") {
    const executable = process.env.MEDPI_PYTHON?.trim() || "python3"
    return [executable, "-u", helper(language)]
  }
  const configured = process.env.MEDPI_R?.trim()
  const executable = configured
    ? path.basename(configured) === "R" ? path.join(path.dirname(configured), "Rscript") : configured
    : "Rscript"
  return [executable, helper(language)]
}

function key(projectRoot: string, sessionId: string, language: KernelLanguage) {
  return `${path.resolve(projectRoot)}\u0000${sessionId}\u0000${language}`
}

function consumeLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void, onOverflow: () => void) {
  if (!stream) throw new Error("kernel process has no stdout stream")
  let pending = ""
  let overflowed = false
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    if (overflowed) return
    pending += chunk
    if (Buffer.byteLength(pending, "utf8") > MAX_RESPONSE_BYTES) {
      overflowed = true
      onOverflow()
      return
    }
    let end = pending.indexOf("\n")
    while (end >= 0) {
      onLine(pending.slice(0, end))
      pending = pending.slice(end + 1)
      end = pending.indexOf("\n")
    }
  })
}

function settle(kernel: Kernel, result: HelperResult) {
  const pending = kernel.pending
  if (!pending) return
  kernel.pending = undefined
  pending.settle({
    ...result,
    stdout: bounded(result.stdout),
    stderr: bounded(`${result.stderr}${kernel.stderr}`),
    value: bounded(result.value),
  })
  kernel.stderr = ""
}

async function startKernel(input: {
  projectRoot: string
  sessionId: string
  language: KernelLanguage
  sandbox: SandboxProvider
}): Promise<Kernel> {
  const projectRoot = path.resolve(input.projectRoot)
  const kernelKey = key(projectRoot, input.sessionId, input.language)
  const existing = kernels.get(kernelKey)
  if (existing) {
    if (existing.sandbox !== input.sandbox.kind) {
      throw new Error(`Kernel already uses sandbox ${existing.sandbox}`)
    }
    return existing
  }

  const id = randomUUID()
  const runDir = await prepareRunDir(projectRoot, id)
  const checkpointSha = (await createCheckpoint(projectRoot, `kernel-${id}`)).sha
  const process = input.sandbox.start({
    projectRoot,
    runDir,
    command: runtime(input.language),
  })
  if (!process.stdin) {
    process.interrupt()
    throw new Error("kernel process has no stdin stream")
  }

  const kernel: Kernel = {
    id,
    key: kernelKey,
    language: input.language,
    sandbox: input.sandbox.kind,
    runDir,
    checkpointSha,
    process,
    executionCount: 0,
    stderr: "",
  }
  consumeLines(process.stdout, (line) => {
    try {
      const parsed = JSON.parse(line) as Partial<HelperResult>
      if (parsed.status !== "ok" && parsed.status !== "error") throw new Error("invalid helper response")
      settle(kernel, {
        status: parsed.status,
        stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
        stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
        value: typeof parsed.value === "string" ? parsed.value : "",
      })
    } catch {
      settle(kernel, { status: "error", stdout: "", stderr: "Invalid kernel response", value: "" })
    }
  }, () => {
    kernels.delete(kernelKey)
    process.interrupt()
    settle(kernel, { status: "error", stdout: "", stderr: "Kernel response exceeds output limit", value: "" })
  })
  process.stderr?.setEncoding("utf8")
  process.stderr?.on("data", (chunk: string) => {
    kernel.stderr = bounded(kernel.stderr + chunk)
  })
  void process.closed.then((result) => {
    if (kernels.get(kernelKey) === kernel) kernels.delete(kernelKey)
    settle(kernel, {
      status: result.status === "cancelled" ? "cancelled" : "error",
      stdout: "",
      stderr: result.status === "cancelled" ? "Kernel interrupted" : "Kernel process exited",
      value: "",
    })
  })
  kernels.set(kernelKey, kernel)
  return kernel
}

function send(kernel: Kernel, code: string, signal?: AbortSignal): Promise<HelperResult> {
  const stdin = kernel.process.stdin
  if (!stdin) return Promise.reject(new Error("kernel stdin is unavailable"))
  if (kernel.pending) return Promise.reject(new Error("kernel is already executing a cell"))
  const payload = Buffer.from(code, "utf8")
  if (payload.length > MAX_CODE_BYTES) return Promise.reject(new Error(`cell code exceeds ${MAX_CODE_BYTES} bytes`))

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      interruptKernelByKey(kernel.key)
      resolve({ status: "cancelled", stdout: "", stderr: "Kernel interrupted", value: "" })
    }
    const finish = (result: HelperResult) => {
      signal?.removeEventListener("abort", onAbort)
      resolve(result)
    }
    kernel.pending = { settle: finish }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    stdin.write(Buffer.concat([Buffer.from(`${payload.length}\n`), payload]), (error) => {
      if (!error) return
      kernel.pending = undefined
      signal?.removeEventListener("abort", onAbort)
      reject(error)
    })
  })
}

async function appendCellLogs(kernel: Kernel, cellId: string, result: HelperResult, startedAt: string, endedAt: string) {
  const prefix = `\n[${cellId} ${startedAt}..${endedAt}]\n`
  await Promise.all([
    appendFile(path.join(kernel.runDir, "stdout.log"), `${prefix}${result.stdout}\n`, { mode: 0o600 }),
    appendFile(path.join(kernel.runDir, "stderr.log"), `${prefix}${result.stderr}\n`, { mode: 0o600 }),
    appendFile(path.join(kernel.runDir, "result.jsonl"), `${JSON.stringify({ cellId, status: result.status, value: result.value, startedAt, endedAt })}\n`, { mode: 0o600 }),
  ])
}

export async function executeKernel(input: {
  projectRoot: string
  sessionId: string
  language: KernelLanguage
  code: string
  sandbox: SandboxProvider
  provenance: ProvenanceStore
  signal?: AbortSignal
}): Promise<NotebookCellResult> {
  if (Buffer.byteLength(input.code, "utf8") > MAX_CODE_BYTES) {
    throw new Error(`cell code exceeds ${MAX_CODE_BYTES} bytes`)
  }
  const kernel = await startKernel(input)
  const cellId = randomUUID()
  const executionCount = ++kernel.executionCount
  const startedAt = new Date().toISOString()
  let result: HelperResult
  try {
    result = await send(kernel, input.code, input.signal)
  } catch (error) {
    result = { status: "error", stdout: "", stderr: error instanceof Error ? error.message : String(error), value: "" }
  }
  const endedAt = new Date().toISOString()
  await appendCellLogs(kernel, cellId, result, startedAt, endedAt)
  const node = await input.provenance.record({
    kind: "run",
    label: `kernel ${kernel.language} cell ${executionCount}`,
    tool: "science_kernel",
    sessionId: input.sessionId,
    inputs: {
      kernelId: kernel.id,
      cellId,
      executionCount,
      language: kernel.language,
      sandbox: kernel.sandbox,
      checkpointSha: kernel.checkpointSha,
      codeHash: codeHash(input.code),
    },
    status: result.status,
    meta: { startedAt, endedAt, pid: kernel.process.pid, runDir: kernel.runDir },
  })
  return {
    kind: "medpi.notebook-cell.v1",
    language: kernel.language,
    kernelId: kernel.id,
    cellId,
    executionCount,
    status: result.status,
    code: input.code,
    stdout: result.stdout,
    stderr: result.stderr,
    value: result.value,
    startedAt,
    endedAt,
    runDir: kernel.runDir,
    checkpointSha: kernel.checkpointSha,
    runNodeId: node.id,
    sandbox: kernel.sandbox,
  }
}

function interruptKernelByKey(kernelKey: string): KernelStatusResult {
  const kernel = kernels.get(kernelKey)
  if (!kernel) return { language: kernelKey.endsWith("\u0000r") ? "r" : "python", status: "stopped", executionCount: 0 }
  kernels.delete(kernelKey)
  kernel.process.interrupt()
  settle(kernel, { status: "cancelled", stdout: "", stderr: "Kernel interrupted", value: "" })
  return statusOf(kernel, "stopped")
}

function statusOf(kernel: Kernel, status: "running" | "stopped"): KernelStatusResult {
  return {
    language: kernel.language,
    kernelId: kernel.id,
    status,
    executionCount: kernel.executionCount,
    runDir: kernel.runDir,
    checkpointSha: kernel.checkpointSha,
    sandbox: kernel.sandbox,
  }
}
export function shutdownSessionKernels(projectRoot: string, sessionId: string): void {
  const prefix = `${path.resolve(projectRoot)}\u0000${sessionId}\u0000`
  for (const kernelKey of [...kernels.keys()]) {
    if (kernelKey.startsWith(prefix)) interruptKernelByKey(kernelKey)
  }
}


export function kernelStatus(projectRoot: string, sessionId: string, language: KernelLanguage): KernelStatusResult {
  const kernel = kernels.get(key(projectRoot, sessionId, language))
  return kernel ? statusOf(kernel, "running") : { language, status: "stopped", executionCount: 0 }
}

export function interruptKernel(projectRoot: string, sessionId: string, language: KernelLanguage): KernelStatusResult {
  return interruptKernelByKey(key(projectRoot, sessionId, language))
}

export function shutdownKernel(projectRoot: string, sessionId: string, language: KernelLanguage): KernelStatusResult {
  return interruptKernelByKey(key(projectRoot, sessionId, language))
}
