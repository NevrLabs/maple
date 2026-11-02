/**
 * NevrLabs selfhost: "Sign in with Zitadel" (OIDC authorization code + PKCE) alongside the root password.
 *
 * Served by the selfhost Bun server in front of the unmodified api route graph:
 *   GET /api/auth/oidc/config    -> { enabled }                        (the sign-in page asks before drawing the button)
 *   GET /api/auth/oidc/start     -> 302 to the provider; PKCE verifier + state + nonce in a short-lived signed cookie
 *   GET /api/auth/oidc/callback  -> code exchange (client_secret_basic) -> verify the ID token -> mint the SAME
 *                                   self-hosted session token the root-password login issues -> 302 to the web,
 *                                   token in the URL fragment (never sent to a server, never logged)
 * Authorization fails closed: the ID token must carry the project role (MAPLE_OIDC_REQUIRED_ROLE) in
 * `urn:zitadel:iam:org:project:roles`. Off unless MAPLE_OIDC_ISSUER + CLIENT_ID + CLIENT_SECRET are set.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export type OidcConfig = Readonly<{
	issuer: string
	clientId: string
	clientSecret: string
	requiredRole: string
	/** HMAC key for the flow cookie; the root password, as the session tokens use. */
	cookieKey: string
}>

export const oidcConfigFromEnv = (env: Record<string, string | undefined>): OidcConfig | null => {
	const issuer = env.MAPLE_OIDC_ISSUER?.trim().replace(/\/$/, "")
	const clientId = env.MAPLE_OIDC_CLIENT_ID?.trim()
	const clientSecret = env.MAPLE_OIDC_CLIENT_SECRET?.trim()
	const cookieKey = env.MAPLE_ROOT_PASSWORD
	if (!issuer || !clientId || !clientSecret || !cookieKey) return null
	return { issuer, clientId, clientSecret, cookieKey, requiredRole: env.MAPLE_OIDC_REQUIRED_ROLE?.trim() || "maple-admin" }
}

export const ROLES_CLAIM = "urn:zitadel:iam:org:project:roles"
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

// ── Discovery + JWKS (cached) ─────────────────────────────────────────────────

type Discovery = Readonly<{ authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string }>
type Jwk = JsonWebKey & { kid?: string; alg?: string }

const cache: { discovery?: { at: number; value: Discovery }; jwks?: { at: number; keys: Jwk[] } } = {}
const CACHE_MS = 60 * 60 * 1000

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const discovery = async (cfg: OidcConfig, fetcher: Fetcher, nowMs: number): Promise<Discovery> => {
	if (cache.discovery && nowMs - cache.discovery.at < CACHE_MS) return cache.discovery.value
	const res = await fetcher(`${cfg.issuer}/.well-known/openid-configuration`)
	if (!res.ok) throw new Error(`discovery ${res.status}`)
	const value = (await res.json()) as Discovery
	cache.discovery = { at: nowMs, value }
	return value
}

const jwks = async (uri: string, fetcher: Fetcher, nowMs: number, force: boolean): Promise<Jwk[]> => {
	if (!force && cache.jwks && nowMs - cache.jwks.at < CACHE_MS) return cache.jwks.keys
	const res = await fetcher(uri)
	if (!res.ok) throw new Error(`jwks ${res.status}`)
	const keys = ((await res.json()) as { keys: Jwk[] }).keys
	cache.jwks = { at: nowMs, keys }
	return keys
}

// ── ID token verification ─────────────────────────────────────────────────────

export type IdTokenClaims = Readonly<Record<string, unknown> & { sub: string; email?: string }>

export class OidcRejection extends Error {
	constructor(
		readonly reason: string,
		readonly status: 401 | 403 = 401,
	) {
		super(reason)
	}
}

/** Header + claims checks, signature included; `keys` is the provider's JWKS. Pure apart from WebCrypto. */
export const verifyIdToken = async (
	token: string,
	opts: Readonly<{ issuer: string; clientId: string; nonce: string; requiredRole: string; nowSeconds: number; keys: Jwk[] }>,
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
	if (header.alg !== "RS256") throw new OidcRejection(`unexpected alg ${String(header.alg)}`)
	const jwk = opts.keys.find((k) => k.kid === header.kid && (k.kty === "RSA"))
	if (!jwk) throw new OidcRejection("unknown signing key")
	const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])
	const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(sig, "base64url"), new TextEncoder().encode(`${h}.${p}`))
	if (!ok) throw new OidcRejection("bad signature")

	if (claims.iss !== opts.issuer) throw new OidcRejection("wrong issuer")
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
	if (!aud.includes(opts.clientId)) throw new OidcRejection("wrong audience")
	if (aud.length > 1 && claims.azp !== undefined && claims.azp !== opts.clientId) throw new OidcRejection("wrong azp")
	if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS <= opts.nowSeconds) throw new OidcRejection("expired")
	if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SECONDS > opts.nowSeconds) throw new OidcRejection("issued in the future")
	if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, opts.nonce)) throw new OidcRejection("nonce mismatch")
	if (typeof claims.sub !== "string" || claims.sub === "") throw new OidcRejection("missing sub")

	// Fail closed: no roles claim, or no required role in it, is a refusal.
	const roles = claims[ROLES_CLAIM]
	if (roles === null || typeof roles !== "object" || !(opts.requiredRole in (roles as object)))
		throw new OidcRejection(`missing role ${opts.requiredRole}`, 403)
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
const ALLOWED_HOSTS = new Set(["monitoring.home", "monitoring.entelechia.cloud"])

const redirect = (location: string, headers: Record<string, string> = {}) =>
	new Response(null, { status: 302, headers: { location, "cache-control": "no-store", ...headers } })

const clearCookie = `${FLOW_COOKIE}=; Path=${API_PREFIX}/api/auth/oidc; Max-Age=0; HttpOnly; Secure; SameSite=Lax`

const failTo = (origin: string, reason: string) =>
	redirect(`${origin}/sign-in?oidc_error=${encodeURIComponent(reason)}`, { "set-cookie": clearCookie })

export type MintSession = (subject: string) => Promise<string>

export const handleOidc = async (
	req: Request,
	cfg: OidcConfig | null,
	mint: MintSession,
	fetcher: Fetcher = fetch,
	log: (line: string) => void = (line) => console.log(line),
): Promise<Response | null> => {
	const url = new URL(req.url)
	if (!url.pathname.startsWith("/api/auth/oidc/")) return null
	const route = url.pathname.slice("/api/auth/oidc/".length)
	if (route === "config") return Response.json({ enabled: cfg !== null }, { headers: { "cache-control": "no-store" } })
	if (cfg === null) return Response.json({ error: "oidc disabled" }, { status: 404 })

	const origin = publicOrigin(req)
	if (!ALLOWED_HOSTS.has(new URL(origin).host)) return Response.json({ error: "unknown host" }, { status: 400 })
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
			scope: "openid profile email urn:zitadel:iam:org:project:roles",
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
					requiredRole: cfg.requiredRole,
					nowSeconds: now,
					keys: await jwks(d.jwks_uri, fetcher, nowMs, force),
				})
			// A rotated provider key: refetch the JWKS once before refusing.
			const claims = await verify(false).catch((e) => (e instanceof OidcRejection && e.reason === "unknown signing key" ? verify(true) : Promise.reject(e)))
			const token = await mint(`oidc:${claims.sub}`)
			log(`[oidc] sign-in ok sub=${claims.sub} email=${claims.email ?? "-"} host=${new URL(origin).host}`)
			return redirect(`${origin}/sign-in#maple_session=${encodeURIComponent(token)}`, { "set-cookie": clearCookie })
		} catch (e) {
			const reason = e instanceof OidcRejection ? e.reason : "provider error"
			log(`[oidc] sign-in refused: ${reason}${e instanceof OidcRejection ? "" : ` (${String(e).slice(0, 160)})`}`)
			return failTo(origin, reason.startsWith("missing role") ? "Your Zitadel account has no access to Maple (role maple-admin)." : "Zitadel sign-in failed. Try again.")
		}
	}
	return Response.json({ error: "not found" }, { status: 404 })
}
