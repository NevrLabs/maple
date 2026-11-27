import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { TwilioCostConnectionService } from "../../TwilioCostConnectionService"
import { FAKE_TWILIO_SID, type FakeTwilio, fakeTwilioDeps, makeFakeTwilio } from "./fake-twilio"
import { TwilioCostProvider } from "./TwilioCostProvider"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const USER = Schema.decodeSync(UserId)("user_cost")
const CREDENTIAL = `${FAKE_TWILIO_SID} S3cr3t-T0ken`
const WINDOW = { startDay: "2026-10-20", endDay: "2026-11-10" }
/** The pull runs the morning after the window's last day. */
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-11T06:00:00Z"))

const run = <A, E>(
	testDb: TestDb,
	world: FakeTwilio,
	effect: Effect.Effect<A, E, TwilioCostProvider | TwilioCostConnectionService>,
) =>
	effect.pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.effect(TwilioCostProvider, TwilioCostProvider.make),
				Layer.effect(TwilioCostConnectionService, TwilioCostConnectionService.make),
			).pipe(Layer.provide(fakeTwilioDeps(testDb, world))),
		),
	)

/** Saves `CREDENTIAL` for `ORG` and answers the connection's id, with the fake's call log emptied. */
const saveCredential = (testDb: TestDb, world: FakeTwilio) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		yield* TwilioCostConnectionService.use((service) => service.set(ORG, USER, CREDENTIAL))
		const row = yield* Effect.promise(() =>
			queryFirstRow<{ id: string }>(testDb, "SELECT id FROM cost_connections"),
		)
		world.urls.length = 0
		world.basics.length = 0
		return row?.id ?? ""
	})

const pull = (orgId: OrgId, connectionRef: string, window = WINDOW) =>
	TwilioCostProvider.use((provider) => provider.pull({ orgId, connectionRef }, window))

const usage = `/2010-04-01/Accounts/${FAKE_TWILIO_SID}/Usage/Records/Daily.json`

const RECORDED = [
	{ day: "2026-10-21", category: "sms", description: "Total SMS", cents: 720, count: 72 },
	{
		day: "2026-10-21",
		category: "calls",
		description: "Total Voice",
		cents: 1500,
		count: 3,
		countUnit: "calls",
	},
	// A subcategory and a summary repeat what their product categories carry.
	{ day: "2026-10-21", category: "sms-outbound", cents: 720 },
	{ day: "2026-10-21", category: "total", cents: 2220 },
	// Usage Twilio does not bill is not a charge.
	{ day: "2026-10-20", category: "phonenumbers", cents: 0 },
	// The window's last day is still open, and a day after it is not pulled.
	{ day: "2026-11-10", category: "sms", description: "Total SMS", cents: 100 },
	{ day: "2026-11-12", category: "sms", cents: 50 },
]

describe("TwilioCostProvider", () => {
	it.effect("reads the window's usage records and bills each day to its product category", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTwilio({ records: RECORDED })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveCredential(testDb, world)
				const pulled = yield* pull(ORG, connectionRef)
				assert.deepStrictEqual(world.urls, [
					`${usage}?StartDate=2026-10-20&EndDate=2026-11-10&PageSize=1000&Page=0`,
				])
				assert.strictEqual(world.basics.length, 1)
				assert.deepStrictEqual(
					Arr.map(pulled.rows, (row) => [
						row.day,
						row.accountId,
						row.cloudService,
						row.usageType,
						row.billedCost,
						row.consumedQuantity,
						row.consumedUnit,
						row.currency,
						row.estimated,
					]),
					[
						[
							"2026-10-21",
							FAKE_TWILIO_SID,
							"Total SMS",
							"sms",
							7.2,
							72,
							"messages",
							"USD",
							false,
						],
						["2026-10-21", FAKE_TWILIO_SID, "Total Voice", "calls", 15, 3, "calls", "USD", false],
						["2026-11-10", FAKE_TWILIO_SID, "Total SMS", "sms", 1, 1, "messages", "USD", true],
					],
				)
				assert.deepStrictEqual(
					[
						pulled.requests,
						pulled.rows[0]?.serviceCategory,
						pulled.rows[0]?.basis,
						pulled.rows[0]?.region,
					],
					[0, "Communication", "billed", "global"],
				)
			}),
		)
	})

	it.effect("reads on past a full page", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTwilio({ records: Arr.take(RECORDED, 5), pageSize: 2 })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveCredential(testDb, world)
				const pulled = yield* pull(ORG, connectionRef)
				assert.deepStrictEqual(
					Arr.map(world.urls, (url) => Str.replace(`${usage}?`, "")(url)),
					[
						"StartDate=2026-10-20&EndDate=2026-11-10&PageSize=1000&Page=0",
						"StartDate=2026-10-20&EndDate=2026-11-10&PageSize=1000&Page=1",
						"StartDate=2026-10-20&EndDate=2026-11-10&PageSize=1000&Page=2",
					],
				)
				assert.strictEqual(pulled.rows.length, 2)
			}),
		)
	})

	it.effect("says what the sync should do about each way Twilio refuses", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTwilio()
		let connectionRef = ""
		const reasonOf = (status: number) =>
			Effect.gen(function* () {
				world.status = status
				const error = yield* Effect.flip(pull(ORG, connectionRef))
				return [error.reason, error.requests]
			})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				connectionRef = yield* saveCredential(testDb, world)
				assert.deepStrictEqual(yield* reasonOf(401), ["auth", 0])
				assert.deepStrictEqual(yield* reasonOf(403), ["not_ready", 0])
				assert.deepStrictEqual(yield* reasonOf(429), ["rate_limited", 0])
				assert.deepStrictEqual(yield* reasonOf(503), ["upstream", 0])
				// A 400 is Maple's request, not Twilio's: nothing a retry fixes.
				assert.deepStrictEqual(yield* reasonOf(400), ["upstream", 0])
				world.status = 200
				world.records = "<html>Not JSON</html>"
				assert.strictEqual((yield* Effect.flip(pull(ORG, connectionRef))).reason, "invalid_response")
			}),
		)
	})

	it.effect("never reads a credential through another org's source", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTwilio({ records: RECORDED })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveCredential(testDb, world)
				const error = yield* Effect.flip(pull(OTHER_ORG, connectionRef))
				assert.deepStrictEqual([error.reason, world.basics.length], ["auth", 0])
			}),
		)
	})
})
