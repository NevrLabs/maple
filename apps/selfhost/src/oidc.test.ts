import { generateKeyPairSync, createSign } from "node:crypto"
import { describe, expect, test } from "bun:test"
import {
	claimAt,
	handleOidc,
	mapRole,
	openFlow,
	OidcRejection,
	oidcConfigFromEnv,
	roleNamesIn,
	sealFlow,
	verifyIdToken,
	ZITADEL_ROLES_CLAIM,
} from "./oidc"
import type { Identity } from "./session"

// NevrLabs selfhost: the ID-token gate behind "Sign in with <IdP>". Every refusal path must fail closed.

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const other = generateKeyPairSync("rsa", { modulusLength: 2048 })
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "k1", alg: "RS256", use: "sig" }
const ecJwk = { ...(ec.publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "e1", alg: "ES256", use: "sig" }
const NOW = 1_793_600_000
const ISS = "https://auth.example"
const AUD = "client-123"
const NONCE = "nonce-abc"

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")
const sign = (claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: typeof privateKey } = {}) => {
	const head = b64({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" })
	const body = b64(claims)
	const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(opts.key ?? privateKey).toString("base64url")
	return `${head}.${body}.${sig}`
}
const signEs256 = (claims: Record<string, unknown>) => {
	const head = b64({ alg: "ES256", kid: "e1", typ: "JWT" })
	const body = b64(claims)
	const sig = createSign("SHA256").update(`${head}.${body}`).sign({ key: ec.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")
	return `${head}.${body}.${sig}`
}
const good = (over: Record<string, unknown> = {}) => ({
	iss: ISS,
	aud: [AUD, "project-1"],
	azp: AUD,
	sub: "383437416599388195",
	email: "op@example.com",
	iat: NOW - 5,
	exp: NOW + 300,
	nonce: NONCE,
	[ZITADEL_ROLES_CLAIM]: { "maple-admin": { "org-1": "example.org" } },
	...over,
})
const verify = (token: string) => verifyIdToken(token, { issuer: ISS, clientId: AUD, nonce: NONCE, nowSeconds: NOW, keys: [jwk, ecJwk] })
const reason = async (token: string) => {
	try {
		await verify(token)
		return "accepted"
	} catch (e) {
		return e instanceof OidcRejection ? `${e.status} ${e.reason}` : `threw ${String(e)}`
	}
}

describe("verifyIdToken", () => {
	test("a valid RS256 token is accepted", async () => expect((await verify(sign(good()))).sub).toBe("383437416599388195"))
	test("a valid ES256 token is accepted (Authentik/Keycloak can sign with EC)", async () =>
		expect((await verify(signEs256(good()))).sub).toBe("383437416599388195"))
	test("wrong issuer", async () => expect(await reason(sign(good({ iss: "https://evil.example" })))).toBe("401 wrong issuer"))
	test("wrong audience", async () => expect(await reason(sign(good({ aud: ["someone-else"], azp: undefined })))).toBe("401 wrong audience"))
	test("wrong azp with several audiences", async () => expect(await reason(sign(good({ azp: "someone-else" })))).toBe("401 wrong azp"))
	test("nonce mismatch", async () => expect(await reason(sign(good({ nonce: "replayed" })))).toBe("401 nonce mismatch"))
	test("missing nonce", async () => expect(await reason(sign(good({ nonce: undefined })))).toBe("401 nonce mismatch"))
	test("expired (past the 60 s skew)", async () => expect(await reason(sign(good({ exp: NOW - 61 })))).toBe("401 expired"))
	test("signed by another key", async () => expect(await reason(sign(good(), { key: other.privateKey }))).toBe("401 bad signature"))
	test("unknown kid", async () => expect(await reason(sign(good(), { kid: "k9" }))).toBe("401 unknown signing key"))
	test("alg none / HS256 refused", async () => {
		expect(await reason(sign(good(), { alg: "none" }))).toBe("401 unexpected alg none")
		expect(await reason(sign(good(), { alg: "HS256" }))).toBe("401 unexpected alg HS256")
	})
	test("tampered payload", async () => {
		const [h, , s] = sign(good()).split(".")
		expect(await reason(`${h}.${b64(good({ sub: "attacker" }))}.${s}`)).toBe("401 bad signature")
	})
})

describe("role mapping (any IdP)", () => {
	const zitadel = { rolesClaim: ZITADEL_ROLES_CLAIM, adminRole: "maple-admin", viewerRole: "maple-viewer" }
	const authentik = { rolesClaim: "groups", adminRole: "Maple Admins", viewerRole: "Maple Viewers" }
	const nested = { rolesClaim: "realm_access.roles", adminRole: "maple-admin", viewerRole: "maple-viewer" }
	const role = (claims: Record<string, unknown>, cfg: typeof zitadel) => {
		try {
			return mapRole(claims, cfg)
		} catch (e) {
			return e instanceof OidcRejection ? `${e.status} refused` : "threw"
		}
	}

	test("Zitadel-shaped token (object keyed by role): admin", () =>
		expect(role({ [ZITADEL_ROLES_CLAIM]: { "maple-admin": { o: "x" } } }, zitadel)).toBe("admin"))
	test("Zitadel-shaped viewer-only: viewer", () =>
		expect(role({ [ZITADEL_ROLES_CLAIM]: { "maple-viewer": { o: "x" } } }, zitadel)).toBe("viewer"))
	test("Authentik-shaped token (groups array): admin", () =>
		expect(role({ groups: ["authentik Admins", "Maple Admins"] }, authentik)).toBe("admin"))
	test("Authentik-shaped viewer-only: viewer", () => expect(role({ groups: ["Maple Viewers"] }, authentik)).toBe("viewer"))
	test("Keycloak-style nested path (realm_access.roles)", () =>
		expect(role({ realm_access: { roles: ["offline_access", "maple-viewer"] } }, nested)).toBe("viewer"))
	test("generic `roles` as a space-separated string", () =>
		expect(role({ roles: "a maple-admin" }, { ...zitadel, rolesClaim: "roles" })).toBe("admin"))
	test("admin wins when both are present", () =>
		expect(role({ groups: ["Maple Viewers", "Maple Admins"] }, authentik)).toBe("admin"))
	test("missing claim -> refused (fail closed)", () => {
		expect(role({}, zitadel)).toBe("403 refused")
		expect(role({ email: "x" }, authentik)).toBe("403 refused")
	})
	test("claim present but neither role -> refused", () => {
		expect(role({ groups: ["Everyone"] }, authentik)).toBe("403 refused")
		expect(role({ [ZITADEL_ROLES_CLAIM]: { other: {} } }, zitadel)).toBe("403 refused")
	})
	test("a substring is not a role (no prefix/contains matching)", () =>
		expect(role({ groups: ["Maple Admins (old)", "Not Maple Viewers"] }, authentik)).toBe("403 refused"))
	test("claimAt prefers the whole URN name, then a dotted path", () => {
		expect(claimAt({ "a.b": 1, a: { b: 2 } }, "a.b")).toBe(1)
		expect(claimAt({ a: { b: 2 } }, "a.b")).toBe(2)
		expect(roleNamesIn(42).size).toBe(0)
	})
})

describe("config", () => {
	const base = { MAPLE_OIDC_ISSUER: "https://idp/", MAPLE_OIDC_CLIENT_ID: "c", MAPLE_OIDC_CLIENT_SECRET: "s", MAPLE_ROOT_PASSWORD: "r" }
	test("defaults stay Zitadel-compatible; legacy REQUIRED_ROLE still names the admin role", () => {
		const cfg = oidcConfigFromEnv({ ...base, MAPLE_OIDC_REQUIRED_ROLE: "legacy-admin" })!
		expect(cfg.issuer).toBe("https://idp")
		expect(cfg.rolesClaim).toBe(ZITADEL_ROLES_CLAIM)
		expect(cfg.scopes).toContain(ZITADEL_ROLES_CLAIM)
		expect(cfg.adminRole).toBe("legacy-admin")
		expect(cfg.viewerRole).toBe("maple-viewer")
		expect(cfg.label).toBe("Zitadel")
	})
	test("an Authentik deployment is pure env", () => {
		const cfg = oidcConfigFromEnv({
			...base,
			MAPLE_OIDC_SCOPES: "openid profile email groups",
			MAPLE_OIDC_ROLES_CLAIM: "groups",
			MAPLE_OIDC_ADMIN_ROLE: "Maple Admins",
			MAPLE_OIDC_VIEWER_ROLE: "Maple Viewers",
			MAPLE_OIDC_LABEL: "Noovoleum SSO",
			MAPLE_OIDC_HOSTS: "monitoring.noovoleum.site",
		})!
		expect([cfg.scopes, cfg.rolesClaim, cfg.adminRole, cfg.viewerRole, cfg.label, [...cfg.hosts].join()]).toEqual([
			"openid profile email groups",
			"groups",
			"Maple Admins",
			"Maple Viewers",
			"Noovoleum SSO",
			"monitoring.noovoleum.site",
		])
	})
	test("off without issuer, client or secret", () => expect(oidcConfigFromEnv({ ...base, MAPLE_OIDC_CLIENT_SECRET: "" })).toBeNull())
})

describe("flow cookie", () => {
	const flow = { state: "s", nonce: "n", verifier: "v", redirectUri: "https://monitoring.home/_api/api/auth/oidc/callback", exp: NOW + 600 }
	test("round-trips under its key", () => expect(openFlow(sealFlow(flow, "k"), "k", NOW)).toEqual(flow))
	test("rejects another key, a tampered body and an expired flow", () => {
		const sealed = sealFlow(flow, "k")
		expect(openFlow(sealed, "other", NOW)).toBeNull()
		expect(openFlow(`${b64({ ...flow, nonce: "x" })}.${sealed.split(".")[1]}`, "k", NOW)).toBeNull()
		expect(openFlow(sealed, "k", NOW + 601)).toBeNull()
	})
})

describe("handleOidc", () => {
	const cfg = oidcConfigFromEnv({ MAPLE_OIDC_ISSUER: ISS, MAPLE_OIDC_CLIENT_ID: AUD, MAPLE_OIDC_CLIENT_SECRET: "sec", MAPLE_ROOT_PASSWORD: "k" })!
	const req = (path: string, headers: Record<string, string> = {}) =>
		new Request(`http://api:3472${path}`, { headers: { "x-forwarded-host": "monitoring.home", "x-forwarded-proto": "https", ...headers } })
	const fetcher = async (url: string) =>
		url.endsWith("/.well-known/openid-configuration")
			? Response.json({ issuer: ISS, authorization_endpoint: `${ISS}/oauth/v2/authorize`, token_endpoint: `${ISS}/oauth/v2/token`, jwks_uri: `${ISS}/oauth/v2/keys` })
			: new Response("nope", { status: 500 })
	const noSignIn = async () => "t"

	test("other paths are not ours", async () => expect(await handleOidc(req("/api/auth/session"), cfg, noSignIn, fetcher)).toBeNull())
	test("config reports whether OIDC is on, and the button label", async () => {
		expect(await (await handleOidc(req("/api/auth/oidc/config"), cfg, noSignIn, fetcher))!.json()).toEqual({ enabled: true, label: "Zitadel" })
		expect(await (await handleOidc(req("/api/auth/oidc/config"), null, noSignIn, fetcher))!.json()).toEqual({ enabled: false, label: null })
	})
	test("start: 302 to the discovered authorize endpoint with PKCE S256, the configured scopes and the exact callback", async () => {
		const res = (await handleOidc(req("/api/auth/oidc/start"), cfg, noSignIn, fetcher))!
		expect(res.status).toBe(302)
		const loc = new URL(res.headers.get("location")!)
		expect(loc.origin + loc.pathname).toBe(`${ISS}/oauth/v2/authorize`)
		expect(loc.searchParams.get("code_challenge_method")).toBe("S256")
		expect(loc.searchParams.get("redirect_uri")).toBe("https://monitoring.home/_api/api/auth/oidc/callback")
		expect(loc.searchParams.get("scope")).toBe(cfg.scopes)
		expect(res.headers.get("set-cookie")).toMatch(/^maple_oidc_flow=.+; Path=\/_api\/api\/auth\/oidc; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/)
	})
	test("an unknown Host is refused (no open redirect)", async () =>
		expect((await handleOidc(req("/api/auth/oidc/start", { "x-forwarded-host": "evil.example" }), cfg, noSignIn, fetcher))!.status).toBe(400))
	test("callback without the flow cookie signs nobody in", async () => {
		let called = false
		const res = (await handleOidc(req("/api/auth/oidc/callback?code=c&state=s"), cfg, async () => ((called = true), "t"), fetcher))!
		expect(res.headers.get("location")).toStartWith("https://monitoring.home/sign-in?oidc_error=")
		expect(called).toBe(false)
	})
	test("callback with a mismatched state signs nobody in", async () => {
		let called = false
		const cookie = `maple_oidc_flow=${sealFlow({ state: "right", nonce: "n", verifier: "v", redirectUri: "x", exp: Math.floor(Date.now() / 1000) + 600 }, "k")}`
		const res = (await handleOidc(req("/api/auth/oidc/callback?code=c&state=wrong", { cookie }), cfg, async () => ((called = true), "t"), fetcher))!
		expect(decodeURIComponent(res.headers.get("location")!)).toContain("state mismatch")
		expect(called).toBe(false)
	})

	const callback = async (idClaims: Record<string, unknown>, signIn: (i: Identity) => Promise<string>) => {
		const flowState = { state: "st", nonce: NONCE, verifier: "ver", redirectUri: "https://monitoring.home/_api/api/auth/oidc/callback", exp: Math.floor(Date.now() / 1000) + 600 }
		const cookie = `maple_oidc_flow=${sealFlow(flowState, "k")}`
		const nowS = Math.floor(Date.now() / 1000)
		const idToken = sign(good({ iat: nowS - 5, exp: nowS + 300, ...idClaims }))
		const tokenFetcher = async (url: string, init?: RequestInit) => {
			if (url.endsWith("/oauth/v2/token")) {
				const body = new URLSearchParams(String(init?.body))
				expect(body.get("code_verifier")).toBe("ver")
				expect(String((init?.headers as Record<string, string>).authorization)).toStartWith("Basic ")
				return Response.json({ id_token: idToken })
			}
			if (url.endsWith("/oauth/v2/keys")) return Response.json({ keys: [jwk] })
			return fetcher(url)
		}
		const logs: string[] = []
		const res = (await handleOidc(req("/api/auth/oidc/callback?code=c&state=st", { cookie }), cfg, signIn, tokenFetcher, (l) => logs.push(l)))!
		return { location: res.headers.get("location")!, logs }
	}

	test("admin: signIn gets the identity (oidc:<sub>, role, email, name, idp); lands on / with the token in the fragment", async () => {
		let seen: Identity | null = null
		const { location, logs } = await callback({ name: "Op Erator" }, async (i) => ((seen = i), "a.b.c"))
		expect(location).toBe("https://monitoring.home/#maple_session=a.b.c")
		expect(seen).toEqual({ sub: "oidc:383437416599388195", role: "admin", email: "op@example.com", name: "Op Erator", idp: ISS })
		expect(logs[0]).toContain("sign-in ok sub=383437416599388195 email=op@example.com role=admin")
	})
	test("viewer-only token signs in as viewer", async () => {
		let seen: Identity | null = null
		await callback({ [ZITADEL_ROLES_CLAIM]: { "maple-viewer": {} } }, async (i) => ((seen = i), "a.b.c"))
		expect(seen!.role).toBe("viewer")
	})
	test("no role: refused with the reason on /sign-in, signIn never called", async () => {
		let called = false
		const { location } = await callback({ [ZITADEL_ROLES_CLAIM]: undefined }, async () => ((called = true), "t"))
		expect(decodeURIComponent(location)).toContain("has no access to Maple (role maple-admin or maple-viewer)")
		expect(called).toBe(false)
	})
	test("disabled user: signIn refuses, the page says so", async () => {
		const { location } = await callback({}, async () => {
			throw new OidcRejection("user disabled", 403)
		})
		expect(decodeURIComponent(location)).toContain("disabled by an administrator")
	})
	test("disabled: start is 404", async () => expect((await handleOidc(req("/api/auth/oidc/start"), null, noSignIn, fetcher))!.status).toBe(404))
})
