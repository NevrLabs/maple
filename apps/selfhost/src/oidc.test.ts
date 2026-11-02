import { generateKeyPairSync, createSign } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { handleOidc, openFlow, OidcRejection, ROLES_CLAIM, sealFlow, verifyIdToken } from "./oidc"

// NevrLabs selfhost: the ID-token gate behind "Sign in with Zitadel". Every refusal path must fail closed.

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const other = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "k1", alg: "RS256", use: "sig" }
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
const good = (over: Record<string, unknown> = {}) => ({
	iss: ISS,
	aud: [AUD, "project-1"],
	azp: AUD,
	sub: "383437416599388195",
	email: "op@example.com",
	iat: NOW - 5,
	exp: NOW + 300,
	nonce: NONCE,
	[ROLES_CLAIM]: { "maple-admin": { "org-1": "example.org" } },
	...over,
})
const verify = (token: string) =>
	verifyIdToken(token, { issuer: ISS, clientId: AUD, nonce: NONCE, requiredRole: "maple-admin", nowSeconds: NOW, keys: [jwk] })
const reason = async (token: string) => {
	try {
		await verify(token)
		return "accepted"
	} catch (e) {
		return e instanceof OidcRejection ? `${e.status} ${e.reason}` : `threw ${String(e)}`
	}
}

describe("verifyIdToken", () => {
	test("a valid, signed token with the role is accepted", async () => {
		const claims = await verify(sign(good()))
		expect(claims.sub).toBe("383437416599388195")
	})
	test("wrong issuer", async () => expect(await reason(sign(good({ iss: "https://evil.example" })))).toBe("401 wrong issuer"))
	test("wrong audience", async () => expect(await reason(sign(good({ aud: ["someone-else"], azp: undefined })))).toBe("401 wrong audience"))
	test("wrong azp with several audiences", async () => expect(await reason(sign(good({ azp: "someone-else" })))).toBe("401 wrong azp"))
	test("nonce mismatch", async () => expect(await reason(sign(good({ nonce: "replayed" })))).toBe("401 nonce mismatch"))
	test("missing nonce", async () => expect(await reason(sign(good({ nonce: undefined })))).toBe("401 nonce mismatch"))
	test("expired (past the 60 s skew)", async () => expect(await reason(sign(good({ exp: NOW - 61 })))).toBe("401 expired"))
	test("missing role claim fails closed", async () => expect(await reason(sign(good({ [ROLES_CLAIM]: undefined })))).toBe("403 missing role maple-admin"))
	test("other project role only", async () => expect(await reason(sign(good({ [ROLES_CLAIM]: { viewer: {} } })))).toBe("403 missing role maple-admin"))
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
	const cfg = { issuer: ISS, clientId: AUD, clientSecret: "sec", requiredRole: "maple-admin", cookieKey: "k" }
	const req = (path: string, headers: Record<string, string> = {}) =>
		new Request(`http://api:3472${path}`, { headers: { "x-forwarded-host": "monitoring.home", "x-forwarded-proto": "https", ...headers } })
	const fetcher = async (url: string) =>
		url.endsWith("/.well-known/openid-configuration")
			? Response.json({ issuer: ISS, authorization_endpoint: `${ISS}/oauth/v2/authorize`, token_endpoint: `${ISS}/oauth/v2/token`, jwks_uri: `${ISS}/oauth/v2/keys` })
			: new Response("nope", { status: 500 })

	test("other paths are not ours", async () => expect(await handleOidc(req("/api/auth/session"), cfg, async () => "t", fetcher)).toBeNull())
	test("config reports whether OIDC is on", async () => {
		expect(await (await handleOidc(req("/api/auth/oidc/config"), cfg, async () => "t", fetcher))!.json()).toEqual({ enabled: true })
		expect(await (await handleOidc(req("/api/auth/oidc/config"), null, async () => "t", fetcher))!.json()).toEqual({ enabled: false })
	})
	test("start: 302 to the provider with PKCE S256, state, nonce and the exact callback; flow cookie set", async () => {
		const res = (await handleOidc(req("/api/auth/oidc/start"), cfg, async () => "t", fetcher))!
		expect(res.status).toBe(302)
		const loc = new URL(res.headers.get("location")!)
		expect(loc.origin + loc.pathname).toBe(`${ISS}/oauth/v2/authorize`)
		expect(loc.searchParams.get("code_challenge_method")).toBe("S256")
		expect(loc.searchParams.get("redirect_uri")).toBe("https://monitoring.home/_api/api/auth/oidc/callback")
		expect(loc.searchParams.get("scope")).toContain("urn:zitadel:iam:org:project:roles")
		expect(res.headers.get("set-cookie")).toMatch(/^maple_oidc_flow=.+; Path=\/_api\/api\/auth\/oidc; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/)
	})
	test("an unknown Host is refused (no open redirect)", async () =>
		expect((await handleOidc(req("/api/auth/oidc/start", { "x-forwarded-host": "evil.example" }), cfg, async () => "t", fetcher))!.status).toBe(400))
	test("callback without the flow cookie mints nothing and returns to sign-in with a reason", async () => {
		let minted = false
		const res = (await handleOidc(req("/api/auth/oidc/callback?code=c&state=s"), cfg, async () => ((minted = true), "t"), fetcher))!
		expect(res.status).toBe(302)
		expect(res.headers.get("location")).toStartWith("https://monitoring.home/sign-in?oidc_error=")
		expect(minted).toBe(false)
	})
	test("callback with a mismatched state mints nothing", async () => {
		let minted = false
		const cookie = `maple_oidc_flow=${sealFlow({ state: "right", nonce: "n", verifier: "v", redirectUri: "x", exp: Math.floor(Date.now() / 1000) + 600 }, "k")}`
		const res = (await handleOidc(req("/api/auth/oidc/callback?code=c&state=wrong", { cookie }), cfg, async () => ((minted = true), "t"), fetcher))!
		expect(decodeURIComponent(res.headers.get("location")!)).toContain("state mismatch")
		expect(minted).toBe(false)
	})
	test("disabled: start is 404", async () => expect((await handleOidc(req("/api/auth/oidc/start"), null, async () => "t", fetcher))!.status).toBe(404))
})
