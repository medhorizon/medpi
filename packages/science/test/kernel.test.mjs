import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createJiti } from "jiti"

const jiti = createJiti(import.meta.url)
const { executeKernel, interruptKernel, kernelStatus, shutdownKernel } = await jiti.import("../src/kernel/index.ts")
const { NoneSandbox } = await jiti.import("../src/sandbox/index.ts")
const { ProvenanceStore } = await jiti.import("../src/provenance.ts")

const PYTHON = "/usr/bin/python3"
const R = "/home/wei/miniforge3/envs/rnaseq/bin/R"

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "medpi-kernel-"))
  execFileSync("git", ["init"], { cwd: root })
  execFileSync("git", ["config", "user.email", "medpi@test.local"], { cwd: root })
  execFileSync("git", ["config", "user.name", "MedPi Test"], { cwd: root })
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root })
  return root
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(read) {
  for (let index = 0; index < 60; index++) {
    try {
      const value = await read()
      if (value) return value
    } catch {
      // cell has not created its marker yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("timed out waiting for kernel marker")
}

test("python kernel retains state, logs bounded output, and records code hash provenance", async () => {
  const root = await project()
  const previous = process.env.MEDPI_PYTHON
  process.env.MEDPI_PYTHON = PYTHON
  try {
    const provenance = new ProvenanceStore(path.join(root, ".medpi", "provenance.json"))
    const first = await executeKernel({
      projectRoot: root,
      sessionId: "python-session",
      language: "python",
      code: "value = 41\nprint('saved')",
      sandbox: new NoneSandbox(),
      provenance,
    })
    const second = await executeKernel({
      projectRoot: root,
      sessionId: "python-session",
      language: "python",
      code: "value + 1",
      sandbox: new NoneSandbox(),
      provenance,
    })
    assert.equal(first.status, "ok")
    assert.equal(second.status, "ok")
    assert.equal(second.executionCount, 2)
    assert.equal(second.value, "42")
    assert.match(await readFile(path.join(second.runDir, "stdout.log"), "utf8"), /saved/)
    assert.match(await readFile(path.join(second.runDir, "result.jsonl"), "utf8"), /"status":"ok"/)
    const node = await provenance.get(second.runNodeId)
    assert.equal(node?.kind, "run")
    assert.equal(typeof node?.inputs?.codeHash, "string")
    assert.equal("code" in (node?.inputs ?? {}), false)
    assert.equal(kernelStatus(root, "python-session", "python").status, "running")
    assert.equal(shutdownKernel(root, "python-session", "python").status, "stopped")
  } finally {
    if (previous === undefined) delete process.env.MEDPI_PYTHON
    else process.env.MEDPI_PYTHON = previous
    await rm(root, { recursive: true, force: true })
  }
})

test("kernel truncates oversized output and stays usable", async () => {
  const root = await project()
  const previous = process.env.MEDPI_PYTHON
  process.env.MEDPI_PYTHON = PYTHON
  try {
    const provenance = new ProvenanceStore(path.join(root, ".medpi", "provenance.json"))
    const oversized = await executeKernel({
      projectRoot: root,
      sessionId: "bounded-session",
      language: "python",
      code: "print('x' * 70000)",
      sandbox: new NoneSandbox(),
      provenance,
    })
    assert.equal(oversized.status, "ok")
    assert.ok(Buffer.byteLength(oversized.stdout, "utf8") <= 64 * 1024)
    assert.match(oversized.stdout, /\.\.\. \(truncated\)$/)

    const next = await executeKernel({ projectRoot: root, sessionId: "bounded-session", language: "python", code: "1 + 1", sandbox: new NoneSandbox(), provenance })
    assert.equal(next.status, "ok")
    assert.equal(next.value, "2")
    shutdownKernel(root, "bounded-session", "python")
  } finally {
    if (previous === undefined) delete process.env.MEDPI_PYTHON
    else process.env.MEDPI_PYTHON = previous
    await rm(root, { recursive: true, force: true })
  }
})

test("R kernel retains state with the configured local runtime", async () => {
  const root = await project()
  const previous = process.env.MEDPI_R
  process.env.MEDPI_R = R
  try {
    const provenance = new ProvenanceStore(path.join(root, ".medpi", "provenance.json"))
    const first = await executeKernel({
      projectRoot: root,
      sessionId: "r-session",
      language: "r",
      code: "value <- 40",
      sandbox: new NoneSandbox(),
      provenance,
    })
    const second = await executeKernel({
      projectRoot: root,
      sessionId: "r-session",
      language: "r",
      code: "label <- '\u00e9'\nvalue + 2",
      sandbox: new NoneSandbox(),
      provenance,
    })
    assert.equal(first.status, "ok", first.stderr)
    assert.equal(second.status, "ok")
    assert.match(second.value, /42/)
    shutdownKernel(root, "r-session", "r")
    assert.equal(second.stderr, "")

  } finally {
    if (previous === undefined) delete process.env.MEDPI_R
    else process.env.MEDPI_R = previous
    await rm(root, { recursive: true, force: true })

  }
})

test("session-wide kernel shutdown removes every language kernel", async () => {
  const root = await project()
  const previous = process.env.MEDPI_PYTHON
  process.env.MEDPI_PYTHON = PYTHON
  try {
    const provenance = new ProvenanceStore(path.join(root, ".medpi", "provenance.json"))
    await executeKernel({ projectRoot: root, sessionId: "close-session", language: "python", code: "1", sandbox: new NoneSandbox(), provenance })
    const { shutdownSessionKernels } = await jiti.import("../src/kernel/index.ts")
    shutdownSessionKernels(root, "close-session")
    assert.equal(kernelStatus(root, "close-session", "python").status, "stopped")
  } finally {
    if (previous === undefined) delete process.env.MEDPI_PYTHON
    else process.env.MEDPI_PYTHON = previous
    await rm(root, { recursive: true, force: true })
  }
})
test("kernel abort kills its detached process group and leaves no child", async () => {

  const root = await project()
  const marker = path.join(root, "child.pid")
  const previous = process.env.MEDPI_PYTHON
  process.env.MEDPI_PYTHON = PYTHON
  try {
    const provenance = new ProvenanceStore(path.join(root, ".medpi", "provenance.json"))
    const controller = new AbortController()
    const pending = executeKernel({
      projectRoot: root,
      sessionId: "abort-session",
      language: "python",
      code: `import subprocess, time\nchild = subprocess.Popen(['sleep', '120'])\nopen(${JSON.stringify(marker)}, 'w').write(str(child.pid))\ntime.sleep(120)`,
      sandbox: new NoneSandbox(),
      provenance,
      signal: controller.signal,
    })
    const childPid = Number(await waitFor(async () => (await readFile(marker, "utf8")).trim()))
    controller.abort()
    const result = await pending
    assert.equal(result.status, "cancelled")
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(alive(childPid), false)
    assert.equal(kernelStatus(root, "abort-session", "python").status, "stopped")
    assert.equal(interruptKernel(root, "abort-session", "python").status, "stopped")
  } finally {
    if (previous === undefined) delete process.env.MEDPI_PYTHON
    else process.env.MEDPI_PYTHON = previous
    await rm(root, { recursive: true, force: true })
  }
})
