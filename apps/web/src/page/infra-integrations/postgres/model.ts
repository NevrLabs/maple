import { Schema } from "effect"

/** Patroni and the receiver report every 60 s: three minutes of silence is an instance down. */
export const SILENT_AFTER_MS = 180_000

// `/infra/postgres` (NevrLabs selfhost): PostgreSQL instances from the OpenTelemetry `postgresql` receiver
// (`postgresql.*`, per database), joined with Patroni's `/metrics` scrape (`patroni_*`) where a cluster runs it.

export const PatroniState = Schema.Struct({
	scope: Schema.String,
	primary: Schema.Number,
	replica: Schema.Number,
	running: Schema.Number,
	streaming: Schema.Number,
	/** `server_version`: 170009 → 17.9. */
	version: Schema.Number,
	pendingRestart: Schema.Number,
	paused: Schema.Number,
	timeline: Schema.Number,
	/** WAL byte positions: the primary's write position, a replica's replay position. */
	walPosition: Schema.Number,
	replayPosition: Schema.Number,
	lastSeenMs: Schema.Number,
})
export type PatroniState = typeof PatroniState.Type

export const PgInstance = Schema.Struct({
	/** `server.address`, or `host.name` when the receiver reads a local socket. */
	host: Schema.String,
	connections: Schema.Number,
	maxConnections: Schema.Number,
	sizeBytes: Schema.Number,
	databases: Schema.Number,
	/** Last `postgresql.*` sample; 0 when only Patroni reports the instance. */
	lastSeenMs: Schema.Number,
	/** Per second over the last 15 minutes, all databases. */
	tps: Schema.Number,
	rowWrites: Schema.Number,
	/** Buffer cache hits over the last 15 minutes, 0 to 1; `null` with no block reads at all. */
	cacheHit: Schema.NullOr(Schema.Number),
	deadlocks: Schema.Number,
	/** Connections, oldest first: 15-minute means over the last 6 hours. */
	connectionsSpark: Schema.Array(Schema.Number),
	patroni: Schema.NullOr(PatroniState),
	/** Replicas only: bytes behind the reporting primary of the same scope. */
	lagBytes: Schema.NullOr(Schema.Number),
})
export type PgInstance = typeof PgInstance.Type

export const PostgresSnapshot = Schema.Struct({
	capturedAtMs: Schema.Number,
	instances: Schema.Array(PgInstance),
})
export type PostgresSnapshot = typeof PostgresSnapshot.Type
