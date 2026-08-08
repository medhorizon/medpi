// Adapted from MedHorizon v0.3.21 science/connectors/http.ts (Apache-2.0).
// The MedHorizon settings dependency is replaced by an exact source-host allow-list,
// and response bodies are bounded before parsing or caching.
import type { RateLimit } from "./types"

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 2
const DEFAULT_CACHE_TTL_MS = 5 * 60_000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const MAX_CACHE_ENTRIES = 64
const MAX_CACHE_ENTRY_BYTES = 256 * 1024
const USER_AGENT = "medpi-science/0.1"

export const NCBI_RATE_LIMIT = { minIntervalMs: 350, maxConcurrent: 1 } satisfies RateLimit

export const SCIENCE_HOSTS = [
  "api.crossref.org",
  "eutils.ncbi.nlm.nih.gov",
  "export.arxiv.org",
  "pubchem.ncbi.nlm.nih.gov",
  "reactome.org",
  "rest.ensembl.org",
  "rest.uniprot.org",
] as const

interface HttpOptions {
  accept?: string
  timeoutMs?: number
  retries?: number
  signal?: AbortSignal
  cacheTtlMs?: number
  maxBytes?: number
  rateLimit?: RateLimit
  looksValid?: (body: string) => boolean
}

interface CacheEntry {
  expiresAt: number
  body: string
}

type ScienceResponse = {
  text(): string
  json<T = unknown>(): T
}

class ScienceHttpError extends Error {
  readonly status?: number
  readonly code: "HOST_DENIED" | "HTTP_ERROR" | "BODY_TOO_LARGE" | "INVALID_JSON"

  constructor(
    code: ScienceHttpError["code"],
    message: string,
    status?: number,
  ) {
    super(message)
    this.name = "ScienceHttpError"
    this.code = code
    this.status = status
  }
}

function isLoopback(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]"
}

function toResponse(entry: Omit<CacheEntry, "expiresAt">): ScienceResponse {
  return {
    text: () => entry.body,
    json: <T = unknown>() => {
      try {
        return JSON.parse(entry.body) as T
      } catch {
        throw new ScienceHttpError("INVALID_JSON", "Scientific source returned invalid JSON")
      }
    },
  }
}

function retryable(status: number) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

function retryDelay(response: Response | undefined, attempt: number) {
  const value = response?.headers.get("retry-after")
  if (value) {
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  }
  return Math.min(500 * 2 ** attempt, 8_000)
}

function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted"))
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(signal?.reason ?? new Error("Request aborted"))
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

async function boundedBody(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new ScienceHttpError("BODY_TOO_LARGE", `Scientific response exceeds ${maxBytes} bytes`, response.status)
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const state = { total: 0 }
  while (true) {
    const next = await reader.read()
    if (next.done) break
    state.total += next.value.byteLength
    if (state.total > maxBytes) {
      await reader.cancel()
      throw new ScienceHttpError("BODY_TOO_LARGE", `Scientific response exceeds ${maxBytes} bytes`, response.status)
    }
    chunks.push(next.value)
  }

  const body = new Uint8Array(state.total)
  const offset = { value: 0 }
  for (const chunk of chunks) {
    body.set(chunk, offset.value)
    offset.value += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

export function createHttpClient(input: {
  allowedHosts: Iterable<string>
  retries?: number
  timeoutMs?: number
  maxBytes?: number
}) {
  const hosts = new Set(input.allowedHosts)
  const cache = new Map<string, CacheEntry>()
  const pace = new Map<string, number>()
  const active = new Map<string, number>()
  const waiters = new Map<string, Array<() => void>>()

  function assertAllowed(value: string) {
    const url = new URL(value)
    if (!hosts.has(url.host)) {
      throw new ScienceHttpError("HOST_DENIED", `${url.host} is not in the science allow-list`)
    }
    if (url.protocol === "https:") return url
    if (url.protocol === "http:" && isLoopback(url.hostname)) return url
    throw new ScienceHttpError("HOST_DENIED", `Insecure science URL is not allowed: ${url.origin}`)
  }

  function waitForStart(host: string, interval: number, signal: AbortSignal) {
    const now = Date.now()
    const start = Math.max(now, pace.get(host) ?? now)
    pace.set(host, start + interval)
    return sleep(start - now, signal)
  }

  function acquire(host: string, cap: number, signal: AbortSignal): Promise<void> {
    const count = active.get(host) ?? 0
    if (count < cap) {
      active.set(host, count + 1)
      return Promise.resolve()
    }
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted"))
    return new Promise((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener("abort", abort)
        resolve()
      }
      const abort = () => {
        const queue = waiters.get(host)
        const index = queue?.indexOf(ready) ?? -1
        if (index >= 0) queue?.splice(index, 1)
        signal.removeEventListener("abort", abort)
        reject(signal.reason ?? new Error("Request aborted"))
      }
      const queue = waiters.get(host) ?? []
      queue.push(ready)
      waiters.set(host, queue)
      signal.addEventListener("abort", abort, { once: true })
    })
  }

  function release(host: string) {
    const next = waiters.get(host)?.shift()
    if (next) return next()
    active.set(host, Math.max(0, (active.get(host) ?? 1) - 1))
  }

  async function throttle(url: URL, limit: RateLimit | undefined, signal: AbortSignal) {
    if (!limit) return () => undefined
    if (limit.minIntervalMs && limit.minIntervalMs > 0) await waitForStart(url.host, limit.minIntervalMs, signal)
    if (!limit.maxConcurrent || limit.maxConcurrent < 1) return () => undefined
    await acquire(url.host, limit.maxConcurrent, signal)
    return () => release(url.host)
  }

  async function request(urlValue: string, options: HttpOptions = {}): Promise<ScienceResponse> {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Request aborted")
    const url = assertAllowed(urlValue)
    const headers = new Headers({
      accept: options.accept ?? "*/*",
      "user-agent": USER_AGENT,
    })
    const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    const cacheKey = ttl > 0 ? `${url.href} accept:${headers.get("accept")}` : undefined
    const hit = cacheKey ? cache.get(cacheKey) : undefined
    if (hit && hit.expiresAt > Date.now()) return toResponse(hit)
    if (cacheKey && hit) cache.delete(cacheKey)

    const retries = options.retries ?? input.retries ?? DEFAULT_RETRIES
    const timeoutMs = options.timeoutMs ?? input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBytes = options.maxBytes ?? input.maxBytes ?? DEFAULT_MAX_BYTES
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
    const done = await throttle(url, options.rateLimit, signal)

    async function attempt(index: number): Promise<ScienceResponse> {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers,
          // Redirects are terminal: following them would bypass the exact source-host allow-list.
          redirect: "error",
          signal,
        })
        const body = await boundedBody(response, maxBytes)
        if (!response.ok && retryable(response.status) && index < retries) {
          await sleep(retryDelay(response, index), signal)
          return attempt(index + 1)
        }
        if (!response.ok) {
          throw new ScienceHttpError(
            "HTTP_ERROR",
            `HTTP ${response.status} for ${url.href}: ${body.slice(0, 500) || response.statusText}`,
            response.status,
          )
        }

        const entry: CacheEntry = {
          expiresAt: Date.now() + ttl,
          body,
        }
        const valid = body.trim().length > 0 && (options.looksValid?.(body) ?? true)
        const cacheable = valid && Buffer.byteLength(body, "utf8") <= MAX_CACHE_ENTRY_BYTES
        if (cacheKey && cacheable) {
          const oldest = cache.size >= MAX_CACHE_ENTRIES ? cache.keys().next().value : undefined
          if (oldest) cache.delete(oldest)
          cache.set(cacheKey, entry)
        }
        return toResponse(entry)
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof ScienceHttpError) throw error
        if (index >= retries) throw error
        await sleep(retryDelay(undefined, index), signal)
        return attempt(index + 1)
      }
    }

    return attempt(0).finally(done)
  }

  async function getJSON<T = unknown>(url: string, options: HttpOptions = {}) {
    return (await request(url, { ...options, accept: "application/json" })).json<T>()
  }

  async function getText(url: string, options?: HttpOptions) {
    return (await request(url, options)).text()
  }

  return {
    getJSON,
    getText,
  }
}

const client = createHttpClient({ allowedHosts: SCIENCE_HOSTS })

export const getJSON = client.getJSON
export const getText = client.getText

export async function orNotFound<T>(promise: Promise<T>, fallback: T, signal?: AbortSignal): Promise<T> {
  try {
    return await promise
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof ScienceHttpError && error.status === 404) return fallback
    throw error
  }
}
