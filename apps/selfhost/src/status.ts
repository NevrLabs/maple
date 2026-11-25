/**
 * NevrLabs selfhost (PATCHES #9): the status Worker as a Bun process.
 *
 * Runs `apps/status`'s unmodified request handler over Postgres storage (status-store.ts) instead of
 * Workers KV/R2/Cache. Caddy routes `/s/*` here, so a page is served same-origin at
 * `https://<maple host>/s/<org key>/<slug>` (behind whatever guards that host: CF Access on the public name).
 */
import { Effect } from "effect"
import { handleRequest } from "../../status/src/handler"
import { bunOgImage } from "../../status/src/og-image.bun"
import type { CachedValue, StatusStorage } from "../../status/src/ports"
import { StatusStorageError } from "../../status/src/ports"
import { ensureStatusSchema, statusDb, statusGet, statusList, statusPut } from "./status-store"

const call = <A>(store: StatusStorageError["store"], key: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => new StatusStorageError({ message: `${store} call failed`, store, key, cause }),
	})

/** Stand-in for the colo cache: bounded, process-local. */
const CACHE_MAX = 500
const cache = new Map<string, CachedValue>()

/** Process-local limits matching the Worker's per-client and per-page budgets. */
const rateLimiter = (limit: number) => {
	const windows = new Map<string, { start: number; count: number }>()
	let sweepAt = 0
	return (key: string) =>
		Effect.sync(() => {
			const now = Date.now()
			if (now >= sweepAt) {
				for (const [expiredKey, window] of windows) {
					if (now - window.start >= 60_000) windows.delete(expiredKey)
				}
				sweepAt = now + 60_000
			}
			const window = windows.get(key)
			if (window && now - window.start < 60_000) return ++window.count <= limit
			if (!window && windows.size >= 10_000) return false
			windows.set(key, { start: now, count: 1 })
			return true
		})
}

type StatusStore = Omit<StatusStorage, "rateLimit" | "pageRateLimit">

const pgStorage = (db: ReturnType<typeof statusDb>): StatusStore => ({
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
})

export const makeStatusFetch = (store: StatusStore, sharedOrigins: string) => {
	const hosts = new Set(
		sharedOrigins
			.split(",")
			.map((origin) => origin.trim())
			.filter(Boolean)
			.map((origin) => new URL(origin).hostname),
	)
	const storage: StatusStorage = { ...store, rateLimit: rateLimiter(10), pageRateLimit: rateLimiter(100) }
	return (request: Request) => {
		// Workers see cf-connecting-ip; behind Caddy the client is in x-forwarded-for.
		const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
		const headers = new Headers(request.headers)
		if (ip && !headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", ip)
		return Effect.runPromise(
			handleRequest(new Request(request, { headers }), {
				storage,
				nowMs: Date.now(),
				randomId: () => crypto.randomUUID(),
				isSharedHost: (host) => hosts.has(host),
				ogImage: bunOgImage,
			}),
		)
	}
}

if (import.meta.main) {
	const url = process.env.MAPLE_PG_URL
	if (!url) throw new Error("status: MAPLE_PG_URL is required")
	const db = statusDb(url)
	await ensureStatusSchema(db)
	const port = Number(process.env.PORT ?? 3478)
	const fetch = makeStatusFetch(pgStorage(db), process.env.MAPLE_STATUS_ORIGINS ?? "http://localhost")
	Bun.serve({ port, hostname: "0.0.0.0", fetch })
	console.log(`maple-status (selfhost) listening on :${port}`)
}
