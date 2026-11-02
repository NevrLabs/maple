/**
 * NevrLabs selfhost: OIDC sign-in (authorization code + PKCE) beside the root password, for any OIDC provider
 * (Zitadel, Authentik, Keycloak, ...). Everything comes from the issuer's discovery document; nothing below is
 * provider-specific except the defaults, which match the homelab's Zitadel.
 *
 *   GET /api/auth/oidc/config    -> { enabled, label }        (the sign-in page draws the button from this)
 *   GET /api/auth/oidc/start     -> 302 to the provider; PKCE verifier + state + nonce in a short-lived signed cookie
 *   GET /api/auth/oidc/callback  -> code exchange (client_secret_basic) -> verify the ID token -> map the role
 *                                   -> signIn(identity) (users table: upsert, refuse disabled; mints the session)
 *                                   -> 302 to the web, token in the URL fragment.
 *
 * Roles (fail closed): the claim at MAPLE_OIDC_ROLES_CLAIM (a dotted path; default Zitadel's project-roles claim)
 * may be an object keyed by role (Zitadel) or an array of strings (Authentik `groups`, generic `roles`), or a single
 * string. MAPLE_OIDC_ADMIN_ROLE -> admin, MAPLE_OIDC_VIEWER_ROLE -> viewer, admin wins; neither -> refused.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { Identity, MapleRole } from "./session"

export type OidcConfig = Readonly<{
	issuer: string
	clientId: string
	clientSecret: string
	scopes: string
	rolesClaim: string
	adminRole: string
	viewerRole: string
	/** The button: "Sign in with <label>". */
	label: string
	/** Public hosts allowed to start a flow (the callback is built from the request's host). */
	hosts: ReadonlySet<string>
	/** HMAC key for the flow cookie; the root password, as the session tokens use. */
	cookieKey: string
}>

export const ZITADEL_ROLES_CLAIM = "urn:zitadel:iam:org:project:roles"
export const ZITADEL_SCOPES = `openid profile email ${ZITADEL_ROLES_CLAIM}`

export const oidcConfigFromEnv = (env: Record<string, string | undefined>): OidcConfig | null => {
	const issuer = env.MAPLE_OIDC_ISSUER?.trim().replace(/\/$/, "")
	const clientId = env.MAPLE_OIDC_CLIENT_ID?.trim()
	const clientSecret = env.MAPLE_OIDC_CLIENT_SECRET?.trim()
	const cookieKey = env.MAPLE_ROOT_PASSWORD
	if (!issuer || !clientId || !clientSecret || !cookieKey) return null
	const opt = (key: string, fallback: string) => env[key]?.trim() || fallback
	return {
		issuer,
		clientId,
		clientSecret,
		cookieKey,
		scopes: opt("MAPLE_OIDC_SCOPES", ZITADEL_SCOPES),
		rolesClaim: opt("MAPLE_OIDC_ROLES_CLAIM", ZITADEL_ROLES_CLAIM),
		// Back-compat: the first release called the admin role MAPLE_OIDC_REQUIRED_ROLE.
		adminRole: opt("MAPLE_OIDC_ADMIN_ROLE", opt("MAPLE_OIDC_REQUIRED_ROLE", "maple-admin")),
		viewerRole: opt("MAPLE_OIDC_VIEWER_ROLE", "maple-viewer"),
		label: opt("MAPLE_OIDC_LABEL", "Zitadel"),
		hosts: new Set(
			opt("MAPLE_OIDC_HOSTS", "monitoring.home,monitoring.entelechia.cloud")
				.split(",")
				.map((host) => host.trim().toLowerCase())
				.filter(Boolean),
		),
	}
}

const FLOW_COOKIE = "maple_oidc_flow"
const FLOW_TTL_SECONDS = 600
const CLOCK_SKEW_SECONDS = 60

const b64url = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString("base64url")
const sign = (data: string, key: string) => createHmac("sha256", key).update(data).digest("base64url")
const safeEqual = (a: string, b: string) => {
	const x = Buffer.from(a)
	const y = Buffer.from(b)
	return x.length === y.length && timingSafeEqual(x, y)
}

// ── Flow cookie ───────────────────────────────────────────────────────────────

type Flow = Readonly<{ state: string; nonce: string; verifier: string; redirectUri: string; exp: number }>

export const sealFlow = (flow: Flow, key: string): string => {
	const body = b64url(Buffer.from(JSON.stringify(flow)))
	return `${body}.${sign(body, key)}`
}

export const openFlow = (cookie: string | undefined, key: string, nowSeconds: number): Flow | null => {
	if (!cookie) return null
	const [body, mac] = cookie.split(".")
	if (!body || !mac || !safeEqual(mac, sign(body, key))) return null
	try {
		const flow = JSON.parse(Buffer.from(body, "base64url").toString()) as Flow
		return flow.exp > nowSeconds ? flow : null
	} catch {
		return null
	}
}

const readCookie = (header: string | null, name: string): string | undefined =>
	header
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${name}=`))
		?.slice(name.length + 1)

// ── Discovery + JWKS (cached per issuer / per key set) ────────────────────────

type Discovery = Readonly<{ authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string }>
type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string }

const cache = new Map<string, { at: number; discovery?: Discovery; keys?: Jwk[] }>()
const CACHE_MS = 60 * 60 * 1000

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const discovery = async (cfg: OidcConfig, fetcher: Fetcher, nowMs: number): Promise<Discovery> => {
	const hit = cache.get(`d:${cfg.issuer}`)
	if (hit?.discovery && nowMs - hit.at < CACHE_MS) return hit.discovery
	const res = await fetcher(`${cfg.issuer}/.well-known/openid-configuration`)
	if (!res.ok) throw new Error(`discovery ${res.status}`)
	const value = (await res.json()) as Discovery
	cache.set(`d:${cfg.issuer}`, { at: nowMs, discovery: value })
	return value
}

const jwks = async (uri: string, fetcher: Fetcher, nowMs: number, force: boolean): Promise<Jwk[]> => {
	const hit = cache.get(`k:${uri}`)
	if (!force && hit?.keys && nowMs - hit.at < CACHE_MS) return hit.keys
	const res = await fetcher(uri)
	if (!res.ok) throw new Error(`jwks ${res.status}`)
	const keys = ((await res.json()) as { keys: Jwk[] }).keys
	cache.set(`k:${uri}`, { at: nowMs, keys })
	return keys
}

// ── ID token verification + role mapping ──────────────────────────────────────

export type IdTokenClaims = Readonly<Record<string, unknown> & { sub: string; email?: string; name?: string }>

export class OidcRejection extends Error {
	constructor(
		readonly reason: string,
		readonly status: 401 | 403 = 401,
	) {
		super(reason)
	}
}

/** The value at a claim path: the whole name first (URN-style names contain dots), then `a.b.c`. */
export const claimAt = (claims: Readonly<Record<string, unknown>>, path: string): unknown => {
	if (path in claims) return claims[path]
	return path
		.split(".")
		.reduce<unknown>((node, key) => (node !== null && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), claims)
}

/** Role names in a claim value: object keys (Zitadel), array items (Authentik groups), or one string. */
export const roleNamesIn = (value: unknown): ReadonlySet<string> => {
	if (typeof value === "string") return new Set(value.split(/[\s,]+/).filter(Boolean))
	if (Array.isArray(value)) return new Set(value.filter((item): item is string => typeof item === "string"))
	if (value !== null && typeof value === "object") return new Set(Object.keys(value))
	return new Set()
}

/** Admin wins over viewer; neither is a refusal (fail closed). */
export const mapRole = (
	claims: Readonly<Record<string, unknown>>,
	cfg: Pick<OidcConfig, "rolesClaim" | "adminRole" | "viewerRole">,
): MapleRole => {
	const names = roleNamesIn(claimAt(claims, cfg.rolesClaim))
	if (names.has(cfg.adminRole)) return "admin"
	if (names.has(cfg.viewerRole)) return "viewer"
	throw new OidcRejection(`missing role ${cfg.adminRole} or ${cfg.viewerRole}`, 403)
}

type AlgSpec = Readonly<{
	kty: string
	importAlg: RsaHashedImportParams | EcKeyImportParams
	verifyAlg: AlgorithmIdentifier | EcdsaParams
}>
const ALGS: Readonly<Record<string, AlgSpec>> = {
	RS256: { kty: "RSA", importAlg: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verifyAlg: "RSASSA-PKCS1-v1_5" },
	ES256: { kty: "EC", importAlg: { name: "ECDSA", namedCurve: "P-256" }, verifyAlg: { name: "ECDSA", hash: "SHA-256" } },
}

/** Header + claims checks, signature included; `keys` is the provider's JWKS. RS256 and ES256. */
export const verifyIdToken = async (
	token: string,
	opts: Readonly<{ issuer: string; clientId: string; nonce: string; nowSeconds: number; keys: Jwk[] }>,
): Promise<IdTokenClaims> => {
	const parts = token.split(".")
	if (parts.length !== 3) throw new OidcRejection("malformed id_token")
	const [h, p, sig] = parts as [string, string, string]
	let header: { alg?: string; kid?: string }
	let claims: Record<string, unknown>
	try {
		header = JSON.parse(Buffer.from(h, "base64url").toString())
		claims = JSON.parse(Buffer.from(p, "base64url").toString())
	} catch {
		throw new OidcRejection("malformed id_token")
	}
	const alg = header.alg === undefined ? undefined : ALGS[header.alg]
	if (!alg) throw new OidcRejection(`unexpected alg ${String(header.alg)}`)
	const candidates = opts.keys.filter((k) => k.kty === alg.kty && (header.kid === undefined || k.kid === header.kid))
	if (candidates.length === 0) throw new OidcRejection("unknown signing key")
	const data = new TextEncoder().encode(`${h}.${p}`)
	const signature = Buffer.from(sig, "base64url")
	let ok = false
	for (const jwk of candidates) {
		const { kid: _kid, alg: _alg, use: _use, key_ops: _ops, ...material } = jwk
		const key = await crypto.subtle.importKey("jwk", material, alg.importAlg, false, ["verify"])
		if (await crypto.subtle.verify(alg.verifyAlg, key, signature, data)) {
			ok = true
			break
		}
	}
	if (!ok) throw new OidcRejection("bad signature")

	if (claims.iss !== opts.issuer) throw new OidcRejection("wrong issuer")
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
	if (!aud.includes(opts.clientId)) throw new OidcRejection("wrong audience")
	if (aud.length > 1 && claims.azp !== undefined && claims.azp !== opts.clientId) throw new OidcRejection("wrong azp")
	if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS <= opts.nowSeconds) throw new OidcRejection("expired")
	if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SECONDS > opts.nowSeconds) throw new OidcRejection("issued in the future")
	if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, opts.nonce)) throw new OidcRejection("nonce mismatch")
	if (typeof claims.sub !== "string" || claims.sub === "") throw new OidcRejection("missing sub")
	return claims as IdTokenClaims
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

/** The public origin the browser used (CT101 nginx / cloudflared set X-Forwarded-*; Caddy passes them on). */
const publicOrigin = (req: Request): string => {
	const url = new URL(req.url)
	const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host
	const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")
	return `${proto.split(",")[0]!.trim()}://${host.split(",")[0]!.trim()}`
}

/** The web is served at the origin root; the API under /_api (Caddy strips it before the api sees the path). */
const API_PREFIX = "/_api"

const redirect = (location: string, headers: Record<string, string> = {}) =>
	new Response(null, { status: 302, headers: { location, "cache-control": "no-store", ...headers } })

const clearCookie = `${FLOW_COOKIE}=; Path=${API_PREFIX}/api/auth/oidc; Max-Age=0; HttpOnly; Secure; SameSite=Lax`

const failTo = (origin: string, reason: string) =>
	redirect(`${origin}/sign-in?oidc_error=${encodeURIComponent(reason)}`, { "set-cookie": clearCookie })

/** Records the sign-in (users table) and mints the session; throws OidcRejection to refuse (e.g. disabled user). */
export type SignIn = (identity: Identity) => Promise<string>

export const handleOidc = async (
	req: Request,
	cfg: OidcConfig | null,
	signIn: SignIn,
	fetcher: Fetcher = fetch,
	log: (line: string) => void = (line) => console.log(line),
): Promise<Response | null> => {
	const url = new URL(req.url)
	if (!url.pathname.startsWith("/api/auth/oidc/")) return null
	const route = url.pathname.slice("/api/auth/oidc/".length)
	if (route === "config")
		return Response.json({ enabled: cfg !== null, label: cfg?.label ?? null }, { headers: { "cache-control": "no-store" } })
	if (cfg === null) return Response.json({ error: "oidc disabled" }, { status: 404 })

	const origin = publicOrigin(req)
	if (!cfg.hosts.has(new URL(origin).host.toLowerCase())) return Response.json({ error: "unknown host" }, { status: 400 })
	const redirectUri = `${origin}${API_PREFIX}/api/auth/oidc/callback`
	const nowMs = Date.now()
	const now = Math.floor(nowMs / 1000)

	if (route === "start") {
		const d = await discovery(cfg, fetcher, nowMs)
		const verifier = b64url(randomBytes(32))
		const flow: Flow = { state: b64url(randomBytes(16)), nonce: b64url(randomBytes(16)), verifier, redirectUri, exp: now + FLOW_TTL_SECONDS }
		const auth = new URL(d.authorization_endpoint)
		auth.search = new URLSearchParams({
			client_id: cfg.clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: cfg.scopes,
			state: flow.state,
			nonce: flow.nonce,
			code_challenge: b64url(createHash("sha256").update(verifier).digest()),
			code_challenge_method: "S256",
		}).toString()
		const cookie = `${FLOW_COOKIE}=${sealFlow(flow, cfg.cookieKey)}; Path=${API_PREFIX}/api/auth/oidc; Max-Age=${FLOW_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`
		return redirect(auth.toString(), { "set-cookie": cookie })
	}

	if (route === "callback") {
		const flow = openFlow(readCookie(req.headers.get("cookie"), FLOW_COOKIE), cfg.cookieKey, now)
		if (!flow) return failTo(origin, "Sign-in expired or was started in another browser. Try again.")
		if (url.searchParams.get("error")) return failTo(origin, url.searchParams.get("error_description") ?? url.searchParams.get("error")!)
		const state = url.searchParams.get("state") ?? ""
		const code = url.searchParams.get("code") ?? ""
		if (!code || !safeEqual(state, flow.state)) return failTo(origin, "Sign-in state mismatch. Try again.")
		try {
			const d = await discovery(cfg, fetcher, nowMs)
			const res = await fetcher(d.token_endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					authorization: `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString("base64")}`,
				},
				body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }),
			})
			if (!res.ok) throw new OidcRejection(`token exchange ${res.status}`)
			const tokens = (await res.json()) as { id_token?: string }
			if (!tokens.id_token) throw new OidcRejection("no id_token")
			const verify = async (force: boolean) =>
				verifyIdToken(tokens.id_token!, {
					issuer: d.issuer,
					clientId: cfg.clientId,
					nonce: flow.nonce,
					nowSeconds: now,
					keys: await jwks(d.jwks_uri, fetcher, nowMs, force),
				})
			// A rotated provider key: refetch the JWKS once before refusing.
			const claims = await verify(false).catch((e) =>
				e instanceof OidcRejection && e.reason === "unknown signing key" ? verify(true) : Promise.reject(e),
			)
			const role = mapRole(claims, cfg)
			const text = (key: string) => {
				const value = claims[key]
				return typeof value === "string" && value.length > 0 ? value : undefined
			}
			const identity: Identity = {
				sub: `oidc:${claims.sub}`,
				role,
				email: text("email"),
				name: text("name") ?? text("preferred_username"),
				idp: cfg.issuer,
			}
			const token = await signIn(identity)
			log(`[oidc] sign-in ok sub=${claims.sub} email=${identity.email ?? "-"} role=${role} host=${new URL(origin).host}`)
			return redirect(`${origin}/#maple_session=${encodeURIComponent(token)}`, { "set-cookie": clearCookie })
		} catch (e) {
			const reason = e instanceof OidcRejection ? e.reason : "provider error"
			log(`[oidc] sign-in refused: ${reason}${e instanceof OidcRejection ? "" : ` (${String(e).slice(0, 160)})`}`)
			const shown = reason.startsWith("missing role")
				? `Your ${cfg.label} account has no access to Maple (role ${cfg.adminRole} or ${cfg.viewerRole}).`
				: reason === "user disabled"
					? "Your Maple access has been disabled by an administrator."
					: `${cfg.label} sign-in failed. Try again.`
			return failTo(origin, shown)
		}
	}
	return Response.json({ error: "not found" }, { status: 404 })
}
