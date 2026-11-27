import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { MongodbCostConnectionService } from "./MongodbCostConnectionService"
import {
	FAKE_ATLAS_ORG,
	type FakeAtlas,
	fakeAtlasDeps,
	makeFakeAtlas,
} from "./providers/mongodb/fake-mongodb"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const USER = Schema.decodeSync(UserId)("user_cost")
const CLIENT_ID = "mdb_sa_0123456789abcdef"
const SECRET = "Secr3t-V4lue-0f-a-service-account"
const CREDENTIAL = `${CLIENT_ID} ${SECRET}`
const OTHER_SECRET = "0ther-Secr3t-0f-a-service-account"
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-11T06:00:00Z"))
const VALIDATION = "@maple/http/cost-connections/CostConnectionValidationError"
const PERSISTENCE = "@maple/http/cost-connections/CostConnectionPersistenceError"

const run = <A, E>(
	testDb: TestDb,
	world: FakeAtlas,
	effect: Effect.Effect<A, E, MongodbCostConnectionService>,
) =>
	Effect.andThen(TestClock.setTime(NOW), effect).pipe(
		Effect.provide(
			Layer.effect(MongodbCostConnectionService, MongodbCostConnectionService.make).pipe(
				Layer.provide(fakeAtlasDeps(testDb, world)),
			),
		),
	)

const set = (credential: string) =>
	MongodbCostConnectionService.use((service) => service.set(ORG, USER, credential))
const remove = MongodbCostConnectionService.use((service) => service.remove(ORG))

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
			"SELECT connection_ref, account_id, enabled FROM cost_sources WHERE org_id = 'org_cost' AND provider = 'mongodb'",
		),
	)

describe("MongodbCostConnectionService", () => {
	it.effect("checks the service account with Atlas, seals it and makes the cost source", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAtlas()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const saved = yield* set(`  ${CREDENTIAL}  `)
				assert.deepStrictEqual(saved, { accountId: FAKE_ATLAS_ORG, accountLabel: "NevrLabs" })
				// The credentials travel in the token request's Basic header, never in an API call.
				assert.deepStrictEqual(world.basics, [
					`Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`,
				])
				assert.deepStrictEqual(world.tokens, ["token-1", "token-1"])
				assert.deepStrictEqual(world.urls, [
					"/api/atlas/v2/orgs?itemsPerPage=100",
					`/api/atlas/v2/orgs/${FAKE_ATLAS_ORG}/invoices?fromDate=2026-10-11&toDate=2026-12-12&itemsPerPage=100&pageNum=1`,
				])

				const stored = yield* storedCredential(testDb)
				assert.isFalse(Str.includes(SECRET)(stored?.secret_ciphertext ?? SECRET))
				assert.deepStrictEqual(
					[stored?.provider, stored?.account_id, stored?.account_label],
					["mongodb", FAKE_ATLAS_ORG, "NevrLabs"],
				)
				const made = yield* source(testDb)
				assert.deepStrictEqual(
					[made?.connection_ref, made?.account_id, made?.enabled],
					[stored?.id, FAKE_ATLAS_ORG, true],
				)
			}),
		)
	})

	it.effect("never sends text that is not a client ID and a secret", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAtlas()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const refusals = yield* Effect.forEach(
					[
						"",
						"   ",
						CLIENT_ID,
						`${CLIENT_ID} ${SECRET} extra`,
						`${CLIENT_ID}\t${SECRET}\nmore`,
						`id ${Str.repeat(600)("s")}`,
					],
					(text) => Effect.map(Effect.flip(set(text)), (error) => [error._tag, error.message]),
				)
				assert.deepStrictEqual(
					refusals,
					Arr.replicate(
						[
							VALIDATION,
							"Paste the service account's client ID and secret together, separated by a space.",
						],
						6,
					),
				)
				assert.deepStrictEqual(world.basics, [])
			}),
		)
	})

	it.effect("refuses an account Atlas rejects or that cannot read invoices, and stores nothing", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAtlas()
		const refusedWith = (status: number, token = false) =>
			Effect.gen(function* () {
				// One refusal at a time: the step before it answers normally.
				world.status = token ? 200 : status
				world.tokenStatus = token ? status : 200
				const error = yield* Effect.flip(set(CREDENTIAL))
				return [error._tag, error.message]
			})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* refusedWith(401, true), [
					VALIDATION,
					"MongoDB Atlas rejected this service account. Create one in the organization's settings and paste its client ID and secret.",
				])
				assert.include((yield* refusedWith(403, true))[1], "API access list")
				assert.include((yield* refusedWith(403))[1], "Organization Billing Viewer role")
				assert.strictEqual((yield* refusedWith(400, true))[0], VALIDATION)
				// An outage or a limit says nothing about the account: it is a retry, not a refusal.
				assert.deepStrictEqual(yield* refusedWith(503), [
					PERSISTENCE,
					"Could not check this service account with MongoDB Atlas. Try again.",
				])
				assert.strictEqual((yield* refusedWith(429))[0], PERSISTENCE)
				assert.isUndefined(yield* storedCredential(testDb))
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect("refuses an account Atlas names no organization for, or more than one", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAtlas({ organizations: [] })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.include((yield* Effect.flip(set(CREDENTIAL))).message, "names no organization")
				world.organizations = [
					{ id: FAKE_ATLAS_ORG, name: "NevrLabs" },
					{ id: "68ffffffffffffffffffffff", name: "Other" },
				]
				assert.include((yield* Effect.flip(set(CREDENTIAL))).message, "more than one organization")
				assert.isUndefined(yield* storedCredential(testDb))
			}),
		)
	})

	it.effect("keeps the connection when the account is replaced, and refuses another organization's", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAtlas()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(CREDENTIAL)
				const first = yield* storedCredential(testDb)
				const firstSource = yield* source(testDb)

				yield* set(`${CLIENT_ID} ${OTHER_SECRET}`)
				const replaced = yield* storedCredential(testDb)
				assert.strictEqual(replaced?.id, first?.id)
				assert.notStrictEqual(replaced?.secret_ciphertext, first?.secret_ciphertext)
				assert.deepStrictEqual(yield* source(testDb), firstSource)

				// Another organization's invoices would overwrite the days the source already holds.
				world.organizations = [{ id: "68ffffffffffffffffffffff", name: "Other" }]
				const refused = yield* Effect.flip(set(CREDENTIAL))
				assert.include(refused.message, "another MongoDB Atlas organization")
				assert.deepStrictEqual(yield* storedCredential(testDb), replaced)
			}),
		)
	})

	it.effect("removes the service account and its source together", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAtlas()
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
