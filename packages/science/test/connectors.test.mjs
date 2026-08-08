import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { createJiti } from "jiti"

const jiti = createJiti(import.meta.url)
const { registry } = await jiti.import("../src/connectors/index.ts")
const { createHttpClient, orNotFound } = await jiti.import("../src/connectors/http.ts")

test("ships one bounded connector set spanning the initial science domains", () => {
  assert.deepEqual(
    registry.catalog().map((entry) => entry.id).sort(),
    ["arxiv", "crossref", "ensembl", "geo", "pubchem", "pubmed", "reactome", "uniprot"],
  )
})

test("HTTP client uses an explicit host allow-list and real local transport", async (context) => {
  let calls = 0
  const server = createServer((request, response) => {
    calls++
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ path: request.url }))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  context.after(() => server.close())

  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const host = `127.0.0.1:${address.port}`
  const client = createHttpClient({ allowedHosts: [host], retries: 0 })
  const url = `http://${host}/record`

  assert.deepEqual(await client.getJSON(url), { path: "/record" })
  assert.deepEqual(await client.getJSON(url), { path: "/record" })
  assert.equal(calls, 1)
  await assert.rejects(client.getText("https://example.com/blocked"), /not in the science allow-list/)
})

test("HTTP cache separates representations by Accept header", async (context) => {
  const server = createServer((request, response) => {
    const accept = request.headers.accept
    response.end(accept === "application/json" ? JSON.stringify({ kind: "json" }) : "plain")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  context.after(() => server.close())

  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const host = `127.0.0.1:${address.port}`
  const client = createHttpClient({ allowedHosts: [host], retries: 0 })
  const url = `http://${host}/representation`

  assert.equal(await client.getText(url), "plain")
  assert.deepEqual(await client.getJSON(url), { kind: "json" })
})

test("HTTP redirects cannot escape the declared source host", async (context) => {
  let targetCalls = 0
  const target = createServer((_request, response) => {
    targetCalls++
    response.end("internal")
  })
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve))
  context.after(() => target.close())
  const targetAddress = target.address()
  assert.ok(targetAddress && typeof targetAddress !== "string")

  const source = createServer((_request, response) => {
    response.statusCode = 302
    response.setHeader("location", `http://127.0.0.1:${targetAddress.port}/private`)
    response.end()
  })
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve))
  context.after(() => source.close())
  const sourceAddress = source.address()
  assert.ok(sourceAddress && typeof sourceAddress !== "string")

  const host = `127.0.0.1:${sourceAddress.port}`
  const client = createHttpClient({ allowedHosts: [host], retries: 0 })
  await assert.rejects(client.getText(`http://${host}/redirect`))
  assert.equal(targetCalls, 0)
})

test("HTTP response bodies stop at the configured byte budget", async (context) => {
  const server = createServer((_request, response) => response.end("x".repeat(2048)))
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  context.after(() => server.close())

  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const host = `127.0.0.1:${address.port}`
  const client = createHttpClient({ allowedHosts: [host], retries: 0, maxBytes: 1024 })

  await assert.rejects(client.getText(`http://${host}/large`), /exceeds 1024 bytes/)
})

test("connectors only convert an explicit not-found response into an empty result", async (context) => {
  const server = createServer((request, response) => {
    response.statusCode = request.url === "/missing" ? 404 : 503
    response.end("source unavailable")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  context.after(() => server.close())

  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const host = `127.0.0.1:${address.port}`
  const client = createHttpClient({ allowedHosts: [host], retries: 0 })

  assert.deepEqual(
    await orNotFound(client.getJSON(`http://${host}/missing`), { found: false }),
    { found: false },
  )
  await assert.rejects(
    orNotFound(client.getJSON(`http://${host}/unavailable`), { found: false }),
    /HTTP 503/,
  )
})

test("HTTP cancellation interrupts a queued source-rate-limit wait", async (context) => {
  let calls = 0
  const server = createServer((_request, response) => {
    calls++
    response.end("ok")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  context.after(() => server.close())

  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const host = `127.0.0.1:${address.port}`
  const client = createHttpClient({ allowedHosts: [host], retries: 0 })
  const rateLimit = { minIntervalMs: 500 }
  await client.getText(`http://${host}/first`, { rateLimit })

  const controller = new AbortController()
  const start = performance.now()
  const request = client.getText(`http://${host}/second`, { rateLimit, signal: controller.signal })
  controller.abort()

  await assert.rejects(request)
  assert.ok(performance.now() - start < 200)
  assert.equal(calls, 1)
})

test("HTTP cancellation removes a queued concurrency waiter", async (context) => {
  let calls = 0
  let release
  let started
  const gate = new Promise((resolve) => { release = resolve })
  const seen = new Promise((resolve) => { started = resolve })
  const server = createServer(async (_request, response) => {
    calls++
    if (calls === 1) {
      started()
      await gate
    }
    response.end("ok")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  context.after(() => server.close())

  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const host = `127.0.0.1:${address.port}`
  const client = createHttpClient({ allowedHosts: [host], retries: 0 })
  const rateLimit = { maxConcurrent: 1 }
  const first = client.getText(`http://${host}/first`, { rateLimit })
  await seen

  const controller = new AbortController()
  const queued = client.getText(`http://${host}/queued`, { rateLimit, signal: controller.signal })
  controller.abort()
  await assert.rejects(queued)

  release()
  assert.equal(await first, "ok")
  assert.equal(await client.getText(`http://${host}/third`, { rateLimit }), "ok")
  assert.equal(calls, 2)
})

test("HTTP timeout bounds the whole retry budget", async (context) => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end("late"), 500)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  context.after(() => server.close())

  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const host = `127.0.0.1:${address.port}`
  const client = createHttpClient({ allowedHosts: [host], timeoutMs: 50, retries: 2 })
  const start = performance.now()

  await assert.rejects(client.getText(`http://${host}/slow`))
  assert.ok(performance.now() - start < 300)
})

test("HTTP cancellation is not converted into an empty science result", async (context) => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end("late"), 500)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  context.after(() => server.close())

  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const host = `127.0.0.1:${address.port}`
  const client = createHttpClient({ allowedHosts: [host], retries: 0 })
  const controller = new AbortController()
  const request = client.getText(`http://${host}/slow`, { signal: controller.signal })
  controller.abort()

  await assert.rejects(request)
})
