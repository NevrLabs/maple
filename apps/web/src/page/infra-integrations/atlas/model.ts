import { Schema } from "effect"

// `/infra/atlas` (NevrLabs selfhost): MongoDB Atlas as its Prometheus integration reports it
// (`mongodb_*` gauges, one series per node keyed by `service.instance.id`). Every sample carries the
// Atlas hierarchy as labels — organization, project (Atlas's "group") and cluster — so one snapshot
// holds any number of each. Counters arrive as cumulative gauges, so rates are the window's delta over
// its span.

export const AtlasNode = Schema.Struct({
	/** `service.instance.id`: `<cluster>-shard-00-01-pri.<id>.mongodb.net:27018`. */
	host: Schema.String,
	/** `org_id`: the Atlas organization, shared by every project under it. */
	orgId: Schema.String,
	/** `group_id` / `group_name`: the Atlas project that owns the cluster. Empty when Atlas sent neither. */
	projectId: Schema.String,
	project: Schema.String,
	/** `cl_name`. The page groups by it, falling back to `replicaSet` when it is empty. */
	cluster: Schema.String,
	/** `rs_nm`: the replica set the member belongs to (Atlas names every set `…-shard-N`, sharded or not). */
	replicaSet: Schema.String,
	/** `AWS` / `GCP` / `AZURE`, and the region the members run in. */
	provider: Schema.String,
	region: Schema.String,
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
