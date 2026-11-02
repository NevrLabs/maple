/**
 * NevrLabs selfhost: the gate in front of the unmodified api route graph (PATCHES #5).
 *
 * For every request carrying a self-hosted session bearer:
 *   1. an OIDC subject (`oidc:*`) that is disabled, or whose token predates "sign out everywhere", is refused with
 *      401 before the graph runs (the API itself only checks the signature and lifetimes);
 *   2. a viewer session may only make read requests (route-policy.ts); anything else is 403;
 *   3. session renewal for OIDC sessions is answered here so the renewed token keeps the identity (name, email,
 *      viewer role) — upstream renewal would hand back a bare token.
 * It also serves the Members API:
 *   GET  /api/selfhost/me                     the caller (any session): identity + role for the web
 *   GET  /api/selfhost/users                  admin: the users table (+ the fixed root row)
 *   POST /api/selfhost/users/:sub/disable     admin
 *   POST /api/selfhost/users/:sub/enable      admin
 *   POST /api/selfhost/users/:sub/sign-out    admin: sessions_valid_after = now
 * Root (break-glass) and API keys pass straight through: the root row cannot be revoked from the UI.
 */
import { bearerOf, readSession, renewSession, roleOf, type SessionClaims } from "./session"
import type { UsersStore } from "./users"
import { viewerMay } from "./route-policy"

export type GateConfig = Readonly<{ secret: string; users: UsersStore | null; log?: (line: string) => void }>

const problem = (status: 401 | 403 | 404 | 400, title: string, message: string, extra: Record<string, unknown> = {}) =>
	Response.json(
		{
			error: {
				_tag: status === 401 ? "@maple/http/errors/UnauthorizedError" : "@maple/http/errors/ForbiddenError",
				type: status === 401 ? "authentication_error" : "permission_error",
				code: status === 401 ? "session_revoked" : status === 403 ? "read_only_role" : "invalid_request",
				title,
				message,
				retryable: false,
				recovery: status === 401 ? "reauthenticate" : "none",
				...extra,
			},
		},
		{ status, headers: { "cache-control": "no-store" } },
	)

const isOidc = (claims: SessionClaims) => claims.sub.startsWith("oidc:")

const meOf = (claims: SessionClaims) => ({
	sub: claims.sub,
	role: roleOf(claims),
	name: claims.name ?? (claims.sub === "root" ? "Root" : null),
	email: claims.email ?? null,
	idp: claims.idp ?? null,
	isBreakGlass: !isOidc(claims),
})

const ROOT_ROW = {
	sub: "root",
	email: null,
	name: "Root (break-glass password)",
	idp: null,
	role: "admin",
	firstSeen: null,
	lastSeen: null,
	disabled: false,
	sessionsValidAfter: null,
	isBreakGlass: true,
}

/** `null` = not ours, let the graph answer. */
export const gate = async (request: Request, cfg: GateConfig): Promise<Response | null> => {
	const url = new URL(request.url)
	const path = url.pathname
	const token = bearerOf(request)
	// API keys (maple_sk_...) and anonymous requests: the graph decides.
	const claims = token === undefined ? null : readSession(token, cfg.secret, Math.floor(Date.now() / 1000))
	const isSelfhostApi = path === "/api/selfhost" || path.startsWith("/api/selfhost/")

	if (claims === null) return isSelfhostApi ? problem(401, "Sign in required", "Invalid or missing session.") : null

	// 1. revocation (OIDC subjects only)
	if (isOidc(claims) && cfg.users !== null) {
		if (await cfg.users.isRevoked(claims.sub, claims.iat)) {
			cfg.log?.(`[gate] revoked session refused sub=${claims.sub} ${request.method} ${path}`)
			return problem(401, "Session ended", "Your Maple session was ended by an administrator. Sign in again.")
		}
		cfg.users.seen(claims.sub)
	}

	const role = roleOf(claims)

	// 3. renewal keeps the identity (and is the viewer's one allowed non-read besides reads)
	if (request.method === "POST" && path === "/api/auth/session/refresh" && isOidc(claims)) {
		const renewed = renewSession(claims, cfg.secret, Math.floor(Date.now() / 1000))
		return Response.json(
			{
				token: renewed.token,
				orgId: claims.org_id,
				userId: claims.sub,
				expiresAt: renewed.expiresAt * 1000,
				sessionExpiresAt: renewed.sessionExpiresAt * 1000,
			},
			{ headers: { "cache-control": "no-store" } },
		)
	}

	if (isSelfhostApi) return selfhostApi(request, path, claims, cfg)

	// 2. viewer is read-only
	if (role === "viewer") {
		const decision = viewerMay(request.method, path)
		if (!decision.allowed) {
			cfg.log?.(`[gate] viewer refused sub=${claims.sub} ${request.method} ${path} (${decision.id ?? "unknown route"})`)
			return problem(403, "Read-only access", "Your role (viewer) can view Maple but not change it.", { endpoint: decision.id })
		}
	}
	return null
}

const selfhostApi = async (request: Request, path: string, claims: SessionClaims, cfg: GateConfig): Promise<Response> => {
	if (request.method === "GET" && path === "/api/selfhost/me") return Response.json(meOf(claims), { headers: { "cache-control": "no-store" } })
	if (roleOf(claims) !== "admin") return problem(403, "Admins only", "Only admins can manage Maple users.")
	if (cfg.users === null) return problem(404, "Users are off", "OIDC sign-in is not configured on this deployment.")
	if (request.method === "GET" && path === "/api/selfhost/users") {
		const rows = (await cfg.users.list()).map((row) => ({ ...row, isBreakGlass: false }))
		return Response.json({ users: [ROOT_ROW, ...rows], you: claims.sub }, { headers: { "cache-control": "no-store" } })
	}
	const m = /^\/api\/selfhost\/users\/([^/]+)\/(disable|enable|sign-out)$/.exec(path)
	if (request.method === "POST" && m) {
		const sub = decodeURIComponent(m[1]!)
		const action = m[2]!
		if (!sub.startsWith("oidc:")) return problem(400, "Not revocable", "The root break-glass session cannot be changed here.")
		if (sub === claims.sub && action !== "enable") return problem(400, "Not on yourself", "Ask another admin to disable or sign you out.")
		const row =
			action === "disable"
				? await cfg.users.setDisabled(sub, true)
				: action === "enable"
					? await cfg.users.setDisabled(sub, false)
					: await cfg.users.signOutEverywhere(sub)
		if (row === null) return problem(404, "No such user", `No Maple user ${sub}.`)
		cfg.log?.(`[users] ${action} sub=${sub} by=${claims.sub}`)
		return Response.json({ ...row, isBreakGlass: false })
	}
	return problem(404, "Not found", `${request.method} ${path}`)
}
