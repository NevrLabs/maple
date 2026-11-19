import { Array as Arr, Effect, Order } from "effect"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { runSql, windowEndingAt } from "../proxmox/data"
import { type PatroniState, type PgInstance, type PostgresSnapshot, SILENT_AFTER_MS } from "./model"

// `/infra/postgres` reads: raw SQL through `executeRawSql` (`$__orgFilter`, the Proxmox page's path).

/** The receiver's `server.address`, unless it reads a local socket: then the collector's `host.name`. */
const KEY = `if(ResourceAttributes['server.address'] IN ('', '127.0.0.1', 'localhost', '::1'), ResourceAttributes['host.name'], ResourceAttributes['server.address'])`
const DB = "ResourceAttributes['postgresql.database.name']"

/** Latest connections and size per database, summed per instance; `max_connections` beside it. */
export const NODES_SQL = `SELECT p.host AS host, p.connections AS connections, p.sizeBytes AS sizeBytes, p.databases AS databases,
  p.lastSeenMs AS lastSeenMs, x.maxConnections AS maxConnections
FROM (
  SELECT host, sum(c) AS connections, sum(s) AS sizeBytes, countIf(s > 0) AS databases, max(t) AS lastSeenMs
  FROM (
    SELECT ${KEY} AS host, ${DB} AS db,
      argMaxIf(Value, TimeUnix, MetricName = 'postgresql.backends') AS c,
      argMaxIf(Value, TimeUnix, MetricName = 'postgresql.db_size') AS s,
      toUnixTimestamp64Milli(max(TimeUnix)) AS t
    FROM metrics_sum m
    WHERE $__orgFilter(m) AND $__timeFilter(TimeUnix) AND MetricName IN ('postgresql.backends', 'postgresql.db_size')
    GROUP BY host, db
  ) GROUP BY host
) p
LEFT JOIN (
  SELECT ${KEY} AS host, argMax(Value, TimeUnix) AS maxConnections
  FROM metrics_gauge g
  WHERE $__orgFilter(g) AND $__timeFilter(TimeUnix) AND MetricName = 'postgresql.connection.max'
  GROUP BY host
) x ON x.host = p.host
WHERE p.host != '' ORDER BY host`

/** Patroni's role flags per member (the scrape runs beside Postgres, so `host.name` is the instance). */
export const PATRONI_SQL = `SELECT ResourceAttributes['host.name'] AS host, argMax(Attributes['scope'], TimeUnix) AS scope,
  argMaxIf(Value, TimeUnix, MetricName = 'patroni_primary') AS isPrimary,
  argMaxIf(Value, TimeUnix, MetricName = 'patroni_replica') AS isReplica,
  argMaxIf(Value, TimeUnix, MetricName = 'patroni_postgres_running') AS running,
  argMaxIf(Value, TimeUnix, MetricName = 'patroni_postgres_streaming') AS streaming,
  argMaxIf(Value, TimeUnix, MetricName = 'patroni_postgres_server_version') AS version,
  argMaxIf(Value, TimeUnix, MetricName = 'patroni_pending_restart') AS pendingRestart,
  argMaxIf(Value, TimeUnix, MetricName = 'patroni_is_paused') AS paused,
  toUnixTimestamp64Milli(max(TimeUnix)) AS lastSeenMs
FROM metrics_gauge g
WHERE $__orgFilter(g) AND $__timeFilter(TimeUnix) AND startsWith(MetricName, 'patroni_') AND ResourceAttributes['host.name'] != ''
GROUP BY host HAVING countIf(MetricName = 'patroni_primary') > 0 ORDER BY host`

/** Patroni's cumulative series: timeline and WAL positions (write on a primary, replay on a replica). */
export const POSITIONS_SQL = `SELECT ResourceAttributes['host.name'] AS host,
  argMaxIf(Value, TimeUnix, MetricName = 'patroni_postgres_timeline') AS timeline,
  argMaxIf(Value, TimeUnix, MetricName = 'patroni_xlog_location') AS walPosition,
  argMaxIf(Value, TimeUnix, MetricName = 'patroni_xlog_replayed_location') AS replayPosition
FROM metrics_sum s
WHERE $__orgFilter(s) AND $__timeFilter(TimeUnix)
  AND MetricName IN ('patroni_postgres_timeline', 'patroni_xlog_location', 'patroni_xlog_replayed_location')
GROUP BY host`

const RATE_METRICS = Arr.join(
	Arr.map(
		["commits", "rollbacks", "blks_hit", "blks_read", "deadlocks", "tup_inserted", "tup_updated", "tup_deleted"],
		(m) => `'postgresql.${m}'`,
	),
	", ",
)

/** Counters are cumulative per database: the 15-minute delta over its span (a restart floors at 0). */
export const RATES_SQL = `SELECT host,
  sumIf(delta / span, metric IN ('postgresql.commits', 'postgresql.rollbacks')) AS tps,
  sumIf(delta / span, metric IN ('postgresql.tup_inserted', 'postgresql.tup_updated', 'postgresql.tup_deleted')) AS rowWrites,
  sumIf(delta, metric = 'postgresql.blks_hit') AS hits,
  sumIf(delta, metric = 'postgresql.blks_read') AS reads,
  sumIf(delta, metric = 'postgresql.deadlocks') AS deadlocks
FROM (
  SELECT ${KEY} AS host, ${DB} AS db, MetricName AS metric,
    greatest(argMax(Value, TimeUnix) - argMin(Value, TimeUnix), 0) AS delta,
    greatest(dateDiff('second', min(TimeUnix), max(TimeUnix)), 1) AS span
  FROM metrics_sum s
  WHERE $__orgFilter(s) AND TimeUnix >= $__endTime - INTERVAL 15 MINUTE AND TimeUnix <= $__endTime
    AND MetricName IN (${RATE_METRICS})
  GROUP BY host, db, metric
) GROUP BY host`

/** Connections per instance: 15-minute means over the last 6 hours, oldest first. */
export const SPARK_SQL = `SELECT host, arrayMap(x -> round(x.2, 1), arraySort(x -> x.1, groupArray((bucket, value)))) AS spark
FROM (
  SELECT host, bucket, sum(v) AS value
  FROM (
    SELECT ${KEY} AS host, ${DB} AS db, toStartOfInterval(TimeUnix, INTERVAL 15 MINUTE) AS bucket, avg(Value) AS v
    FROM metrics_sum s
    WHERE $__orgFilter(s) AND TimeUnix >= $__endTime - INTERVAL 6 HOUR AND TimeUnix <= $__endTime
      AND MetricName = 'postgresql.backends'
    GROUP BY host, db, bucket
  ) GROUP BY host, bucket
) GROUP BY host`

/** The sidebar's presence check: one receiver sample in the window. */
export const PRESENCE_SQL = `SELECT 1 AS present FROM metrics_sum m
WHERE $__orgFilter(m) AND $__timeFilter(TimeUnix) AND MetricName = 'postgresql.backends' LIMIT 1`

type Row = Readonly<Record<string, unknown>>

const num = (value: unknown): number => {
	const n = typeof value === "number" ? value : Number(value)
	return Number.isFinite(n) ? n : 0
}
const str = (value: unknown): string =>
	typeof value === "string" ? value : typeof value === "number" ? String(value) : ""

export type SnapshotRows = Readonly<{
	nowMs: number
	nodes: ReadonlyArray<Row>
	patroni: ReadonlyArray<Row>
	positions: ReadonlyArray<Row>
	rates: ReadonlyArray<Row>
	sparks: ReadonlyArray<Row>
}>

const byHost = (rows: ReadonlyArray<Row>) => new Map(Arr.map(rows, (row) => [str(row.host), row] as const))

/** Pure: the five answers joined per instance. An instance only Patroni reports still gets a row. */
export const assembleSnapshot = (rows: SnapshotRows): PostgresSnapshot => {
	const nodes = byHost(rows.nodes)
	const patroni = byHost(rows.patroni)
	const positions = byHost(rows.positions)
	const rates = byHost(rows.rates)
	const sparks = byHost(rows.sparks)
	const hosts = Arr.sort(
		Arr.filter(Arr.dedupe([...nodes.keys(), ...patroni.keys()]), (host) => host !== ""),
		Order.String,
	)

	const patroniOf = (host: string): PatroniState | null => {
		const row = patroni.get(host)
		if (row === undefined) return null
		const pos = positions.get(host) ?? {}
		return {
			scope: str(row.scope),
			primary: num(row.isPrimary),
			replica: num(row.isReplica),
			running: num(row.running),
			streaming: num(row.streaming),
			version: num(row.version),
			pendingRestart: num(row.pendingRestart),
			paused: num(row.paused),
			timeline: num(pos.timeline),
			walPosition: num(pos.walPosition),
			replayPosition: num(pos.replayPosition),
			lastSeenMs: num(row.lastSeenMs),
		}
	}
	const states = new Map(Arr.map(hosts, (host) => [host, patroniOf(host)] as const))
	/** The write position of each scope's live primary: a silent member's last `primary 1` is history. */
	const primaryWal = new Map<string, number>()
	for (const state of states.values()) {
		if (state === null || rows.nowMs - state.lastSeenMs > SILENT_AFTER_MS) continue
		if (state.primary === 1 && state.walPosition > 0) primaryWal.set(state.scope, state.walPosition)
	}

	const toInstance = (host: string): PgInstance => {
		const node = nodes.get(host) ?? {}
		const rate = rates.get(host) ?? {}
		const spark = sparks.get(host)?.spark
		const state = states.get(host) ?? null
		const hits = num(rate.hits)
		const reads = num(rate.reads)
		const wal = state === null ? undefined : primaryWal.get(state.scope)
		return {
			host,
			connections: num(node.connections),
			maxConnections: num(node.maxConnections),
			sizeBytes: num(node.sizeBytes),
			databases: num(node.databases),
			lastSeenMs: num(node.lastSeenMs),
			tps: num(rate.tps),
			rowWrites: num(rate.rowWrites),
			cacheHit: hits + reads > 0 ? hits / (hits + reads) : null,
			deadlocks: num(rate.deadlocks),
			connectionsSpark: Arr.isArray(spark) ? Arr.map(spark, num) : [],
			patroni: state,
			lagBytes:
				state !== null && state.replica === 1 && wal !== undefined && state.replayPosition > 0
					? Math.max(0, wal - state.replayPosition)
					: null,
		}
	}
	return { capturedAtMs: rows.nowMs, instances: Arr.map(hosts, toInstance) }
}

/** The page's one read: five queries in parallel. Only the receiver's own rows must answer. */
export const loadPostgresSnapshot = (nowMs: number) => {
	const window = windowEndingAt(nowMs)
	const optional = (sql: string) => runSql(sql, window).pipe(Effect.orElseSucceed((): ReadonlyArray<Row> => []))
	return Effect.all(
		{
			nodes: runSql(NODES_SQL, window),
			patroni: optional(PATRONI_SQL),
			positions: optional(POSITIONS_SQL),
			rates: optional(RATES_SQL),
			sparks: optional(SPARK_SQL),
		},
		{ concurrency: "unbounded" },
	).pipe(
		Effect.mapBoth({ onSuccess: (rows) => assembleSnapshot({ ...rows, nowMs }), onFailure: toLoadFailure }),
		Effect.result,
	)
}

/** The sidebar row: does any instance report in the last hour? A failure counts as no. */
export const loadPostgresPresence = (nowMs: number) =>
	Effect.map(runSql(PRESENCE_SQL, windowEndingAt(nowMs)), (rows) => rows.length > 0)
