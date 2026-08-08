import assert from "node:assert/strict"
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createJiti } from "jiti"
import { gzipSync } from "node:zlib"

const jiti = createJiti(import.meta.url)
const { ScienceFile } = await jiti.import("../src/files.ts")

test("magic bytes override a misleading scientific extension", () => {
  const head = Uint8Array.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a])
  const result = ScienceFile.detect({ name: "results.pdf", size: 1024, head })

  assert.equal(result.format, "hdf5")
  assert.equal(result.evidence, "magic")
  assert.match(result.warnings.join("\n"), /overrides extension \.pdf/)
})

test("large text science files degrade to bounded preview", () => {
  const result = ScienceFile.detect({
    name: "cohort.fasta",
    size: ScienceFile.Budget.FULL_READ_BYTES + 1,
    head: new TextEncoder().encode(">sample\nACTG\n"),
  })

  assert.equal(result.capability, "sequence")
  assert.equal(result.readPolicy, "bounded-preview")
})

test("unknown NUL-bearing data fails closed as binary metadata", () => {
  const result = ScienceFile.detect({ name: "sample.data", size: 12, head: Uint8Array.from([65, 0, 66]) })

  assert.equal(result.mode, "binary")
  assert.equal(result.readPolicy, "metadata-only")
})

test("inspect reads a bounded preview inside the allowed root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "medpi-science-file-"))
  const body = `>sample\n${"ACTG".repeat(80_000)}\n`
  await writeFile(path.join(root, "large.fa"), body)

  const result = await ScienceFile.inspect({ root, path: "large.fa" })

  assert.equal(result.mode, "text")
  assert.equal(result.format, "fasta")
  assert.equal(result.truncated, true)
  assert.ok(result.contentBytes <= ScienceFile.Budget.PREVIEW_BYTES)
})

test("multibyte previews stay within the encoded byte budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "medpi-science-utf8-"))
  await writeFile(path.join(root, "large.csv"), "界".repeat(100_000))

  const result = await ScienceFile.preview({ root, path: "large.csv" })

  assert.equal(result.mode, "text")
  assert.ok(result.contentBytes <= ScienceFile.Budget.PREVIEW_BYTES)
})

test("compressed previews stop at the decompressed byte budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "medpi-science-gzip-"))
  const body = `>sample\n${"ACTG".repeat(200_000)}\n`
  await writeFile(path.join(root, "large.fa.gz"), gzipSync(body))

  const result = await ScienceFile.preview({ root, path: "large.fa.gz" })

  assert.equal(result.mode, "text")
  assert.equal(result.format, "fasta")
  assert.equal(result.truncated, true)
  assert.ok(result.contentBytes <= ScienceFile.Budget.PREVIEW_BYTES)
})

test("inspect rejects parent traversal outside the allowed root", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "medpi-science-traversal-"))
  const root = path.join(parent, "project")
  await mkdir(root)
  await writeFile(path.join(parent, "outside.fa"), ">outside\nACTG\n")

  await assert.rejects(
    ScienceFile.inspect({ root, path: "../outside.fa" }),
    /outside the allowed root/,
  )
})

test("inspect rejects symlinks escaping the allowed root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "medpi-science-root-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "medpi-science-outside-"))
  await mkdir(path.join(root, "data"))
  await writeFile(path.join(outside, "secret.fa"), ">secret\nACTG\n")
  await symlink(path.join(outside, "secret.fa"), path.join(root, "data", "escape.fa"))

  await assert.rejects(
    ScienceFile.inspect({ root, path: "data/escape.fa" }),
    /outside the allowed root/,
  )
})
