import { OrgId } from "@maple/domain"
import { rawSqlIssue } from "@maple/domain/raw-sql"
import { Array as Arr, Option, Result, Schema } from "effect"
import { expect as expectView, given, inside, scene, selector, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../../contract"
import { NODES_SQL, PRESENCE_SQL, RATES_SQL, SPARK_SQL, assembleSnapshot } from "../data"
import type { AtlasSnapshot } from "../model"
import { clusterSubline, clustersOf, isDown, orderedNodes, shortName } from "../view-parts"
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
const qaHost = (n: number) => `noov-mongodb-qa-shard-00-0${n}-pri.9k2xq1.mongodb.net:27018`
const shardOneHost = "noov-mongodb-live-shard-01-00-pri.l2mydt.mongodb.net:27018"

/** The labels Atlas's Prometheus integration sends, shaped like a real cluster's (read off the warehouse,
 * 2026-11-26). The organization and project ids and the project name are made up: this repository is public. */
const LIVE = {
	orgId: "5f8a2c41d9e7b3601c4a7b2d",
	projectId: "7d31e9b4c0a5f286d1e3b9a7",
	project: "production",
	cluster: "noov-mongodb-live",
	provider: "AWS",
	region: "ap-southeast-1",
} as const

/** Raw-SQL rows as the API returns them: `rs_state` is a string attribute, counters already rates. */
const nodeRow = (n: number, state: string, lastSeenMs = NOW - 10_000) => ({
	host: host(n),
	...LIVE,
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

/** A second project's cluster under the same organization. */
const qaRow = (n: number, state: string, lastSeenMs = NOW - 10_000) => ({
	...nodeRow(n, state, lastSeenMs),
	host: qaHost(n),
	projectId: "5b1d0c73a2f4e67890123456",
	project: "qa",
	cluster: "noov-mongodb-qa",
	replicaSet: "atlas-9k2xq1-shard-0",
})

const snapshot = (overrides: Partial<Parameters<typeof assembleSnapshot>[0]> = {}): AtlasSnapshot =>
	assembleSnapshot({
		nowMs: NOW,
		nodes: [nodeRow(0, "2"), nodeRow(1, "1"), nodeRow(2, "2")],
		rates: [
			{
				host: host(1),
				op_query: 7.6,
				op_insert: 1.5,
				op_update: 2.2,
				op_delete: 0.9,
				op_getmore: 24,
				op_command: 53.4,
				asserts: 0.99,
			},
		],
		sparks: [{ host: host(1), spark: [178, 185, 171, 191, 170] }],
		...overrides,
	})

const loaded = (data: AtlasSnapshot): Model => {
	const entered = init({}, context)
	return pageUpdate(
		entered.model,
		Message.CompletedFetchSnapshot({
			key: entered.model.snapshot.key ?? "",
			result: Result.succeed(data),
		}),
	).model
}

const liveRow = selector('[data-atlas-section="clusters"] [data-atlas-cluster="noov-mongodb-live"]')

describe("atlas route", () => {
	test("every query passes the raw-SQL validator the warehouse applies", () => {
		for (const sql of [NODES_SQL, RATES_SQL, SPARK_SQL, PRESENCE_SQL]) expect(rawSqlIssue(sql)).toBeNull()
	})

	test("raw-SQL rows join per member; a member without rates reads zero, not missing", () => {
		const data = snapshot()
		const member = (hostOf: string) =>
			Option.getOrUndefined(Arr.findFirst(data.nodes, (node) => node.host === hostOf))
		expect(member(host(1))).toMatchObject({
			orgId: "5f8a2c41d9e7b3601c4a7b2d",
			projectId: "7d31e9b4c0a5f286d1e3b9a7",
			project: "production",
			cluster: "noov-mongodb-live",
			provider: "AWS",
			region: "ap-southeast-1",
			state: 1,
			ops: { command: 53.4, getmore: 24 },
			asserts: 0.99,
			connectionsSpark: [178, 185, 171, 191, 170],
		})
		expect(member(host(0))).toMatchObject({ state: 2, ops: { command: 0 }, connectionsSpark: [] })
	})

	test("a label a scrape did not send reads empty, never null or undefined", () => {
		const { nodes } = assembleSnapshot({
			nowMs: NOW,
			nodes: [{ ...nodeRow(2, "2"), project: null, region: undefined, replicaSet: null }],
			rates: [],
			sparks: [],
		})
		expect(nodes[0]).toMatchObject({ project: "", region: "", replicaSet: "" })
	})

	test("primary first; names drop the private-endpoint -pri, not the role", () => {
		expect(Arr.map(orderedNodes(snapshot()), shortName)).toEqual([
			"shard-00-01",
			"shard-00-00",
			"shard-00-02",
		])
	})

	test("members group into clusters by project, then cluster; a nameless cluster reads as its replica set", () => {
		const data = snapshot({
			nodes: [
				nodeRow(0, "2"),
				nodeRow(1, "1"),
				nodeRow(2, "2"),
				{ ...nodeRow(0, "2"), host: shardOneHost, replicaSet: "atlas-6fng94-shard-1" },
				qaRow(0, "1"),
				qaRow(1, "2"),
				{
					...nodeRow(1, "2"),
					host: "analyst-01-pri.l2mydt.mongodb.net:27018",
					cluster: "",
					replicaSet: "",
				},
			],
		})
		const clusters = clustersOf(data)
		expect(Arr.map(clusters, (cluster) => [cluster.project, cluster.name])).toEqual([
			["production", "analyst-01-pri.l2mydt.mongodb.net:27018"],
			["production", "noov-mongodb-live"],
			["qa", "noov-mongodb-qa"],
		])
		expect(
			Arr.map(clusters, (cluster) => [cluster.replicaSets, Arr.map(cluster.nodes, shortName)]),
		).toEqual([
			[[], ["analyst-01"]],
			[
				["atlas-6fng94-shard-0", "atlas-6fng94-shard-1"],
				["shard-00-01", "shard-00-00", "shard-00-02", "shard-01-00"],
			],
			[["atlas-9k2xq1-shard-0"], ["shard-00-00", "shard-00-01"]],
		])
		// The subline counts replica sets only: Atlas numbers every set `shard-N`, sharded or not.
		expect(Arr.map(clusters, clusterSubline)).toEqual([
			"",
			"2 replica sets: atlas-6fng94-shard-0, atlas-6fng94-shard-1",
			"atlas-9k2xq1-shard-0",
		])
	})

	test("live: the cluster table names the project, replica set and region; members sit under their cluster with their role", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot())),
			expectView(
				text("production · noov-mongodb-live · 3 members · Prometheus integration, every 30 s"),
			).toExist(),
			expectView(liveRow).toHaveAttr("data-atlas-cluster-state", "ok"),
			expectView(text("atlas-6fng94-shard-0")).toExist(),
			expectView(text("7d31e9b4c0a5f286d1e3b9a7")).toExist(),
			expectView(text("AWS ap-southeast-1")).toExist(),
			expectView(text("Primaries")).toExist(),
			expectView(text("1 primary")).toExist(),
			inside(
				selector('[data-atlas-section="members"]'),
				expectView(text("production")).toExist(),
				expectView(text("shard-00-01")).toExist(),
				expectView(text("shard-00-00")).toExist(),
			),
			inside(selector('[data-atlas-node="shard-00-01"]'), expectView(text("Primary")).toExist()),
			inside(selector('[data-atlas-node="shard-00-00"]'), expectView(text("Secondary")).toExist()),
		)
	})

	test("several projects: the description counts them and each cluster's section names its own project", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot({ nodes: [nodeRow(1, "1"), nodeRow(2, "2"), qaRow(0, "1")] }))),
			expectView(
				text("2 projects · 2 clusters · 3 members · Prometheus integration, every 30 s"),
			).toExist(),
			expectView(text("5b1d0c73a2f4e67890123456")).toExist(),
			expectView(text("each with a primary")).toExist(),
			inside(
				selector('[data-atlas-section="members"][data-atlas-cluster="noov-mongodb-qa"]'),
				expectView(text("qa")).toExist(),
			),
			inside(
				selector('[data-atlas-section="members"][data-atlas-cluster="noov-mongodb-live"]'),
				expectView(text("production")).toExist(),
			),
		)
	})

	test("a member silent for two minutes is down: the rail names it, the row says for how long", () => {
		const data = snapshot({
			nodes: [nodeRow(0, "2", NOW - 5 * 60_000), nodeRow(1, "1"), nodeRow(2, "2")],
		})
		expect(Arr.map(data.nodes, (node) => isDown(node, NOW))).toEqual([true, false, false])
		scene(
			{ update: pageUpdate, view },
			given(loaded(data)),
			expectView(text("shard-00-00 down")).toExist(),
			expectView(text("silent 5m")).toExist(),
		)
	})

	test("with several clusters the tile counts the down members and names their cluster; that cluster's row turns critical", () => {
		const data = snapshot({
			nodes: [nodeRow(1, "1"), qaRow(0, "1", NOW - 5 * 60_000), qaRow(1, "2")],
		})
		scene(
			{ update: pageUpdate, view },
			given(loaded(data)),
			expectView(text("1 down in noov-mongodb-qa")).toExist(),
			expectView(text("2/3")).toExist(),
			expectView(text("1/2")).toExist(),
			expectView(liveRow).toHaveAttr("data-atlas-cluster-state", "ok"),
			expectView(
				selector('[data-atlas-section="clusters"] [data-atlas-cluster="noov-mongodb-qa"]'),
			).toHaveAttr("data-atlas-cluster-state", "crit"),
		)
	})

	test("every member up and none primary: the row is critical and reads degraded, not members down", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot({ nodes: [nodeRow(0, "2"), nodeRow(1, "2"), nodeRow(2, "2")] }))),
			expectView(text("3/3")).toExist(),
			expectView(text("no primary")).toExist(),
			expectView(liveRow).toHaveAttr("data-atlas-cluster-state", "crit"),
			expectView(selector('[data-atlas-section="clusters"] [aria-label="degraded"]')).toExist(),
		)
	})

	test("two members reporting primary in one replica set is not healthy; the tile reports the count, not a fault", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot({ nodes: [nodeRow(0, "1"), nodeRow(1, "1"), nodeRow(2, "2")] }))),
			expectView(text("2 report primary")).toExist(),
			expectView(liveRow).toHaveAttr("data-atlas-cluster-state", "crit"),
		)
	})

	test("a cluster with one primary in each of two replica sets is healthy", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				loaded(
					snapshot({
						nodes: [
							nodeRow(0, "2"),
							nodeRow(1, "1"),
							{ ...nodeRow(0, "1"), host: shardOneHost, replicaSet: "atlas-6fng94-shard-1" },
						],
					}),
				),
			),
			expectView(text("2 primaries")).toExist(),
			expectView(text("2 replica sets: atlas-6fng94-shard-0, atlas-6fng94-shard-1")).toExist(),
			expectView(liveRow).toHaveAttr("data-atlas-cluster-state", "ok"),
		)
	})

	test("two replica sets and both primaries in the first: critical, and the tile names the set without one", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				loaded(
					snapshot({
						nodes: [
							nodeRow(0, "1"),
							nodeRow(1, "1"),
							{ ...nodeRow(0, "2"), host: shardOneHost, replicaSet: "atlas-6fng94-shard-1" },
						],
					}),
				),
			),
			expectView(text("a replica set without a primary")).toExist(),
			expectView(liveRow).toHaveAttr("data-atlas-cluster-state", "crit"),
		)
	})

	test("a live member outside its set makes the cluster degraded, not healthy and not members down", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot({ nodes: [nodeRow(0, "7"), nodeRow(1, "1"), nodeRow(2, "2")] }))),
			expectView(text("3/3")).toExist(),
			expectView(text("a member out of its set")).toExist(),
			expectView(liveRow).toHaveAttr("data-atlas-cluster-state", "crit"),
			expectView(selector('[data-atlas-section="clusters"] [aria-label="degraded"]')).toExist(),
			inside(selector('[data-atlas-node="shard-00-00"]'), expectView(text("Not in set")).toExist()),
		)
	})

	test("with several clusters the tile counts the ones without a primary, or otherwise not healthy", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot({ nodes: [nodeRow(0, "2"), nodeRow(1, "2"), qaRow(0, "1")] }))),
			expectView(text("1 cluster without a primary")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot({ nodes: [nodeRow(0, "7"), nodeRow(1, "1"), qaRow(0, "1")] }))),
			expectView(text("1 cluster not healthy")).toExist(),
		)
	})

	test("no member in the window shows the setup state", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot({ nodes: [] }))),
			expectView(text("No MongoDB Atlas metrics in the last hour")).toExist(),
		)
	})
})
