import { OrgId } from "@maple/domain"
import { rawSqlIssue } from "@maple/domain/raw-sql"
import { Array as Arr, Option, Result, Schema } from "effect"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../../contract"
import { NODES_SQL, PATRONI_SQL, POSITIONS_SQL, PRESENCE_SQL, RATES_SQL, SPARK_SQL, assembleSnapshot } from "../data"
import type { PostgresSnapshot } from "../model"
import { isDown, leadersByScope, orderedInstances, roleOf, versionLabel } from "../view-parts"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = 1_794_750_800_000
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

/** Raw-SQL rows as the warehouse returned them on 2026-11-15, after pg2 dropped out and pg3 took the lead. */
const node = (host: string, connections: number, lastSeenMs = NOW - 20_000) => ({
	host,
	connections,
	sizeBytes: 975_501_555,
	databases: 13,
	lastSeenMs,
	maxConnections: 100,
})
const patroni = (host: string, isPrimary: number, lastSeenMs = NOW - 30_000) => ({
	host,
	scope: "pg-cluster",
	isPrimary,
	isReplica: isPrimary === 1 ? 0 : 1,
	running: 1,
	streaming: 0,
	version: isPrimary === 1 ? 170009 : 170004,
	pendingRestart: 0,
	paused: 0,
	lastSeenMs,
})
const STALE = NOW - 55 * 60_000

const snapshot = (overrides: Partial<Parameters<typeof assembleSnapshot>[0]> = {}): PostgresSnapshot =>
	assembleSnapshot({
		nowMs: NOW,
		nodes: [node("pg1", 14), node("pg2", 21, STALE), node("pg3", 29)],
		patroni: [patroni("pg1", 0), { ...patroni("pg2", 1, STALE), version: 170009 }, patroni("pg3", 1)],
		positions: [
			{ host: "pg1", timeline: 84, walPosition: 0, replayPosition: 24_097_660_096 },
			{ host: "pg2", timeline: 84, walPosition: 24_097_644_032, replayPosition: 0 },
			{ host: "pg3", timeline: 85, walPosition: 24_110_181_584, replayPosition: 0 },
		],
		rates: [
			{ host: "pg3", tps: 10.19, rowWrites: 1.65, hits: 130_589, reads: 17, deadlocks: 0 },
			{ host: "pg1", tps: 0.99, rowWrites: 0, hits: 11_697, reads: 0, deadlocks: 0 },
		],
		sparks: [{ host: "pg3", spark: [14, 14, 21.3, 29.5, 28.5] }],
		...overrides,
	})

const loaded = (data: PostgresSnapshot): Model => {
	const entered = init({}, context)
	return pageUpdate(
		entered.model,
		Message.CompletedFetchSnapshot({ key: entered.model.snapshot.key ?? "", result: Result.succeed(data) }),
	).model
}

describe("postgres route", () => {
	test("every query passes the raw-SQL validator the warehouse applies", () => {
		for (const sql of [NODES_SQL, PATRONI_SQL, POSITIONS_SQL, RATES_SQL, SPARK_SQL, PRESENCE_SQL]) {
			expect(rawSqlIssue(sql)).toBeNull()
		}
	})

	test("a silent ex-leader is down and does not count: the scope still has exactly one live leader", () => {
		const data = snapshot()
		expect(Arr.map(data.instances, (n) => isDown(n, NOW))).toEqual([false, true, false])
		expect(leadersByScope(data).get("pg-cluster")).toBe(1)
		expect(Arr.map(orderedInstances(data), (n) => n.host)).toEqual(["pg2", "pg3", "pg1"])
	})

	test("replica lag is measured against the live leader, never the silent one", () => {
		const pg1 = Option.getOrUndefined(Arr.findFirst(snapshot().instances, (n) => n.host === "pg1"))
		expect(pg1?.lagBytes).toBe(24_110_181_584 - 24_097_660_096)
		expect(pg1?.cacheHit).toBe(1)
	})

	test("both leaders live is a split brain; none live is no leader", () => {
		const split = snapshot({ patroni: [patroni("pg1", 0), patroni("pg2", 1), patroni("pg3", 1)], nodes: [node("pg1", 1), node("pg2", 1), node("pg3", 1)] })
		expect(leadersByScope(split).get("pg-cluster")).toBe(2)
		const none = snapshot({ patroni: [patroni("pg1", 0), patroni("pg3", 0)], nodes: [node("pg1", 1), node("pg3", 1)] })
		expect(leadersByScope(none).get("pg-cluster")).toBe(0)
	})

	test("an instance without Patroni (RDS, a lone server) is standalone with no replication claim", () => {
		const data = snapshot({ nodes: [node("nexus-prod-v2.example.rds.amazonaws.com", 40)], patroni: [], positions: [] })
		const [only] = data.instances
		expect(only === undefined ? null : roleOf(only)).toBe("standalone")
		expect(only?.lagBytes).toBeNull()
	})

	test("server_version renders as the release", () => {
		expect([versionLabel(170009), versionLabel(180003), versionLabel(90624), versionLabel(0)]).toEqual(["17.9", "18.3", "9.6.24", "—"])
	})

	test("live: the rail names the down member, rows show roles and lag", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot())),
			expectView(text("pg2 down")).toExist(),
			expectView(text("Leader")).toExist(),
			expectView(text("Down · was leader")).toExist(),
			expectView(text("Replica")).toExist(),
			expectView(text("timeline 85")).toExist(),
		)
	})

	test("no instance in the window shows the setup state", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot({ nodes: [], patroni: [] }))),
			expectView(text("No PostgreSQL metrics in the last hour")).toExist(),
		)
	})
})
