import { expect, given, label, role, scene, text } from "foldkit/scene"
import { describe, expect as expectVitest, test, vi } from "vitest"

// NevrLabs selfhost: the image is built with VITE_MAPLE_OIDC=zitadel; the flag is read at import.
vi.hoisted(() => {
	vi.stubEnv("VITE_MAPLE_OIDC", "zitadel")
	vi.stubEnv("VITE_API_BASE_URL", "/_api")
})
import { AppRoute } from "../../route"
import { init, oidcErrorOf, update, view } from "./index"

describe("self-hosted sign-in with Zitadel", () => {
	test("the provider button sits above the root password, which stays", () => {
		scene(
			{ update, view },
			given(init()),
			expect(role("button", { name: "Sign in with Zitadel" })).toHaveAttr("type", "submit"),
			expect(role("button", { name: "Sign in with Zitadel" })).toHaveAttr("data-oidc-start", "zitadel"),
			expect(text("or use the root password")).toExist(),
			expect(label("Root password")).toExist(),
			expect(role("button", { name: "Sign in" })).toExist(),
		)
	})

	test("a refusal from the callback is shown; none by default", () => {
		scene({ update, view }, given(init()), expect(text(/no access to Maple/)).not.toExist())
		scene(
			{ update, view },
			given(init("Your Zitadel account has no access to Maple (role maple-admin).")),
			expect(role("alert")).toHaveText("Your Zitadel account has no access to Maple (role maple-admin)."),
		)
	})

	test("the refusal is read from /sign-in?oidc_error= only", () => {
		expectVitest(oidcErrorOf(AppRoute.SignIn({ search: { oidc_error: "nope" } }))).toBe("nope")
		expectVitest(oidcErrorOf(AppRoute.SignIn({ search: {} }))).toBeUndefined()
	})
})
