import { Schema } from "effect"

// `/infra/atlas` (NevrLabs selfhost): one MongoDB Atlas replica set from Atlas's Prometheus integration
// (`mongodb_*` gauges, one series per node keyed by `service.instance.id`). Counters arrive as cumulative
// gauges, so rates are the window's delta over its span.

export const AtlasNode = Schema.Struct({
	/** `service.instance.id`: `<cluster>-shard-00-01-pri.<id>.mongodb.net:27018`. */
	host: Schema.String,
	cluster: Schema.String,
	replicaSet: Schema.String,
	zone: Schema.String,
	/** `rs_state`: 1 primary, 2 secondary, anything else unhealthy. */
	state: Schema.Number,
	up: Schema.Number,
	connections: Schema.Number,
	connectionsFree: Schema.Number,
	queue: Schema.Number,
	residentMiB: Schema.Number,
	cacheBytes: Schema.Number,
	oplogBytes: Schema.Number,
	oplogMaxBytes: Schema.Number,
	lastSeenMs: Schema.Number,
	/** Per second over the last 15 minutes. */
	ops: Schema.Struct({
		query: Schema.Number,
		insert: Schema.Number,
		update: Schema.Number,
		delete: Schema.Number,
		getmore: Schema.Number,
		command: Schema.Number,
	}),
	asserts: Schema.Number,
	/** Connections, oldest first: 15-minute means over the last 6 hours. */
	connectionsSpark: Schema.Array(Schema.Number),
})
export type AtlasNode = typeof AtlasNode.Type

export const AtlasSnapshot = Schema.Struct({
	capturedAtMs: Schema.Number,
	nodes: Schema.Array(AtlasNode),
})
export type AtlasSnapshot = typeof AtlasSnapshot.Type

export const OP_KINDS = ["query", "getmore", "command", "update", "insert", "delete"] as const
export type OpKind = (typeof OP_KINDS)[number]
