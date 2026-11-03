/**
 * NevrLabs selfhost (PATCHES #9): status-page edge storage without Cloudflare.
 *
 * Upstream publishes status pages into Workers KV (+ an R2 copy) and serves them from the status Worker,
 * which reads only that storage. Self-hosted, both live in one Postgres table `selfhost_status_kv`
 * (namespace 'kv' | 'r2'): the api and the alerting publisher write through `StatusPageStore.fromBindings`
 * over the KV/bucket shims below, and `status.ts` serves `apps/status`'s unmodified handler over
 * `pgStatusStorage`. The colo cache becomes a small in-process map; the break-glass rate limit is in memory.
 *
 * Fork-only file. Upstream files are not edited.
 */
import type {
	StatusPageBucket,
	StatusPageKvListResult,
	StatusPageKvNamespace,
} from "@maple/backend/services/status-pages/StatusPageStore"

type Db = InstanceType<typeof Bun.SQL>

export const statusDb = (url: string): Db => new Bun.SQL(url, { max: 3, idleTimeout: 30 })

export const ensureStatusSchema = async (db: Db) => {
	await db`CREATE TABLE IF NOT EXISTS selfhost_status_kv (
		ns text NOT NULL CHECK (ns IN ('kv', 'r2')),
		key text NOT NULL,
		value text NOT NULL,
		updated_at timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (ns, key)
	)`
}

const get = async (db: Db, ns: "kv" | "r2", key: string): Promise<string | null> => {
	const rows = (await db`SELECT value FROM selfhost_status_kv WHERE ns = ${ns} AND key = ${key}`) as Array<{
		value: string
	}>
	return rows[0]?.value ?? null
}

const put = async (db: Db, ns: "kv" | "r2", key: string, value: string) => {
	await db`INSERT INTO selfhost_status_kv (ns, key, value) VALUES (${ns}, ${key}, ${value})
		ON CONFLICT (ns, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`
}

const del = async (db: Db, ns: "kv" | "r2", key: string) => {
	await db`DELETE FROM selfhost_status_kv WHERE ns = ${ns} AND key = ${key}`
}

/** Keyset-paginated list; the cursor is the last key returned. */
const list = async (db: Db, prefix: string, limit: number, cursor?: string): Promise<StatusPageKvListResult> => {
	const like = `${prefix.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`
	const after = cursor ?? ""
	const rows = (await db`SELECT key FROM selfhost_status_kv
		WHERE ns = 'kv' AND key LIKE ${like} AND key > ${after}
		ORDER BY key LIMIT ${limit + 1}`) as Array<{ key: string }>
	const page = rows.slice(0, limit)
	const complete = rows.length <= limit
	return {
		keys: page.map((row) => ({ name: row.key })),
		list_complete: complete,
		...(complete || page.length === 0 ? {} : { cursor: page[page.length - 1]!.key }),
	}
}

/** The KV namespace + bucket `StatusPageStore.fromBindings` wants, over Postgres. */
export const pgStatusBindings = (db: Db): { kv: StatusPageKvNamespace; bucket: StatusPageBucket } => ({
	kv: {
		get: (key) => get(db, "kv", key),
		put: (key, value) => put(db, "kv", key, value),
		delete: (key) => del(db, "kv", key),
		list: ({ prefix, limit, cursor }) => list(db, prefix, limit, cursor),
	},
	bucket: {
		put: async (key, value) => {
			await put(db, "r2", key, value)
			return {}
		},
		delete: (key) => del(db, "r2", key),
	},
})

export { get as statusGet, put as statusPut, list as statusList }
