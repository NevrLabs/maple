import { Effect, Schema } from "effect"
import type { Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { assembleSnapshot } from "../../page/infra-integrations/atlas/data"
import { atlasBody, atlasDescription, atlasEmptyBody, atlasLoadingBody } from "../../page/infra-integrations/atlas/view-parts"
import { dashboardPage } from "../../page/kit/dashboard-page"
import type { Resources } from "../../platform/resources"
import { defineShellLab } from "../shell-lab"

// `/lab/atlas`: the `/infra/atlas` view over the live replica set's raw-SQL rows of 2026-11-13 (NevrLabs
// selfhost). `?state=live|loading|offline|empty`.

const NOW = 1794586160000
const ROWS = {"nowMs": 1794586160000, "nodes": [{"host": "noov-mongodb-live-shard-00-00-pri.l2mydt.mongodb.net:27018", "cluster": "noov-mongodb-live", "replicaSet": "atlas-6fng94-shard-0", "zone": "apse1-az2", "state": "2", "up": 1, "connections": 148, "connectionsFree": 2852, "queue": 0, "residentMiB": 2697, "cacheBytes": 2147483648, "oplogBytes": 3394596864, "oplogMaxBytes": 6335496192, "lastSeenMs": 1794586154231}, {"host": "noov-mongodb-live-shard-00-01-pri.l2mydt.mongodb.net:27018", "cluster": "noov-mongodb-live", "replicaSet": "atlas-6fng94-shard-0", "zone": "apse1-az3", "state": "1", "up": 1, "connections": 173, "connectionsFree": 2827, "queue": 0, "residentMiB": 2770, "cacheBytes": 2147483648, "oplogBytes": 2898886656, "oplogMaxBytes": 6335496192, "lastSeenMs": 1794586154067}, {"host": "noov-mongodb-live-shard-00-02-pri.l2mydt.mongodb.net:27018", "cluster": "noov-mongodb-live", "replicaSet": "atlas-6fng94-shard-0", "zone": "apse1-az1", "state": "2", "up": 1, "connections": 152, "connectionsFree": 2848, "queue": 0, "residentMiB": 2695, "cacheBytes": 2147483648, "oplogBytes": 2860068864, "oplogMaxBytes": 6335496192, "lastSeenMs": 1794586151568}], "rates": [{"host": "noov-mongodb-live-shard-00-01-pri.l2mydt.mongodb.net:27018", "op_query": 6.71, "op_insert": 1.24, "op_update": 2.26, "op_delete": 0.74, "op_getmore": 21.69, "op_command": 50.75, "asserts": 0.95}, {"host": "noov-mongodb-live-shard-00-02-pri.l2mydt.mongodb.net:27018", "op_query": 2.27, "op_insert": 0, "op_update": 0.04, "op_delete": 0, "op_getmore": 4.61, "op_command": 27.1, "asserts": 0.94}, {"host": "noov-mongodb-live-shard-00-00-pri.l2mydt.mongodb.net:27018", "op_query": 2.23, "op_insert": 0, "op_update": 0.05, "op_delete": 0, "op_getmore": 4.14, "op_command": 27.17, "asserts": 0.94}], "sparks": [{"host": "noov-mongodb-live-shard-00-01-pri.l2mydt.mongodb.net:27018", "spark": [169.7, 170, 170, 170, 170.1, 170, 170, 170, 170.1, 170, 170, 170, 170.3, 170, 170, 170, 171.7, 173, 173, 173, 173.1, 173, 181.2, 174.4, 173.2]}, {"host": "noov-mongodb-live-shard-00-02-pri.l2mydt.mongodb.net:27018", "spark": [150.2, 150.4, 150.2, 150.3, 150.8, 150.6, 150.3, 150.1, 150.3, 150, 150.3, 150.3, 150.3, 150.4, 150.5, 150.3, 150.8, 151.2, 151.3, 151.3, 151.3, 151.1, 158.3, 152.6, 151.4]}, {"host": "noov-mongodb-live-shard-00-00-pri.l2mydt.mongodb.net:27018", "spark": [147.4, 147.3, 147.8, 147.6, 147.4, 147.9, 147.6, 147.5, 147.4, 146.5, 147, 147.4, 147.9, 147.7, 147.5, 147.5, 147.8, 148.3, 148.3, 148.5, 148.3, 148.5, 155.4, 150, 148.4]}]} as const

const STATES = ["live", "loading", "offline", "empty"] as const
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
		state === "offline"
			? { ...ROWS, nodes: ROWS.nodes.map((row, i) => (i === 0 ? { ...row, lastSeenMs: NOW - 5 * 60_000 } : row)) }
			: state === "empty"
				? { ...ROWS, nodes: [] }
				: ROWS,
	)

const view = (model: Model, h: HtmlBuilder<Message>): Html => {
	const data = snapshot(model.state)
	const body =
		model.state === "loading" ? atlasLoadingBody(h) : data.nodes.length === 0 ? atlasEmptyBody(h) : atlasBody(h, data)
	return dashboardPage(h, { title: "MongoDB Atlas", description: atlasDescription(data), gap: "lg" }, [
		h.div([h.Class("flex flex-col gap-8")], body),
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
