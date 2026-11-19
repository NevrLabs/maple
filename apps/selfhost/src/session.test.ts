import { describe, expect, test } from "bun:test"
import { Effect, Exit, Option, Redacted } from "effect"
import { makeResolveTenant } from "../../../packages/auth/src/index"
import { mintSession, readSession, sessionKey } from "./session"

// NevrLabs selfhost (PATCHES #4/#5): OIDC sessions are minted here, outside the route graph, so they must
// verify under upstream's own resolver. Upstream #2828 moved the MAC key to an HKDF derivation.

const ROOT = "selfhost-root-password-0123"
const now = () => Math.floor(Date.now() / 1000)

const resolve = (token: string, signingSecret?: string) =>
	Effect.runPromiseExit(
		makeResolveTenant({
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_ORG_ID_OVERRIDE: Option.none(),
			MAPLE_ROOT_PASSWORD: Option.some(Redacted.make(ROOT)),
			MAPLE_SESSION_SIGNING_SECRET: signingSecret === undefined ? Option.none() : Option.some(Redacted.make(signingSecret)),
			CLERK_SECRET_KEY: Option.none(),
			CLERK_PUBLISHABLE_KEY: Option.none(),
			CLERK_JWT_KEY: Option.none(),
		})({ authorization: `Bearer ${token}` }),
	)

const viewerToken = (env: Record<string, string | undefined>) =>
	mintSession({ sub: "oidc:v1", role: "viewer", email: "v@example.com" }, "default", sessionKey(env), now()).token

describe("fork-minted sessions verify upstream", () => {
	test("without MAPLE_SESSION_SIGNING_SECRET (key from the root password alone)", async () => {
		const exit = await resolve(viewerToken({ MAPLE_ROOT_PASSWORD: ROOT }))
		expect(Exit.isSuccess(exit) && exit.value.userId).toBe("oidc:v1")
	})

	test("with MAPLE_SESSION_SIGNING_SECRET", async () => {
		const exit = await resolve(viewerToken({ MAPLE_ROOT_PASSWORD: ROOT, MAPLE_SESSION_SIGNING_SECRET: "s3cret" }), "s3cret")
		expect(Exit.isSuccess(exit) && exit.value.roles).toEqual(["org:member"])
	})

	test("a token signed with the raw root password (pre-#2828) is refused", async () => {
		expect(Exit.isFailure(await resolve(mintSession({ sub: "oidc:v1", role: "viewer" }, "default", ROOT, now()).token))).toBe(true)
	})

	test("the signing secret changes the key: a token minted without it does not read with it", () => {
		const key = sessionKey({ MAPLE_ROOT_PASSWORD: ROOT, MAPLE_SESSION_SIGNING_SECRET: "s3cret" })
		const token = mintSession({ sub: "oidc:a1", role: "admin" }, "default", key, now()).token
		expect(readSession(token, key, now())?.roles).toEqual(["root"])
		expect(readSession(token, sessionKey({ MAPLE_ROOT_PASSWORD: ROOT }), now())).toBeNull()
	})
})
