import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { MongodbCostConnectionService } from "../../MongodbCostConnectionService"
import {
	FAKE_ATLAS_INVOICES,
	FAKE_ATLAS_ORG,
	type FakeAtlas,
	fakeAtlasDeps,
	makeFakeAtlas,
} from "./fake-mongodb"
import { MongodbCostProvider } from "./MongodbCostProvider"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const USER = Schema.decodeSync(UserId)("user_cost")
const CLIENT_ID = "mdb_sa_0123456789abcdef"
const SECRET = "Secr3t-V4lue-0f-a-service-account"
const CREDENTIAL = `${CLIENT_ID} ${SECRET}`
const WINDOW = { startDay: "2026-10-20", endDay: "2026-11-10" }
/** The pull runs the morning after the window's last day. */
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-11T06:00:00Z"))
const [OCTOBER, NOVEMBER] = FAKE_ATLAS_INVOICES

const run = <A, E>(
	testDb: TestDb,
	world: FakeAtlas,
	effect: Effect.Effect<A, E, MongodbCostProvider | MongodbCostConnectionService>,
) =>
	effect.pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.effect(MongodbCostProvider, MongodbCostProvider.make),
				Layer.effect(MongodbCostConnectionService, MongodbCostConnectionService.make),
			).pipe(Layer.provide(fakeAtlasDeps(testDb, world))),
		),
	)

/** Saves `CREDENTIAL` for `ORG` and answers the connection's id, with the fake's call log emptied. */
const saveCredential = (testDb: TestDb, world: FakeAtlas) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		yield* MongodbCostConnectionService.use((service) => service.set(ORG, USER, CREDENTIAL))
		const row = yield* Effect.promise(() =>
			queryFirstRow<{ id: string }>(testDb, "SELECT id FROM cost_connections"),
		)
		world.urls.length = 0
		world.tokens.length = 0
		return row?.id ?? ""
	})

const pull = (orgId: OrgId, connectionRef: string, window = WINDOW) =>
	MongodbCostProvider.use((provider) => provider.pull({ orgId, connectionRef }, window))

const lineItems = `/api/atlas/v2/orgs/${FAKE_ATLAS_ORG}/invoices`
const search = `${lineItems}/${OCTOBER}/lineItems:search?itemsPerPage=500&pageNum=1`

describe("MongodbCostProvider", () => {
	it.effect("reads the window's invoices and bills each usage day to its cluster", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAtlas({
			lines: [
				{
					day: "2026-10-19",
					cents: 900,
					sku: "M10",
					project: "proj_a",
					cluster: "Cluster0",
					invoice: OCTOBER,
				},
				{
					day: "2026-10-20",
					cents: 150,
					sku: "M10 Atlas Data Transfer",
					project: "proj_a",
					cluster: "Cluster0",
					invoice: OCTOBER,
				},
				{
					day: "2026-10-31",
					cents: 200,
					sku: "M30 Storage",
					project: "proj_b",
					cluster: "Cluster0",
					invoice: OCTOBER,
				},
				{
					day: "2026-11-10",
					cents: 25,
					sku: "Atlas Support",
					project: null,
					cluster: null,
					invoice: NOVEMBER,
				},
			],
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveCredential(testDb, world)
				const pulled = yield* pull(ORG, connectionRef)
				assert.deepStrictEqual(world.urls, [
					// The invoice list reaches back a monthly invoice and forward past the open one.
					`${lineItems}?fromDate=2026-09-19&toDate=2027-12-15&itemsPerPage=100&pageNum=1`,
					search,
					`${lineItems}/${NOVEMBER}/lineItems:search?itemsPerPage=500&pageNum=1`,
				])
				// One token for the validation (1), one for the pull, which then serves its every read;
				// Atlas bills none of the requests.
				assert.strictEqual(world.basics.length, 2)
				assert.deepStrictEqual(world.tokens, Arr.replicate("token-2", 3))
				assert.strictEqual(pulled.requests, 0)
				assert.deepStrictEqual(
					Arr.map(pulled.rows, (row) => [
						row.day,
						row.cloudService,
						row.resourceId,
						row.billedCost,
						row.accountId,
						row.estimated,
					]),
					[
						[
							"2026-10-20",
							"M10 Atlas Data Transfer",
							"proj_a/Cluster0",
							1.5,
							FAKE_ATLAS_ORG,
							false,
						],
						["2026-10-31", "M30 Storage", "proj_b/Cluster0", 2, FAKE_ATLAS_ORG, false],
						["2026-11-10", "Atlas Support", "", 0.25, FAKE_ATLAS_ORG, true],
					],
				)
			}),
		)
	})

	it.effect("reads on past a full page of line items", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAtlas({
			// 1,200 lines of one invoice at 500 a page: three pages, the last short.
			lines: Arr.map(Arr.range(1, 1200), (n) => ({
				day: "2026-10-20",
				cents: 1,
				sku: `SKU-${n}`,
				project: "proj_a",
				cluster: "Cluster0",
				invoice: OCTOBER,
			})),
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveCredential(testDb, world)
				const pulled = yield* pull(ORG, connectionRef)
				assert.deepStrictEqual(
					Arr.map(
						Arr.filter(world.urls, (url) => Str.includes(`${OCTOBER}/lineItems`)(url)),
						(url) => Str.slice(Str.length(url) - 9)(url),
					),
					["pageNum=1", "pageNum=2", "pageNum=3"],
				)
				assert.lengthOf(pulled.rows, 1200)
			}),
		)
	})

	it.effect("replaces a token Atlas has retired once, and refuses one that stays rejected", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAtlas({
			lines: [
				{
					day: "2026-10-20",
					cents: 100,
					sku: "M10",
					project: "proj_a",
					cluster: "Cluster0",
					invoice: OCTOBER,
				},
			],
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveCredential(testDb, world)
				// The pull's first token (2; the validation's was 1) is one Atlas has retired.
				world.rejectTokens = new Set(["token-2"])
				const pulled = yield* pull(ORG, connectionRef)
				assert.lengthOf(pulled.rows, 1)
				// The refused read is repeated with a fresh token, not failed.
				assert.deepStrictEqual(world.tokens, ["token-2", "token-3", "token-3", "token-3"])
				assert.strictEqual(world.urls[0], world.urls[1])
			}),
		)
	})

	it.effect("says what the sync should do about each way Atlas refuses", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAtlas()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveCredential(testDb, world)
				const failures = yield* Effect.forEach([401, 403, 400, 429, 502], (status) =>
					Effect.gen(function* () {
						world.status = status
						const error = yield* Effect.flip(pull(ORG, connectionRef))
						return [error.reason, error.requests]
					}),
				)
				assert.deepStrictEqual(failures, [
					["auth", 0],
					["not_ready", 0],
					["upstream", 0],
					["rate_limited", 0],
					["upstream", 0],
				])
			}),
		)
	})

	it.effect("fails an answer it cannot read as invalid, with nothing to store", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAtlas()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveCredential(testDb, world)
				world.lines = "<html>maintenance</html>"
				assert.strictEqual((yield* Effect.flip(pull(ORG, connectionRef))).reason, "invalid_response")
				// A page without its results is not read as a window with no cost.
				world.lines = '{"totalCount": 3}'
				assert.strictEqual((yield* Effect.flip(pull(ORG, connectionRef))).reason, "invalid_response")
			}),
		)
	})

	it.effect("never reads a credential through another org's source, or a connection that is gone", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeAtlas()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* saveCredential(testDb, world)
				assert.strictEqual((yield* Effect.flip(pull(OTHER_ORG, connectionRef))).reason, "auth")
				assert.strictEqual((yield* Effect.flip(pull(ORG, "no-such-connection"))).reason, "auth")
				assert.deepStrictEqual(world.urls, [])
				assert.lengthOf(world.basics, 1)
			}),
		)
	})
})
