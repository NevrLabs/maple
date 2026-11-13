import { OrgId } from "@maple/domain"
import { rawSqlIssue } from "@maple/domain/raw-sql"
import { Result, Schema } from "effect"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../../contract"
import { NODES_SQL, PRESENCE_SQL, RATES_SQL, SPARK_SQL, assembleSnapshot } from "../data"
import type { AtlasSnapshot } from "../model"
import { isDown, orderedNodes, shortName } from "../view-parts"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = 1_794_560_000_000

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const host = (n: number) => `noov-mongodb-live-shard-00-0${n}-pri.l2mydt.mongodb.net:27018`

/** Raw-SQL rows as the API returns them: `rs_state` is a string attribute, counters already rates. */
const nodeRow = (n: number, state: string, lastSeenMs = NOW - 10_000) => ({
	host: host(n),
	cluster: "noov-mongodb-live",
	replicaSet: "atlas-6fng94-shard-0",
	zone: `apse1-az${n + 1}`,
	state,
	up: 1,
	connections: 150 + n,
	connectionsFree: 2849 - n,
	queue: 0,
	residentMiB: 2733,
	cacheBytes: 2147483648,
	oplogBytes: 3394596864,
	oplogMaxBytes: 6335496192,
	lastSeenMs,
})

const snapshot = (overrides: Partial<Parameters<typeof assembleSnapshot>[0]> = {}): AtlasSnapshot =>
	assembleSnapshot({
		nowMs: NOW,
		nodes: [nodeRow(0, "2"), nodeRow(1, "1"), nodeRow(2, "2")],
		rates: [{ host: host(1), op_query: 7.6, op_insert: 1.5, op_update: 2.2, op_delete: 0.9, op_getmore: 24, op_command: 53.4, asserts: 0.99 }],
		sparks: [{ host: host(1), spark: [178, 185, 171, 191, 170] }],
		...overrides,
	})

const loaded = (data: AtlasSnapshot): Model => {
	const entered = init({}, context)
	return pageUpdate(
		entered.model,
		Message.CompletedFetchSnapshot({ key: entered.model.snapshot.key ?? "", result: Result.succeed(data) }),
	).model
}

describe("atlas route", () => {
	test("every query passes the raw-SQL validator the warehouse applies", () => {
		for (const sql of [NODES_SQL, RATES_SQL, SPARK_SQL, PRESENCE_SQL]) expect(rawSqlIssue(sql)).toBeNull()
	})

	test("raw-SQL rows join per member; a member without rates reads zero, not missing", () => {
		const data = snapshot()
		const primary = data.nodes.find((node) => node.host === host(1))
		expect(primary).toMatchObject({ state: 1, ops: { command: 53.4, getmore: 24 }, asserts: 0.99, connectionsSpark: [178, 185, 171, 191, 170] })
		expect(data.nodes.find((node) => node.host === host(0))).toMatchObject({ state: 2, ops: { command: 0 }, connectionsSpark: [] })
	})

	test("primary first; names drop the private-endpoint -pri, not the role", () => {
		expect(orderedNodes(snapshot()).map(shortName)).toEqual(["shard-00-01", "shard-00-00", "shard-00-02"])
	})

	test("live: rail, members and roles render", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot())),
			expectView(text("noov-mongodb-live · atlas-6fng94-shard-0 · 3 members · Prometheus integration, every 30 s")).toExist(),
			expectView(text("1 primary")).toExist(),
			expectView(text("Primary")).toExist(),
		)
	})

	test("a member silent for two minutes is down: the rail names it, the row says for how long", () => {
		const data = snapshot({ nodes: [nodeRow(0, "2", NOW - 5 * 60_000), nodeRow(1, "1"), nodeRow(2, "2")] })
		expect(data.nodes.map((node) => isDown(node, NOW))).toEqual([true, false, false])
		scene({ update: pageUpdate, view }, given(loaded(data)), expectView(text("shard-00-00 down")).toExist(), expectView(text("silent 5m")).toExist())
	})

	test("no member in the window shows the setup state", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot({ nodes: [] }))),
			expectView(text("No MongoDB Atlas metrics in the last hour")).toExist(),
		)
	})
})
