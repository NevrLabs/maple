import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { TwilioCostConnectionService } from "./TwilioCostConnectionService"
import {
	FAKE_TWILIO_SID,
	type FakeTwilio,
	fakeTwilioDeps,
	makeFakeTwilio,
} from "./providers/twilio/fake-twilio"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const USER = Schema.decodeSync(UserId)("user_cost")
const TOKEN = "S3cr3t-T0ken-0f-an-account"
const CREDENTIAL = `${FAKE_TWILIO_SID} ${TOKEN}`
const OTHER_TOKEN = "0ther-S3cr3t-T0ken-0f-an-account"
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-11T06:00:00Z"))
const VALIDATION = "@maple/http/cost-connections/CostConnectionValidationError"
const PERSISTENCE = "@maple/http/cost-connections/CostConnectionPersistenceError"

const run = <A, E>(
	testDb: TestDb,
	world: FakeTwilio,
	effect: Effect.Effect<A, E, TwilioCostConnectionService>,
) =>
	Effect.andThen(TestClock.setTime(NOW), effect).pipe(
		Effect.provide(
			Layer.effect(TwilioCostConnectionService, TwilioCostConnectionService.make).pipe(
				Layer.provide(fakeTwilioDeps(testDb, world)),
			),
		),
	)

const set = (credential: string) =>
	TwilioCostConnectionService.use((service) => service.set(ORG, USER, credential))
const remove = TwilioCostConnectionService.use((service) => service.remove(ORG))

interface Stored {
	readonly id: string
	readonly provider: string
	readonly secret_ciphertext: string
	readonly account_id: string
	readonly account_label: string
}

const storedCredential = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<Stored>(
			testDb,
			"SELECT id, provider, secret_ciphertext, account_id, account_label FROM cost_connections WHERE org_id = 'org_cost'",
		),
	)

const source = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ connection_ref: string; account_id: string; enabled: boolean }>(
			testDb,
			"SELECT connection_ref, account_id, enabled FROM cost_sources WHERE org_id = 'org_cost' AND provider = 'twilio'",
		),
	)

describe("TwilioCostConnectionService", () => {
	it.effect("checks the credential with Twilio, seals it and makes the cost source", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTwilio()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const saved = yield* set(`  ${CREDENTIAL}  `)
				assert.deepStrictEqual(saved, { accountId: FAKE_TWILIO_SID, accountLabel: "NevrLabs" })
				// The credentials travel in the Basic header of each call: the account, then one day of usage.
				const basic = `Basic ${Buffer.from(`${FAKE_TWILIO_SID}:${TOKEN}`).toString("base64")}`
				assert.deepStrictEqual(world.basics, [basic, basic])
				assert.deepStrictEqual(world.urls, [
					`/2010-04-01/Accounts/${FAKE_TWILIO_SID}.json`,
					`/2010-04-01/Accounts/${FAKE_TWILIO_SID}/Usage/Records/Daily.json?StartDate=2026-11-10&EndDate=2026-11-11&PageSize=1000&Page=0`,
				])

				const stored = yield* storedCredential(testDb)
				assert.isFalse(Str.includes(TOKEN)(stored?.secret_ciphertext ?? TOKEN))
				assert.deepStrictEqual(
					[stored?.provider, stored?.account_id, stored?.account_label],
					["twilio", FAKE_TWILIO_SID, "NevrLabs"],
				)
				const made = yield* source(testDb)
				assert.deepStrictEqual(
					[made?.connection_ref, made?.account_id, made?.enabled],
					[stored?.id, FAKE_TWILIO_SID, true],
				)
			}),
		)
	})

	it.effect("never sends text that is not an Account SID and a token", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTwilio()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const refusals = yield* Effect.forEach(
					[
						"",
						"   ",
						FAKE_TWILIO_SID,
						`${FAKE_TWILIO_SID} ${TOKEN} extra`,
						`ACshort ${TOKEN}`,
						`XX0123456789abcdef0123456789abcdef ${TOKEN}`,
						`${FAKE_TWILIO_SID} ${Str.repeat(600)("t")}`,
					],
					(text) => Effect.map(Effect.flip(set(text)), (error) => [error._tag, error.message]),
				)
				assert.deepStrictEqual(
					refusals,
					Arr.replicate(
						[
							VALIDATION,
							"Paste the account's Account SID (it starts with AC) and auth token together, separated by a space.",
						],
						7,
					),
				)
				assert.deepStrictEqual(world.basics, [])
			}),
		)
	})

	it.effect("refuses a credential Twilio rejects or that cannot read usage, and stores nothing", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTwilio()
		const refusedWith = (status: number, account = false) =>
			Effect.gen(function* () {
				// One refusal at a time: the step before it answers normally.
				world.status = account ? 200 : status
				world.accountStatus = account ? status : 200
				const error = yield* Effect.flip(set(CREDENTIAL))
				return [error._tag, error.message]
			})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* refusedWith(401, true), [
					VALIDATION,
					"Twilio rejected this Account SID or auth token. Copy both from the console's Account Info page.",
				])
				assert.include((yield* refusedWith(403))[1], "cannot read the account's usage records")
				assert.strictEqual((yield* refusedWith(400, true))[0], VALIDATION)
				// An outage or a limit says nothing about the credential: it is a retry, not a refusal.
				assert.deepStrictEqual(yield* refusedWith(503), [
					PERSISTENCE,
					"Could not check this credential with Twilio. Try again.",
				])
				assert.strictEqual((yield* refusedWith(429))[0], PERSISTENCE)
				assert.isUndefined(yield* storedCredential(testDb))
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect("keeps the connection when the credential is replaced, and refuses another account's", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTwilio()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(CREDENTIAL)
				const first = yield* storedCredential(testDb)
				const firstSource = yield* source(testDb)

				yield* set(`${FAKE_TWILIO_SID} ${OTHER_TOKEN}`)
				const replaced = yield* storedCredential(testDb)
				assert.strictEqual(replaced?.id, first?.id)
				assert.notStrictEqual(replaced?.secret_ciphertext, first?.secret_ciphertext)
				assert.deepStrictEqual(yield* source(testDb), firstSource)

				// Another account's records would overwrite the days the source already holds.
				world.accountSid = "AC" + "ffffffffffffffffffffffffffffffff"
				world.accountName = "Other"
				const refused = yield* Effect.flip(set(CREDENTIAL))
				assert.include(refused.message, "another Twilio account")
				assert.deepStrictEqual(yield* storedCredential(testDb), replaced)
			}),
		)
	})

	it.effect("removes the credential and its source together", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTwilio()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(CREDENTIAL)
				yield* remove
				assert.isUndefined(yield* storedCredential(testDb))
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})
})
