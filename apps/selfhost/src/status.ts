/**
 * NevrLabs selfhost (PATCHES #9): the status Worker as a Bun process.
 *
 * Runs `apps/status`'s unmodified request handler over Postgres storage (status-store.ts) instead of
 * Workers KV/R2/Cache. Caddy routes `/s/*` here, so a page is served same-origin at
 * `https://<maple host>/s/<slug>` (behind whatever guards that host: CF Access on the public name).
 *
 * Fork-only file. Upstream files are not edited.
 */
import { Effect } from "effect"
import { handleRequest } from "../../status/src/handler"
import type { CachedValue, StatusStorage } from "../../status/src/ports"
import { StatusStorageError } from "../../status/src/ports"
import { ensureStatusSchema, statusDb, statusGet, statusList, statusPut } from "./status-store"

const url = process.env.MAPLE_PG_URL
if (!url) throw new Error("status: MAPLE_PG_URL is required")
const db = statusDb(url)
await ensureStatusSchema(db)

const call = <A>(store: StatusStorageError["store"], key: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => new StatusStorageError({ message: `${store} call failed`, store, key, cause }),
	})

/** Stand-in for the colo cache: bounded, process-local. */
const CACHE_MAX = 500
const cache = new Map<string, CachedValue>()

/** Break-glass form limiter: 10 per minute per key, as the Worker's binding. */
const windows = new Map<string, { start: number; count: number }>()

const storage: StatusStorage = {
	kvGet: (key) => call("kv", key, () => statusGet(db, "kv", key)),
	kvPut: (key, value) => call("kv", key, () => statusPut(db, "kv", key, value)),
	kvList: (prefix, limit) =>
		call("kv", prefix, () => statusList(db, prefix, limit)).pipe(
			Effect.map((page) => page.keys.map((k) => k.name)),
		),
	r2Get: (key) => call("r2", key, () => statusGet(db, "r2", key)),
	cacheGet: (key) => Effect.sync(() => cache.get(key) ?? null),
	cachePut: (key, entry) =>
		Effect.sync(() => {
			if (cache.size >= CACHE_MAX && !cache.has(key)) cache.delete(cache.keys().next().value as string)
			cache.set(key, entry)
		}),
	rateLimit: (key) =>
		Effect.sync(() => {
			const now = Date.now()
			const w = windows.get(key)
			if (!w || now - w.start >= 60_000) {
				windows.set(key, { start: now, count: 1 })
				return true
			}
			w.count += 1
			return w.count <= 10
		}),
}

const port = Number(process.env.PORT ?? 3478)
Bun.serve({
	port,
	hostname: "0.0.0.0",
	async fetch(request) {
		// Workers see cf-connecting-ip; behind Caddy the client is in x-forwarded-for.
		const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
		const headers = new Headers(request.headers)
		if (ip && !headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", ip)
		const forwarded = new Request(request, { headers })
		return Effect.runPromise(
			handleRequest(forwarded, { storage, nowMs: Date.now(), randomId: () => crypto.randomUUID() }),
		)
	},
})
console.log(`maple-status (selfhost) listening on :${port}`)
