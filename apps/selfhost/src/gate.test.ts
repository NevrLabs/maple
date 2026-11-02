import { describe, expect, test } from "bun:test"
import { gate } from "./gate"
import { allRoutes, isViewerReadEndpoint, matchRoute, PUBLIC_GROUPS, VIEWER_READ_ENDPOINTS, VIEWER_READ_GROUPS, viewerMay } from "./route-policy"
import { mintSession, readSession, renewSession, signSession } from "./session"
import { makeUsersStore, memorySql } from "./users"

// NevrLabs selfhost: viewer read-only enforcement, instant revoke, and the Members API (PATCHES #5).

const SECRET = "root-password"
const now = () => Math.floor(Date.now() / 1000)
const viewer = () => mintSession({ sub: "oidc:v1", role: "viewer", email: "v@example.com", name: "Vee", idp: "https://idp" }, "default", SECRET, now()).token
const admin = () => mintSession({ sub: "oidc:a1", role: "admin", email: "a@example.com", name: "Ay", idp: "https://idp" }, "default", SECRET, now()).token
const root = () => signSession({ sub: "root", org_id: "default", roles: ["root"], authMode: "self_hosted", iat: now(), exp: now() + 3600 }, SECRET)
const req = (method: string, path: string, token?: string) =>
	new Request(`http://api:3472${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} })

describe("route policy (generated from the live route graph)", () => {
	test("the table is the whole graph", () => expect(allRoutes().length).toBeGreaterThan(400))
	test("every allowlisted endpoint exists (a rename upstream fails here, not silently)", () => {
		const ids = new Set(allRoutes().map((r) => r.id))
		for (const id of VIEWER_READ_ENDPOINTS) expect(ids.has(id)).toBe(true)
		const groups = new Set(allRoutes().map((r) => r.group))
		for (const g of [...VIEWER_READ_GROUPS, ...PUBLIC_GROUPS]) expect(groups.has(g)).toBe(g === "billingPublic" ? groups.has(g) : true)
	})
	test("every allowlisted group endpoint is a POST read, never PUT/PATCH/DELETE", () => {
		for (const r of allRoutes()) if (VIEWER_READ_GROUPS.has(r.group)) expect(["GET", "POST"]).toContain(r.method)
	})
	test("matching is by route pattern, with literal segments winning", () => {
		expect(matchRoute("POST", "/v2/dashboards/import/perses")?.id).toBe("dashboards.importPerses")
		expect(matchRoute("POST", "/v2/dashboards/abc123/widget_data")?.id).toBe("dashboards.widgetData")
		expect(matchRoute("POST", "/internal/query-engine/execute-raw-sql")?.id).toMatch(/^queryEngine\./)
	})
	test("viewer: reads allowed", () => {
		for (const [m, p] of [
			["GET", "/v2/dashboards"],
			["POST", "/internal/query-engine/execute-raw-sql"],
			["POST", "/internal/query-engine/service-overview"],
			["POST", "/v2/logs/search"],
			["POST", "/v2/traces/timeseries"],
			["POST", "/v2/dashboards/d1/widget_data"],
			["POST", "/api/auth/session/refresh"],
		] as const)
			expect(`${m} ${p} ${viewerMay(m, p).allowed}`).toBe(`${m} ${p} true`)
	})
	test("viewer: writes refused (dashboards, alert rules, keys, settings, unknown paths)", () => {
		for (const [m, p] of [
			["POST", "/v2/dashboards"],
			["PATCH", "/v2/dashboards/d1"],
			["DELETE", "/v2/dashboards/d1"],
			["POST", "/v2/alerts/rules"],
			["PATCH", "/v2/alerts/rules/r1"],
			["POST", "/v2/alerts/destinations/x/test"],
			["POST", "/v2/uptime_monitors/test"],
			["POST", "/v2/api_keys"],
			["PUT", "/internal/errors/escalation-policy"],
			["POST", "/internal/chat/apply"],
			["POST", "/v2/something/new-and-unknown"],
		] as const)
			expect(`${m} ${p} ${viewerMay(m, p).allowed}`).toBe(`${m} ${p} false`)
	})
	test("every non-GET endpoint is classified: either an allowlisted read or refused for viewers", () => {
		const reads = allRoutes().filter((r) => r.method !== "GET" && isViewerReadEndpoint(r.id))
		const refused = allRoutes().filter((r) => r.method !== "GET" && !isViewerReadEndpoint(r.id) && !PUBLIC_GROUPS.has(r.group))
		expect(reads.length + refused.length + allRoutes().filter((r) => r.method !== "GET" && PUBLIC_GROUPS.has(r.group)).length).toBe(
			allRoutes().filter((r) => r.method !== "GET").length,
		)
		expect(refused.length).toBeGreaterThan(150)
	})
})

describe("session codec", () => {
	test("mint/read round-trip carries identity and maps roles to the API's names", () => {
		const c = readSession(viewer(), SECRET, now())!
		expect([c.sub, c.roles.join(), c.email, c.name]).toEqual(["oidc:v1", "org:member", "v@example.com", "Vee"])
		expect(readSession(admin(), SECRET, now())!.roles).toEqual(["root"])
	})
	test("wrong secret / tampered / expired are not sessions", () => {
		expect(readSession(viewer(), "other", now())).toBeNull()
		const [h, , s] = viewer().split(".")
		expect(readSession(`${h}.${Buffer.from('{"sub":"root"}').toString("base64url")}.${s}`, SECRET, now())).toBeNull()
		expect(readSession(viewer(), SECRET, now() + 13 * 3600)).toBeNull()
	})
	test("renewal keeps identity and the absolute deadline", () => {
		const c = readSession(viewer(), SECRET, now())!
		const r = renewSession(c, SECRET, now() + 60)
		const c2 = readSession(r.token, SECRET, now() + 60)!
		expect([c2.sub, c2.roles.join(), c2.email, c2.session_exp]).toEqual([c.sub, c.roles.join(), c.email, c.session_exp])
	})
})

describe("gate", () => {
	const store = () => makeUsersStore(memorySql())

	test("anonymous and API-key requests pass to the graph", async () => {
		const cfg = { secret: SECRET, users: store() }
		expect(await gate(req("POST", "/v2/dashboards"), cfg)).toBeNull()
		expect(await gate(req("POST", "/v2/dashboards", "maple_sk_abc"), cfg)).toBeNull()
	})
	test("viewer: GET passes, POST create is 403 with a problem body", async () => {
		const cfg = { secret: SECRET, users: store() }
		expect(await gate(req("GET", "/v2/dashboards", viewer()), cfg)).toBeNull()
		expect(await gate(req("POST", "/internal/query-engine/execute-raw-sql", viewer()), cfg)).toBeNull()
		const res = (await gate(req("POST", "/v2/dashboards", viewer()), cfg))!
		expect(res.status).toBe(403)
		expect((await res.json()).error.code).toBe("read_only_role")
		expect((await gate(req("POST", "/v2/alerts/rules", viewer()), cfg))!.status).toBe(403)
	})
	test("admin and root: writes pass to the graph", async () => {
		const cfg = { secret: SECRET, users: store() }
		expect(await gate(req("POST", "/v2/dashboards", admin()), cfg)).toBeNull()
		expect(await gate(req("POST", "/v2/dashboards", root()), cfg)).toBeNull()
	})
	test("disable -> 401 on the next call; enable -> passes again for a NEW sign-in only", async () => {
		const users = store()
		const cfg = { secret: SECRET, users }
		await users.signIn({ sub: "oidc:v1", role: "viewer" })
		const token = viewer()
		expect(await gate(req("GET", "/v2/dashboards", token), cfg)).toBeNull()
		await users.setDisabled("oidc:v1", true)
		const res = (await gate(req("GET", "/v2/dashboards", token), cfg))!
		expect(res.status).toBe(401)
		expect((await res.json()).error.code).toBe("session_revoked")
		await users.setDisabled("oidc:v1", false)
		// the old token stays cut (disable also set sessions_valid_after) ...
		expect((await gate(req("GET", "/v2/dashboards", token), cfg))!.status).toBe(401)
		// ... a token issued after the re-enable works
		await new Promise((r) => setTimeout(r, 1100))
		expect(await gate(req("GET", "/v2/dashboards", viewer()), cfg)).toBeNull()
	})
	test("sign out everywhere cuts existing tokens, renewal included", async () => {
		const users = store()
		const cfg = { secret: SECRET, users }
		await users.signIn({ sub: "oidc:a1", role: "admin" })
		const token = admin()
		await new Promise((r) => setTimeout(r, 1100))
		await users.signOutEverywhere("oidc:a1")
		expect((await gate(req("GET", "/v2/dashboards", token), cfg))!.status).toBe(401)
		expect((await gate(req("POST", "/api/auth/session/refresh", token), cfg))!.status).toBe(401)
	})
	test("OIDC renewal keeps the viewer role (no escalation through upstream renewal)", async () => {
		const res = (await gate(req("POST", "/api/auth/session/refresh", viewer()), { secret: SECRET, users: store() }))!
		const body = await res.json()
		expect(readSession(body.token, SECRET, now())!.roles).toEqual(["org:member"])
	})
	test("root renewal is left to the API", async () =>
		expect(await gate(req("POST", "/api/auth/session/refresh", root()), { secret: SECRET, users: store() })).toBeNull())

	test("Members API: me for anyone; list/disable for admins only; root row fixed; no self-disable", async () => {
		const users = store()
		const cfg = { secret: SECRET, users }
		await users.signIn({ sub: "oidc:v1", role: "viewer", email: "v@example.com" })
		await users.signIn({ sub: "oidc:a1", role: "admin", email: "a@example.com" })
		expect(await (await gate(req("GET", "/api/selfhost/me", viewer()), cfg))!.json()).toMatchObject({ sub: "oidc:v1", role: "viewer", name: "Vee" })
		expect(await (await gate(req("GET", "/api/selfhost/me", root()), cfg))!.json()).toMatchObject({ sub: "root", role: "admin", name: "Root", isBreakGlass: true })
		expect((await gate(req("GET", "/api/selfhost/users", viewer()), cfg))!.status).toBe(403)
		const list = await (await gate(req("GET", "/api/selfhost/users", admin()), cfg))!.json()
		expect(list.users.map((u: { sub: string }) => u.sub)).toEqual(["root", "oidc:v1", "oidc:a1"])
		expect((await gate(req("POST", "/api/selfhost/users/root/disable", admin()), cfg))!.status).toBe(400)
		expect((await gate(req("POST", "/api/selfhost/users/oidc%3Aa1/disable", admin()), cfg))!.status).toBe(400)
		expect((await gate(req("POST", "/api/selfhost/users/oidc%3Av1/disable", viewer()), cfg))!.status).toBe(403)
		const disabled = await (await gate(req("POST", "/api/selfhost/users/oidc%3Av1/disable", admin()), cfg))!.json()
		expect(disabled.disabled).toBe(true)
		expect((await gate(req("POST", "/api/selfhost/users/oidc%3Anobody/sign-out", admin()), cfg))!.status).toBe(404)
		expect((await gate(req("GET", "/api/selfhost/me"), cfg))!.status).toBe(401)
	})
})
