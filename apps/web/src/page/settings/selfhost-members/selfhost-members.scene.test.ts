import { expect, given, role, scene, text } from "foldkit/scene"
import { Result } from "effect"
import { describe, expect as expectVitest, test } from "vitest"
import { identityOfToken } from "../../../platform/selfhost-session"
import { Message, type UserRow, type UsersList } from "./model"
import { FetchUsers, init, update } from "./update"
import { view } from "./view"

// NevrLabs selfhost (PATCHES #5): Settings > Members on a self-hosted deployment.

const NOW = Date.parse("2026-11-02T12:00:00Z")
const row = (over: Partial<UserRow>): UserRow => ({
	sub: "oidc:1",
	email: "op@example.com",
	name: "Op Erator",
	idp: "https://auth.entelechia.cloud",
	role: "admin",
	firstSeen: "2026-11-01T00:00:00Z",
	lastSeen: "2026-11-02T11:55:00Z",
	disabled: false,
	sessionsValidAfter: null,
	isBreakGlass: false,
	...over,
})
const ROOT = row({ sub: "root", email: null, name: "Root (break-glass password)", idp: null, lastSeen: null, firstSeen: null, isBreakGlass: true })
const list: UsersList = {
	you: "oidc:1",
	users: [ROOT, row({}), row({ sub: "oidc:2", email: "viewer@example.com", name: "Vee Ewer", role: "viewer" })],
}
const loaded = () => update(init(true).model, Message.CompletedFetchUsers({ result: Result.succeed(list) })).model

describe("self-hosted Members", () => {
	test("an admin reads the users table on entry; a viewer reads nothing and is told why", () => {
		expectVitest(init(true).commands).toEqual([FetchUsers()])
		expectVitest(init(false).commands).toEqual([])
		scene({ update, view: (m, h) => view(m, { nowMs: NOW }, h) }, given(init(false).model), expect(text(/Only admins can see and manage Maple users/)).toExist())
	})

	test("rows: root fixed (no actions), you (no actions), others get Sign out everywhere + Disable; IdP host shown; roles note", () => {
		scene(
			{ update, view: (m, h) => view(m, { nowMs: NOW }, h) },
			given(loaded()),
			expect(text("Root (break-glass password)")).toExist(),
			expect(text("Break-glass · always on")).toExist(),
			expect(text("You")).toExist(),
			expect(text("Vee Ewer")).toExist(),
			expect(text("viewer")).toExist(),
			expect(text("auth.entelechia.cloud")).toExist(),
			expect(role("button", { name: "Sign out everywhere" })).toExist(),
			expect(role("button", { name: "Disable" })).toExist(),
			expect(role("button", { name: "Invite member" })).not.toExist(),
			expect(text(/Roles are managed in your identity provider/)).toExist(),
		)
	})

	test("Disable runs the action for that row and shows the result; the row reads Disabled with Enable", () => {
		const clicked = update(loaded(), Message.ClickedAction({ sub: "oidc:2", action: "disable", label: "Vee Ewer" }))
		expectVitest(clicked.commands?.map((c) => [c.name, c.args])).toEqual([["RunSelfhostUserAction", { sub: "oidc:2", action: "disable", label: "Vee Ewer" }]])
		const done = update(
			clicked.model,
			Message.CompletedAction({ sub: "oidc:2", action: "disable", label: "Vee Ewer", result: Result.succeed(row({ sub: "oidc:2", name: "Vee Ewer", role: "viewer", disabled: true })) }),
		).model
		scene(
			{ update, view: (m, h) => view(m, { nowMs: NOW }, h) },
			given(done),
			expect(text("Disabled")).toExist(),
			expect(role("button", { name: "Enable" })).toExist(),
			expect(role("status")).toHaveText("Vee Ewer is disabled and signed out everywhere."),
		)
	})

	test("a second click while a write is in flight does nothing", () => {
		const first = update(loaded(), Message.ClickedAction({ sub: "oidc:2", action: "sign-out", label: "Vee" }))
		expectVitest(update(first.model, Message.ClickedAction({ sub: "oidc:2", action: "disable", label: "Vee" })).commands ?? []).toEqual([])
	})
})

describe("session identity (labels + viewer-hidden controls)", () => {
	const tokenWith = (claims: Record<string, unknown>) =>
		`h.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.s`
	test("OIDC admin: name, email, admin", () =>
		expectVitest(identityOfToken(tokenWith({ sub: "oidc:1", roles: ["root"], name: "Raisal", email: "r@x" }))).toEqual({
			sub: "oidc:1",
			name: "Raisal",
			email: "r@x",
			role: "admin",
			isBreakGlass: false,
		}))
	test("OIDC viewer reads as viewer; email when no name", () =>
		expectVitest(identityOfToken(tokenWith({ sub: "oidc:2", roles: ["org:member"], email: "v@x" }))).toMatchObject({ name: "v@x", role: "viewer" }))
	test("root password session and no token read as Root, admin", () => {
		expectVitest(identityOfToken(tokenWith({ sub: "root", roles: ["root"] }))).toMatchObject({ name: "Root", role: "admin", isBreakGlass: true })
		expectVitest(identityOfToken(null)).toMatchObject({ name: "Root", role: "admin" })
	})
	test("non-ASCII names survive", () => expectVitest(identityOfToken(tokenWith({ sub: "oidc:3", roles: ["root"], name: "Rä" })).name).toBe("Rä"))
})
