/**
 * NevrLabs selfhost: `selfhost_users`, the people who signed in through OIDC, and the revoke switches.
 *
 * Fork-only table in Maple's Postgres, created here on startup (not part of upstream's drizzle migrations, so an
 * upstream migration never collides with it). One row per IdP subject; upserted on every OIDC sign-in.
 *   disabled                -> every request with that subject is refused (401), new sign-ins too
 *   sessions_valid_after    -> tokens issued (iat) before it are refused: "Sign out everywhere"
 * Reads are cached for REVOKE_CACHE_MS so a busy page does not hit Postgres per request; a write through this
 * store invalidates the cache at once, so a revoke from the Members page is immediate on this instance.
 */
import type { Identity, MapleRole } from "./session"

export type UserRow = Readonly<{
	sub: string
	email: string | null
	name: string | null
	idp: string | null
	role: MapleRole
	firstSeen: string
	lastSeen: string
	disabled: boolean
	sessionsValidAfter: string | null
}>

export type RevokeState = Readonly<{ disabled: boolean; validAfterSeconds: number | null }>

/** The few statements the store needs; `Bun.SQL` in production, an in-memory fake in tests. */
export type Sql = Readonly<{
	ensureSchema: () => Promise<void>
	upsertSignIn: (identity: Identity, now: Date) => Promise<UserRow>
	list: () => Promise<readonly UserRow[]>
	get: (sub: string) => Promise<UserRow | null>
	setDisabled: (sub: string, disabled: boolean, now: Date) => Promise<UserRow | null>
	signOutEverywhere: (sub: string, now: Date) => Promise<UserRow | null>
	touch: (sub: string, now: Date) => Promise<void>
}>

export const REVOKE_CACHE_MS = 5_000
const TOUCH_EVERY_MS = 60_000

export type UsersStore = Readonly<{
	signIn: (identity: Identity) => Promise<UserRow>
	revokeState: (sub: string) => Promise<RevokeState | null>
	/** Has this token been revoked? (subject disabled, or issued before "sign out everywhere"). Unknown subjects pass:
	 * only OIDC subjects are ever recorded, and the root break-glass session is never revocable from here. */
	isRevoked: (sub: string, iatSeconds: number) => Promise<boolean>
	list: () => Promise<readonly UserRow[]>
	setDisabled: (sub: string, disabled: boolean) => Promise<UserRow | null>
	signOutEverywhere: (sub: string) => Promise<UserRow | null>
	/** Records activity (last_seen), at most once a minute per subject. */
	seen: (sub: string) => void
}>

export const makeUsersStore = (sql: Sql, now: () => Date = () => new Date()): UsersStore => {
	const cache = new Map<string, { at: number; state: RevokeState | null }>()
	const touched = new Map<string, number>()
	const stateOf = (row: UserRow | null): RevokeState | null =>
		row === null
			? null
			: {
					disabled: row.disabled,
					validAfterSeconds: row.sessionsValidAfter === null ? null : Math.floor(Date.parse(row.sessionsValidAfter) / 1000),
				}
	const remember = (row: UserRow | null, sub: string) => {
		cache.set(sub, { at: now().getTime(), state: stateOf(row) })
		return row
	}
	const revokeState = async (sub: string) => {
		const hit = cache.get(sub)
		if (hit && now().getTime() - hit.at < REVOKE_CACHE_MS) return hit.state
		const row = await sql.get(sub)
		remember(row, sub)
		return stateOf(row)
	}
	return {
		signIn: async (identity) => remember(await sql.upsertSignIn(identity, now()), identity.sub) as UserRow,
		revokeState,
		isRevoked: async (sub, iatSeconds) => {
			const state = await revokeState(sub)
			if (state === null) return false
			// `iat` has 1 s resolution: a token minted in the same second as the revoke may predate it, so it is cut too
			// (fail closed; the cost is at most one extra sign-in for someone signing in that very second).
			return state.disabled || (state.validAfterSeconds !== null && iatSeconds <= state.validAfterSeconds)
		},
		list: () => sql.list(),
		setDisabled: async (sub, disabled) => remember(await sql.setDisabled(sub, disabled, now()), sub),
		signOutEverywhere: async (sub) => remember(await sql.signOutEverywhere(sub, now()), sub),
		seen: (sub) => {
			const at = now().getTime()
			if (at - (touched.get(sub) ?? 0) < TOUCH_EVERY_MS) return
			touched.set(sub, at)
			void sql.touch(sub, now()).catch(() => {})
		},
	}
}

// ── Postgres (Bun.SQL) ────────────────────────────────────────────────────────

type DbRow = {
	sub: string
	email: string | null
	name: string | null
	idp: string | null
	role: string
	first_seen: Date
	last_seen: Date
	disabled: boolean
	sessions_valid_after: Date | null
}

const toRow = (r: DbRow): UserRow => ({
	sub: r.sub,
	email: r.email,
	name: r.name,
	idp: r.idp,
	role: r.role === "admin" ? "admin" : "viewer",
	firstSeen: new Date(r.first_seen).toISOString(),
	lastSeen: new Date(r.last_seen).toISOString(),
	disabled: r.disabled,
	sessionsValidAfter: r.sessions_valid_after === null ? null : new Date(r.sessions_valid_after).toISOString(),
})

export const pgSql = (url: string): Sql => {
	const db = new Bun.SQL(url, { max: 3, idleTimeout: 30 })
	const one = (rows: DbRow[]) => (rows[0] ? toRow(rows[0]) : null)
	return {
		ensureSchema: async () => {
			await db`CREATE TABLE IF NOT EXISTS selfhost_users (
				sub text PRIMARY KEY,
				email text,
				name text,
				idp text,
				role text NOT NULL CHECK (role IN ('admin', 'viewer')),
				first_seen timestamptz NOT NULL DEFAULT now(),
				last_seen timestamptz NOT NULL DEFAULT now(),
				disabled boolean NOT NULL DEFAULT false,
				sessions_valid_after timestamptz
			)`
		},
		upsertSignIn: async (i, now) =>
			one(
				await db`INSERT INTO selfhost_users (sub, email, name, idp, role, first_seen, last_seen)
					VALUES (${i.sub}, ${i.email ?? null}, ${i.name ?? null}, ${i.idp ?? null}, ${i.role}, ${now}, ${now})
					ON CONFLICT (sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, idp = EXCLUDED.idp,
						role = EXCLUDED.role, last_seen = EXCLUDED.last_seen
					RETURNING *`,
			) as UserRow,
		list: async () => ((await db`SELECT * FROM selfhost_users ORDER BY last_seen DESC`) as DbRow[]).map(toRow),
		get: async (sub) => one(await db`SELECT * FROM selfhost_users WHERE sub = ${sub}`),
		setDisabled: async (sub, disabled, now) =>
			one(
				// Disabling also cuts every outstanding token; enabling leaves that cut in place.
				disabled
					? await db`UPDATE selfhost_users SET disabled = true, sessions_valid_after = ${now} WHERE sub = ${sub} RETURNING *`
					: await db`UPDATE selfhost_users SET disabled = false WHERE sub = ${sub} RETURNING *`,
			),
		signOutEverywhere: async (sub, now) =>
			one(await db`UPDATE selfhost_users SET sessions_valid_after = ${now} WHERE sub = ${sub} RETURNING *`),
		touch: async (sub, now) => {
			await db`UPDATE selfhost_users SET last_seen = ${now} WHERE sub = ${sub} AND last_seen < ${now}`
		},
	}
}

/** In-memory `Sql` for tests. */
export const memorySql = (): Sql & { rows: Map<string, UserRow> } => {
	const rows = new Map<string, UserRow>()
	const put = (row: UserRow) => (rows.set(row.sub, row), row)
	return {
		rows,
		ensureSchema: async () => {},
		upsertSignIn: async (i, now) => {
			const prev = rows.get(i.sub)
			return put({
				sub: i.sub,
				email: i.email ?? null,
				name: i.name ?? null,
				idp: i.idp ?? null,
				role: i.role,
				firstSeen: prev?.firstSeen ?? now.toISOString(),
				lastSeen: now.toISOString(),
				disabled: prev?.disabled ?? false,
				sessionsValidAfter: prev?.sessionsValidAfter ?? null,
			})
		},
		list: async () => [...rows.values()],
		get: async (sub) => rows.get(sub) ?? null,
		setDisabled: async (sub, disabled, now) => {
			const prev = rows.get(sub)
			return prev ? put({ ...prev, disabled, sessionsValidAfter: disabled ? now.toISOString() : prev.sessionsValidAfter }) : null
		},
		signOutEverywhere: async (sub, now) => {
			const prev = rows.get(sub)
			return prev ? put({ ...prev, sessionsValidAfter: now.toISOString() }) : null
		},
		touch: async (sub, now) => {
			const prev = rows.get(sub)
			if (prev) put({ ...prev, lastSeen: now.toISOString() })
		},
	}
}
