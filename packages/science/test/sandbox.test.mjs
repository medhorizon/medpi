import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createJiti } from "jiti"

const jiti = createJiti(import.meta.url)
const {
  NoneSandbox,
  BwrapSandbox,
  prepareRunDir,
  cleanupRunDir,
  runSandboxed,
  createCheckpoint,
  rollbackToCheckpoint,
  PermissionOwner,
} = await jiti.import("../src/sandbox/index.ts")
const { ProvenanceStore } = await jiti.import("../src/provenance.ts")
const { spawnSync } = await import("node:child_process")

function bwrapAvailable() {
  const probe = spawnSync(
    "bwrap",
    ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent", "true"],
    { encoding: "utf8" },
  )
  return probe.status === 0
}

async function tempProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "medpi-sandbox-"))
  await mkdir(path.join(root, ".medpi"), { recursive: true })
  return root
}

async function gitProject() {
  const root = await tempProject()
  execFileSync("git", ["init"], { cwd: root })
  execFileSync("git", ["config", "user.email", "medpi@test.local"], { cwd: root })
  execFileSync("git", ["config", "user.name", "MedPi Test"], { cwd: root })
  await writeFile(path.join(root, "tracked.txt"), "before\n")
  execFileSync("git", ["add", "-A"], { cwd: root })
  execFileSync("git", ["commit", "-m", "init"], { cwd: root })
  return root
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("none sandbox runs python and can write the project directory", async () => {
  const projectRoot = await tempProject()
  const runDir = await prepareRunDir(projectRoot)
  const marker = path.join(projectRoot, "out.txt")
  const sandbox = new NoneSandbox()

  const result = await sandbox.run({
    projectRoot,
    runDir,
    command: ["python3", "-c", `open(${JSON.stringify(marker)}, "w").write("ok")`],
  })

  assert.equal(result.status, "ok")
  assert.equal(result.exitCode, 0)
  assert.equal(await readFile(marker, "utf8"), "ok")
  await cleanupRunDir(runDir)
  await rm(projectRoot, { recursive: true, force: true })
})

test("abort kills the process group with no leftover children", async () => {
  const projectRoot = await tempProject()
  const runDir = await prepareRunDir(projectRoot)
  const sandbox = new NoneSandbox()
  const controller = new AbortController()
  const childMarker = path.join(runDir, "child.pid")

  const pending = sandbox.run({
    projectRoot,
    runDir,
    command: [
      "python3",
      "-c",
      "import os, subprocess, time, signal\n" +
        "signal.signal(signal.SIGINT, signal.SIG_IGN)\n" +
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n" +
        "child = subprocess.Popen(['sleep', '120'])\n" +
        `open(${JSON.stringify(childMarker)}, 'w').write(str(child.pid))\n` +
        "while True:\n" +
        "  time.sleep(0.2)\n",
    ],
    signal: controller.signal,
  })

  let nestedPid = ""
  for (let i = 0; i < 50; i++) {
    try {
      nestedPid = (await readFile(childMarker, "utf8")).trim()
      if (nestedPid) break
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(nestedPid, "nested child pid should be recorded")
  controller.abort()
  const result = await pending

  assert.equal(result.status, "cancelled")
  assert.equal(processAlive(result.pid), false)
  assert.equal(processAlive(Number(nestedPid)), false)

  await cleanupRunDir(runDir)
  await rm(projectRoot, { recursive: true, force: true })
})

test("cleanupRunDir removes the isolated run directory", async () => {
  const projectRoot = await tempProject()
  const runDir = await prepareRunDir(projectRoot)
  await writeFile(path.join(runDir, "tmp.bin"), "x")
  await cleanupRunDir(runDir)
  await assert.rejects(() => readFile(path.join(runDir, "tmp.bin")), /ENOENT/)
  await rm(projectRoot, { recursive: true, force: true })
})

test("runSandboxed streams output to logs and records a provenance run node", async () => {
  const projectRoot = await tempProject()
  const provenance = new ProvenanceStore(path.join(projectRoot, ".medpi", "provenance.json"))

  const outcome = await runSandboxed({
    projectRoot,
    command: ["python3", "-c", "import sys; print('hello-out'); print('hello-err', file=sys.stderr)"],
    provenance,
    sandbox: new NoneSandbox(),
  })

  assert.equal(outcome.result.status, "ok")
  assert.equal(await readFile(outcome.stdoutLog, "utf8"), "hello-out\n")
  assert.equal(await readFile(outcome.stderrLog, "utf8"), "hello-err\n")

  const node = await provenance.get(outcome.runNodeId)
  assert.ok(node)
  assert.equal(node.kind, "run")
  assert.equal(node.status, "ok")
  assert.equal(node.tool, "science_run")
  assert.deepEqual(node.inputs?.command, [
    "python3",
    "-c",
    "import sys; print('hello-out'); print('hello-err', file=sys.stderr)",
  ])
  assert.equal(node.meta?.startedAt, outcome.result.startedAt)
  assert.equal(node.meta?.endedAt, outcome.result.endedAt)

  await cleanupRunDir(outcome.runDir)
  await rm(projectRoot, { recursive: true, force: true })
})

test("runSandboxed records cancelled status when aborted", async () => {
  const projectRoot = await tempProject()
  const provenance = new ProvenanceStore(path.join(projectRoot, ".medpi", "provenance.json"))
  const controller = new AbortController()

  const pending = runSandboxed({
    projectRoot,
    command: ["python3", "-c", "import time\nwhile True: time.sleep(0.2)"],
    provenance,
    sandbox: new NoneSandbox(),
    signal: controller.signal,
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  controller.abort()
  const outcome = await pending

  assert.equal(outcome.result.status, "cancelled")
  const node = await provenance.get(outcome.runNodeId)
  assert.equal(node?.status, "cancelled")

  await cleanupRunDir(outcome.runDir)
  await rm(projectRoot, { recursive: true, force: true })
})

test("rollback restores tracked files and clears the isolated run directory", async () => {
  const projectRoot = await gitProject()
  const checkpoint = await createCheckpoint(projectRoot, "pre-run")
  assert.ok(checkpoint.sha)

  const runDir = await prepareRunDir(projectRoot)
  await writeFile(path.join(projectRoot, "tracked.txt"), "mutated\n")
  await writeFile(path.join(runDir, "artifact.bin"), "tmp")
  await rm(path.join(projectRoot, "tracked.txt"))

  await rollbackToCheckpoint({ projectRoot, sha: checkpoint.sha, runDir })

  assert.equal(await readFile(path.join(projectRoot, "tracked.txt"), "utf8"), "before\n")
  await assert.rejects(() => readFile(path.join(runDir, "artifact.bin")), /ENOENT/)
  await rm(projectRoot, { recursive: true, force: true })
})

test("runSandboxed can create a checkpoint before execution", async () => {
  const projectRoot = await gitProject()
  const provenance = new ProvenanceStore(path.join(projectRoot, ".medpi", "provenance.json"))

  const outcome = await runSandboxed({
    projectRoot,
    command: ["python3", "-c", 'open("tracked.txt","w").write("from-run\\n")'],
    provenance,
    sandbox: new NoneSandbox(),
    checkpoint: true,
  })

  assert.ok(outcome.checkpointSha)
  assert.equal(await readFile(path.join(projectRoot, "tracked.txt"), "utf8"), "from-run\n")

  await rollbackToCheckpoint({
    projectRoot,
    sha: outcome.checkpointSha,
    runDir: outcome.runDir,
  })
  assert.equal(await readFile(path.join(projectRoot, "tracked.txt"), "utf8"), "before\n")
  await rm(projectRoot, { recursive: true, force: true })
})

test("permission owner auto-allows by default and can require confirmation", async () => {
  const auto = new PermissionOwner("auto")
  assert.deepEqual(await auto.authorize({ command: ["python3", "-c", "pass"] }), {
    allowed: true,
    mode: "auto",
  })

  const confirm = new PermissionOwner("confirm")
  const denied = await confirm.authorize({
    command: ["python3", "-c", "pass"],
    ask: async () => false,
  })
  assert.deepEqual(denied, { allowed: false, mode: "confirm" })

  const allowed = await confirm.authorize({
    command: ["python3", "-c", "pass"],
    ask: async () => true,
  })
  assert.deepEqual(allowed, { allowed: true, mode: "confirm" })
})
test("bwrap sandbox writes project dir and rejects writes outside it", async (t) => {
  if (!bwrapAvailable()) {
    t.skip("bwrap unavailable (install bwrap or unlock unprivileged userns)")
    return
  }

  const projectRoot = await tempProject()
  const runDir = await prepareRunDir(projectRoot)
  const outside = await mkdtemp(path.join(os.tmpdir(), "medpi-outside-"))
  const sandbox = new BwrapSandbox()

  const inside = path.join(projectRoot, "inside.txt")
  const ok = await sandbox.run({
    projectRoot,
    runDir,
    command: ["python3", "-c", `open(${JSON.stringify(inside)}, "w").write("in")`],
  })
  assert.equal(ok.status, "ok")
  assert.equal(await readFile(inside, "utf8"), "in")

  const outsideFile = path.join(outside, "nope.txt")
  const denied = await sandbox.run({
    projectRoot,
    runDir,
    command: ["python3", "-c", `open(${JSON.stringify(outsideFile)}, "w").write("x")`],
  })
  assert.equal(denied.status, "error")
  await assert.rejects(() => readFile(outsideFile), /ENOENT/)

  await cleanupRunDir(runDir)
  await rm(projectRoot, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})
