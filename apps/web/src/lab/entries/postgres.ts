import { Array as Arr, Effect, Schema } from "effect"
import type { Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { assembleSnapshot } from "../../page/infra-integrations/postgres/data"
import {
	postgresBody,
	postgresDescription,
	postgresEmptyBody,
	postgresLoadingBody,
} from "../../page/infra-integrations/postgres/view-parts"
import { dashboardPage } from "../../page/kit/dashboard-page"
import type { Resources } from "../../platform/resources"
import { defineShellLab } from "../shell-lab"

// `/lab/postgres`: the `/infra/postgres` view over the homelab Patroni cluster's raw-SQL rows of 2026-11-15
// (pg2 silent after a failover, pg3 leading). `?state=live|healthy|loading|empty`.

const NOW = 1794750800000
const STALE = NOW - 55 * 60_000
const node = (host: string, connections: number, sizeBytes: number, lastSeenMs = NOW - 20_000) => ({
	host,
	connections,
	sizeBytes,
	databases: 13,
	lastSeenMs,
	maxConnections: 100,
})
const patroni = (host: string, isPrimary: number, version: number, lastSeenMs = NOW - 30_000) => ({
	host,
	scope: "pg-cluster",
	isPrimary,
	isReplica: isPrimary === 1 ? 0 : 1,
	running: 1,
	streaming: 0,
	version,
	pendingRestart: 0,
	paused: 0,
	lastSeenMs,
})
const ROWS = {
	nowMs: NOW,
	nodes: [node("pg1", 14, 975501555), node("pg2", 21, 976627479, STALE), node("pg3", 29, 976103191)],
	patroni: [patroni("pg1", 0, 170004), patroni("pg2", 1, 170009, STALE), patroni("pg3", 1, 170009)],
	positions: [
		{ host: "pg1", timeline: 84, walPosition: 0, replayPosition: 24097660096 },
		{ host: "pg2", timeline: 84, walPosition: 24097644032, replayPosition: 0 },
		{ host: "pg3", timeline: 85, walPosition: 24110181584, replayPosition: 0 },
	],
	rates: [
		{ host: "pg3", tps: 10.19, rowWrites: 1.65, hits: 130589, reads: 17, deadlocks: 0 },
		{ host: "pg1", tps: 0.99, rowWrites: 0, hits: 11697, reads: 0, deadlocks: 0 },
		{ host: "pg2", tps: 7.4, rowWrites: 1.1, hits: 98000, reads: 40, deadlocks: 0 },
	],
	sparks: [
		{ host: "pg3", spark: [14, 14, 14.1, 14, 14, 14, 14, 14, 14, 14, 14.1, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 21.3, 29.5, 30.6, 28.5] },
		{ host: "pg2", spark: [21.5, 21.1, 22.5, 22.3, 21.7, 21.3, 22.2, 21.4, 21.3, 21.5, 22.1, 21.5, 22.3, 22.1, 22.4, 21.9, 22.1, 22.7, 22.2, 25.7, 23.2] },
		{ host: "pg1", spark: [14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14] },
	],
	// One standalone instance, as an RDS or single server reports without Patroni.
} as const
const STANDALONE = { ...node("nexus-prod-v2.rds", 42, 61_400_000_000), databases: 4, maxConnections: 1600 }

const STATES = ["live", "healthy", "loading", "empty"] as const
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

const snapshot = (state: Model["state"]) =>
	assembleSnapshot(
		state === "healthy"
			? {
					...ROWS,
					nodes: [...Arr.map(ROWS.nodes, (row) => ({ ...row, lastSeenMs: NOW - 20_000 })), STANDALONE],
					patroni: Arr.map([patroni("pg1", 0, 170004), patroni("pg2", 0, 170009), patroni("pg3", 1, 170009)], (row) => ({
						...row,
						streaming: row.isPrimary === 1 ? 0 : 1,
					})),
					rates: [...ROWS.rates, { host: "nexus-prod-v2.rds", tps: 214.6, rowWrites: 38.2, hits: 9_811_000, reads: 1_240, deadlocks: 0 }],
					positions: [
						{ host: "pg1", timeline: 85, walPosition: 0, replayPosition: 24110171000 },
						{ host: "pg2", timeline: 85, walPosition: 0, replayPosition: 24110100000 },
						ROWS.positions[2],
					],
				}
			: state === "empty"
				? { ...ROWS, nodes: [], patroni: [] }
				: ROWS,
	)

const view = (model: Model, h: HtmlBuilder<Message>): Html => {
	const data = snapshot(model.state)
	const body =
		model.state === "loading"
			? postgresLoadingBody(h)
			: data.instances.length === 0
				? postgresEmptyBody(h)
				: postgresBody(h, data)
	return dashboardPage(h, { title: "PostgreSQL", description: postgresDescription(data), gap: "lg" }, [
		h.div([h.Class("flex flex-col gap-8")], body),
	])
}

export const lab = defineShellLab("PostgreSQL", {
	Model,
	Message,
	Flags,
	flags,
	init: (f): Update.Return<Model, Message, Resources> => ({ model: f }),
	update: (model) => ({ model }),
	view,
	currentPath: "/infra/postgres",
	breadcrumbs: [{ label: "Infrastructure" }, { label: "PostgreSQL" }],
})
