/**
 * NevrLabs selfhost: Maple's self-hosted session tokens, read and minted outside the route graph.
 *
 * Same wire format as `packages/auth` (HS256 over the root password; `sub`, `org_id`, `roles`, `authMode`,
 * `iat`, `exp`, `session_exp`), so the unmodified API keeps verifying every token. OIDC sessions add three
 * display claims the API ignores: `name`, `email`, `idp`. The role is carried as the API's own role names:
 * admin -> `root`, viewer -> `org:member` (non-admin everywhere upstream checks `isAdmin`).
 */
import { createHmac, timingSafeEqual } from "node:crypto"

export const SESSION_TTL_SECONDS = 12 * 60 * 60
export const SESSION_MAX_LIFETIME_SECONDS = 7 * 24 * 60 * 60

export type MapleRole = "admin" | "viewer"
export const ROLE_NAMES: Readonly<Record<MapleRole, string>> = { admin: "root", viewer: "org:member" }

export type SessionClaims = Readonly<{
	sub: string
	org_id: string
	roles: readonly string[]
	authMode: "self_hosted"
	iat: number
	exp?: number
	session_exp?: number
	name?: string
	email?: string
	idp?: string
}>

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

export const signSession = (claims: SessionClaims, secret: string): string => {
	const data = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`
	return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`
}

/** Signature + shape + time checks, mirroring `verifySelfHostedSessionToken`. `null` = not a valid session. */
export const readSession = (token: string, secret: string, nowSeconds: number): SessionClaims | null => {
	const parts = token.split(".")
	if (parts.length !== 3) return null
	const [h, p, s] = parts as [string, string, string]
	const expected = Buffer.from(createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url"))
	const actual = Buffer.from(s)
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
	try {
		if (JSON.parse(Buffer.from(h, "base64url").toString()).alg !== "HS256") return null
		const c = JSON.parse(Buffer.from(p, "base64url").toString()) as SessionClaims
		if (typeof c.sub !== "string" || typeof c.iat !== "number" || c.authMode !== "self_hosted") return null
		if (c.iat > nowSeconds + 60) return null
		if (c.exp !== undefined && nowSeconds >= c.exp) return null
		if (c.session_exp !== undefined && nowSeconds >= c.session_exp) return null
		if (nowSeconds - c.iat >= SESSION_MAX_LIFETIME_SECONDS) return null
		return c
	} catch {
		return null
	}
}

export type Identity = Readonly<{ sub: string; role: MapleRole; name?: string; email?: string; idp?: string }>

/** A fresh login: `iat` now, a 12 h token, a 7 d absolute deadline. */
export const mintSession = (identity: Identity, orgId: string, secret: string, nowSeconds: number) => {
	const sessionExp = nowSeconds + SESSION_MAX_LIFETIME_SECONDS
	return renewSession(
		{
			sub: identity.sub,
			org_id: orgId,
			roles: [ROLE_NAMES[identity.role]],
			authMode: "self_hosted",
			iat: nowSeconds,
			session_exp: sessionExp,
			...(identity.name ? { name: identity.name } : {}),
			...(identity.email ? { email: identity.email } : {}),
			...(identity.idp ? { idp: identity.idp } : {}),
		},
		secret,
		nowSeconds,
	)
}

/**
 * Renewal keeps the identity, the role and the absolute deadline; only `iat`/`exp` move. Keeping `iat` the
 * renewal time is what lets "sign out everywhere" (sessions_valid_after) cut renewed tokens too: a renewal
 * is only issued after the gate has checked the presented token against the users table.
 */
export const renewSession = (claims: SessionClaims, secret: string, nowSeconds: number) => {
	const sessionExp = claims.session_exp ?? claims.iat + SESSION_MAX_LIFETIME_SECONDS
	const exp = Math.min(nowSeconds + SESSION_TTL_SECONDS, sessionExp)
	const token = signSession({ ...claims, iat: nowSeconds, exp, session_exp: sessionExp }, secret)
	return { token, expiresAt: exp, sessionExpiresAt: sessionExp }
}

export const roleOf = (claims: SessionClaims): MapleRole =>
	claims.roles.some((role) => role === "root" || role === "org:admin") || claims.roles.length === 0 ? "admin" : "viewer"

export const bearerOf = (request: Request): string | undefined => {
	const header = request.headers.get("authorization")
	if (!header) return undefined
	const [scheme, token] = header.split(" ")
	return scheme?.toLowerCase() === "bearer" && token ? token : undefined
}
