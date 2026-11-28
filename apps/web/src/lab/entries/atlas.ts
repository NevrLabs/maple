import { Array as Arr, Effect, Schema } from "effect"
import type { Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { vstack } from "@maple/views/ui/stack"
import { assembleSnapshot } from "../../page/infra-integrations/atlas/data"
import type { AtlasSnapshot } from "../../page/infra-integrations/atlas/model"
import {
	atlasBody,
	atlasDescription,
	atlasEmptyBody,
	atlasLoadingBody,
} from "../../page/infra-integrations/atlas/view-parts"
import { dashboardPage } from "../../page/kit/dashboard-page"
import type { Resources } from "../../platform/resources"
import { defineShellLab } from "../shell-lab"

// `/lab/atlas`: the `/infra/atlas` view over a real cluster's raw-SQL rows of 2026-11-27, with the
// organization and project ids and the project name replaced.
// `?state=live|multi|offline|degraded|empty|loading`: `multi` adds a made-up second project and
// cluster, `offline` silences the cluster's primary, `degraded` puts one member into recovery.

const NOW = 1795720886521
const ROWS = {
	nowMs: 1795720886521,
	nodes: [
		{
			host: "noov-mongodb-live-shard-00-00-pri.l2mydt.mongodb.net:27018",
			orgId: "5f8a2c41d9e7b3601c4a7b2d",
			projectId: "7d31e9b4c0a5f286d1e3b9a7",
			project: "production",
			cluster: "noov-mongodb-live",
			replicaSet: "atlas-6fng94-shard-0",
			provider: "AWS",
			region: "ap-southeast-1",
			zone: "apse1-az2",
			state: "2",
			up: 1,
			connections: 171,
			connectionsFree: 2829,
			queue: 0,
			residentMiB: 2739,
			cacheBytes: 2147483648,
			oplogBytes: 3621912576,
			oplogMaxBytes: 6335496192,
			lastSeenMs: 1795720844231,
		},
		{
			host: "noov-mongodb-live-shard-00-01-pri.l2mydt.mongodb.net:27018",
			orgId: "5f8a2c41d9e7b3601c4a7b2d",
			projectId: "7d31e9b4c0a5f286d1e3b9a7",
			project: "production",
			cluster: "noov-mongodb-live",
			replicaSet: "atlas-6fng94-shard-0",
			provider: "AWS",
			region: "ap-southeast-1",
			zone: "apse1-az3",
			state: "2",
			up: 1,
			connections: 176,
			connectionsFree: 2824,
			queue: 0,
			residentMiB: 2786,
			cacheBytes: 2147483648,
			oplogBytes: 2951761920,
			oplogMaxBytes: 6335496192,
			lastSeenMs: 1795720844067,
		},
		{
			host: "noov-mongodb-live-shard-00-02-pri.l2mydt.mongodb.net:27018",
			orgId: "5f8a2c41d9e7b3601c4a7b2d",
			projectId: "7d31e9b4c0a5f286d1e3b9a7",
			project: "production",
			cluster: "noov-mongodb-live",
			replicaSet: "atlas-6fng94-shard-0",
			provider: "AWS",
			region: "ap-southeast-1",
			zone: "apse1-az1",
			state: "1",
			up: 1,
			connections: 202,
			connectionsFree: 2798,
			queue: 0,
			residentMiB: 2642,
			cacheBytes: 2147483648,
			oplogBytes: 2882039808,
			oplogMaxBytes: 6335496192,
			lastSeenMs: 1795720871568,
		},
	],
	rates: [
		{
			host: "noov-mongodb-live-shard-00-01-pri.l2mydt.mongodb.net:27018",
			op_query: 1.9988095238095238,
			op_insert: 0,
			op_update: 0.04523809523809524,
			op_delete: 0,
			op_getmore: 4.070238095238095,
			op_command: 30.058333333333334,
			asserts: 1.3202380952380952,
		},
		{
			host: "noov-mongodb-live-shard-00-02-pri.l2mydt.mongodb.net:27018",
			op_query: 8.517241379310345,
			op_insert: 1.1183908045977011,
			op_update: 2.0977011494252875,
			op_delete: 0.7206896551724138,
			op_getmore: 19.844827586206897,
			op_command: 50.9264367816092,
			asserts: 1.3482758620689654,
		},
		{
			host: "noov-mongodb-live-shard-00-00-pri.l2mydt.mongodb.net:27018",
			op_query: 2.001190476190476,
			op_insert: 0,
			op_update: 0.04523809523809524,
			op_delete: 0,
			op_getmore: 4.385714285714286,
			op_command: 29.554761904761904,
			asserts: 1.3273809523809523,
		},
	],
	sparks: [
		{
			host: "noov-mongodb-live-shard-00-01-pri.l2mydt.mongodb.net:27018",
			spark: [
				177.1, 176.2, 175.5, 175.2, 175.4, 175.3, 175.2, 175.2, 175.3, 175.2, 175, 175.1, 175.1,
				175.1, 175.2, 175.1, 175.4, 175.1, 175.1, 175.6, 175.2, 175.4, 175.1, 175.4, 175.5,
			],
		},
		{
			host: "noov-mongodb-live-shard-00-02-pri.l2mydt.mongodb.net:27018",
			spark: [
				203.2, 202, 201.2, 201.1, 201, 201, 201, 201.1, 201, 201, 201, 201.1, 201, 201.1, 201, 201.1,
				201, 201, 201, 201.1, 201.1, 201.1, 201, 201.2, 201.1,
			],
		},
		{
			host: "noov-mongodb-live-shard-00-00-pri.l2mydt.mongodb.net:27018",
			spark: [
				173.1, 172.1, 171.1, 171.4, 171.3, 171.2, 171.5, 171.1, 171.1, 171.4, 171, 171, 171.3, 171.3,
				171, 171.1, 171.5, 171.3, 171.2, 171.4, 171.3, 171.3, 171.1, 171.1, 171.2,
			],
		},
	],
}

type Row = (typeof ROWS)["nodes"][number]
type Rate = (typeof ROWS)["rates"][number]

const STATES = ["live", "multi", "offline", "degraded", "empty", "loading"] as const
const State = Schema.Literals(STATES)
const Model = Schema.Struct({ state: State })
type Model = typeof Model.Type
const Message = defineMessageUnion({ Noop: {} })
type Message = typeof Message.Type
const Flags = Schema.Struct({ state: State })

const flags = Effect.sync(() => {
	const state = new URL(location.href).searchParams.get("state")
	return { state: Schema.is(State)(state) ? state : "live" } as const
})

/** Not real: a second project under the same organization, so the page has more than one cluster to group. */
const QA_HOST = (n: number) => `noov-mongodb-qa-shard-00-0${n}-pri.9k2xq1.mongodb.net:27018`
const qa = (n: number, over: Partial<Row>): Row => ({
	host: QA_HOST(n),
	orgId: "5f8a2c41d9e7b3601c4a7b2d",
	projectId: "5b1d0c73a2f4e67890123456",
	project: "qa",
	cluster: "noov-mongodb-qa",
	replicaSet: "atlas-9k2xq1-shard-0",
	provider: "AWS",
	region: "ap-southeast-1",
	zone: `apse1-az${n + 1}`,
	state: "2",
	up: 1,
	connections: 41 + n,
	connectionsFree: 2958 - n,
	queue: 0,
	residentMiB: 912,
	cacheBytes: 1073741824,
	oplogBytes: 1927483648,
	oplogMaxBytes: 3174515712,
	lastSeenMs: NOW - 10_000,
	...over,
})
const QA_RATES: ReadonlyArray<Rate> = Arr.map([0, 1, 2], (n) => ({
	host: QA_HOST(n),
	op_query: 1.2,
	op_insert: 0,
	op_update: 0.3,
	op_delete: 0,
	op_getmore: 2.1,
	op_command: 11.4,
	asserts: 0.02,
}))

const snapshot = (state: Model["state"]): AtlasSnapshot =>
	assembleSnapshot(
		state === "multi"
			? {
					...ROWS,
					nodes: [
						...ROWS.nodes,
						qa(0, { state: "1" }),
						qa(1, { lastSeenMs: NOW - 5 * 60_000 }),
						qa(2, {}),
					],
					rates: [...ROWS.rates, ...QA_RATES],
				}
			: state === "offline"
				? {
						...ROWS,
						nodes: Arr.map(ROWS.nodes, (row) =>
							row.state === "1" ? { ...row, lastSeenMs: NOW - 5 * 60_000 } : row,
						),
					}
				: state === "degraded"
					? {
							...ROWS,
							nodes: Arr.map(ROWS.nodes, (row, index) =>
								index === 0 ? { ...row, state: "3" } : row,
							),
						}
					: state === "empty"
						? { ...ROWS, nodes: [] }
						: ROWS,
	)

const view = (model: Model, h: HtmlBuilder<Message>): Html => {
	const data = snapshot(model.state)
	const body =
		model.state === "loading"
			? atlasLoadingBody(h)
			: data.nodes.length === 0
				? atlasEmptyBody(h)
				: atlasBody(h, data)
	return dashboardPage(h, { title: "MongoDB Atlas", description: atlasDescription(data), gap: "lg" }, [
		vstack(h, { gap: "8" }, body),
	])
}

export const lab = defineShellLab("MongoDB Atlas", {
	Model,
	Message,
	Flags,
	flags,
	init: (f): Update.Return<Model, Message, Resources> => ({ model: f }),
	update: (model) => ({ model }),
	view,
	currentPath: "/infra/atlas",
	breadcrumbs: [{ label: "Infrastructure" }, { label: "MongoDB Atlas" }],
})
