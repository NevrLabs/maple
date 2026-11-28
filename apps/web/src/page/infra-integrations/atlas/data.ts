import { Array as Arr, Effect } from "effect"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { runSql, windowEndingAt } from "../proxmox/data"
import type { AtlasNode, AtlasSnapshot } from "./model"

// `/infra/atlas` reads: raw SQL through the query engine's `executeRawSql` (the Proxmox page's path:
// `$__orgFilter` scoping, the same limits and validator), so no new backend endpoint.

const NODE = "ResourceAttributes['service.instance.id']"

/** Latest value per node over the last hour; `lastSeenMs` tells a silent node from a live one.
 * Atlas's own hierarchy rides on every sample as labels: organization, project (`group_*`) and cluster (`cl_name`). */
export const NODES_SQL = `SELECT ${NODE} AS host,
  argMaxIf(Attributes['org_id'], TimeUnix, MetricName = 'mongodb_up') AS orgId,
  argMaxIf(Attributes['group_id'], TimeUnix, MetricName = 'mongodb_up') AS projectId,
  argMaxIf(Attributes['group_name'], TimeUnix, MetricName = 'mongodb_up') AS project,
  argMaxIf(Attributes['cl_name'], TimeUnix, MetricName = 'mongodb_up') AS cluster,
  argMaxIf(Attributes['rs_nm'], TimeUnix, MetricName = 'mongodb_up') AS replicaSet,
  argMaxIf(Attributes['provider'], TimeUnix, MetricName = 'mongodb_up') AS provider,
  argMaxIf(Attributes['region'], TimeUnix, MetricName = 'mongodb_up') AS region,
  argMaxIf(Attributes['availability_zone'], TimeUnix, MetricName = 'mongodb_up') AS zone,
  argMaxIf(Attributes['rs_state'], TimeUnix, MetricName = 'mongodb_up') AS state,
  argMaxIf(Value, TimeUnix, MetricName = 'mongodb_up') AS up,
  argMaxIf(Value, TimeUnix, MetricName = 'mongodb_connections_current') AS connections,
  argMaxIf(Value, TimeUnix, MetricName = 'mongodb_connections_available') AS connectionsFree,
  argMaxIf(Value, TimeUnix, MetricName = 'mongodb_globalLock_currentQueue_total') AS queue,
  argMaxIf(Value, TimeUnix, MetricName = 'mongodb_mem_resident') AS residentMiB,
  argMaxIf(Value, TimeUnix, MetricName = 'mongodb_wiredTiger_cache_maximum_bytes_configured') AS cacheBytes,
  argMaxIf(Value, TimeUnix, MetricName = 'mongodb_oplog_stats_storageSize') AS oplogBytes,
  argMaxIf(Value, TimeUnix, MetricName = 'mongodb_oplog_stats_maxSize') AS oplogMaxBytes,
  toUnixTimestamp64Milli(maxIf(TimeUnix, MetricName = 'mongodb_up')) AS lastSeenMs
FROM metrics_gauge m
WHERE $__orgFilter(m) AND $__timeFilter(TimeUnix) AND startsWith(MetricName, 'mongodb_') AND ${NODE} != ''
GROUP BY host HAVING countIf(MetricName = 'mongodb_up') > 0 ORDER BY host`
// ponytail: one process per `service.instance.id` (host and port) is assumed, so two processes cannot
// collide. Atlas deploys one `mongos` for each node of each shard; if router or config-server series
// ever arrive, each would be listed as a member with no `rs_state` (neither primary nor secondary)
// and turn its cluster red, so filter them out when that scrape exists. None report today.

const OPS = ["query", "insert", "update", "delete", "getmore", "command"] as const
const ASSERTS = ["regular", "warning", "msg", "user"] as const

/** Aliases carry an `op_` prefix: the raw-SQL validator rejects `insert`/`update`/`delete` as statement keywords. */
const OP_RATES = Arr.join(
	Arr.map(OPS, (op) => `sumIf(rate, metric = 'mongodb_opcounters_${op}') AS op_${op}`),
	",\n  ",
)
const RATE_METRICS = Arr.join(
	Arr.map(
		[...Arr.map(OPS, (op) => `opcounters_${op}`), ...Arr.map(ASSERTS, (kind) => `asserts_${kind}`)],
		(metric) => `'mongodb_${metric}'`,
	),
	", ",
)

/** Counters are cumulative gauges: per-second rate = the 15-minute delta over its span (a restart floors at 0). */
export const RATES_SQL = `SELECT host,
  ${OP_RATES},
  sumIf(rate, startsWith(metric, 'mongodb_asserts_')) AS asserts
FROM (
  SELECT ${NODE} AS host, MetricName AS metric,
    greatest(argMax(Value, TimeUnix) - argMin(Value, TimeUnix), 0) / greatest(dateDiff('second', min(TimeUnix), max(TimeUnix)), 1) AS rate
  FROM metrics_gauge g
  WHERE $__orgFilter(g) AND TimeUnix >= $__endTime - INTERVAL 15 MINUTE AND TimeUnix <= $__endTime
    AND MetricName IN (${RATE_METRICS})
  GROUP BY host, metric
) GROUP BY host`

/** Connections per node: 15-minute means over the last 6 hours, oldest first. */
export const SPARK_SQL = `SELECT host, arrayMap(x -> round(x.2, 1), arraySort(x -> x.1, groupArray((bucket, value)))) AS spark
FROM (
  SELECT ${NODE} AS host, toStartOfInterval(TimeUnix, INTERVAL 15 MINUTE) AS bucket, avg(Value) AS value
  FROM metrics_gauge s
  WHERE $__orgFilter(s) AND TimeUnix >= $__endTime - INTERVAL 6 HOUR AND TimeUnix <= $__endTime
    AND MetricName = 'mongodb_connections_current'
  GROUP BY host, bucket
) GROUP BY host`

/** The sidebar's presence check: one Atlas node sample in the window. */
export const PRESENCE_SQL = `SELECT 1 AS present FROM metrics_gauge m
WHERE $__orgFilter(m) AND $__timeFilter(TimeUnix) AND MetricName = 'mongodb_up' LIMIT 1`

type Row = Readonly<Record<string, unknown>>

/** A cell as the warehouse returns it: a number, or a string that parses as one; anything else reads 0. */
const num = (value: unknown): number => {
	const n = typeof value === "number" ? value : Number(value)
	return Number.isFinite(n) ? n : 0
}
/** A label cell: empty when the scrape did not send it. */
const str = (value: unknown): string =>
	typeof value === "string" ? value : typeof value === "number" ? String(value) : ""

export type SnapshotRows = Readonly<{
	nowMs: number
	nodes: ReadonlyArray<Row>
	rates: ReadonlyArray<Row>
	sparks: ReadonlyArray<Row>
}>

/** Pure: the three answers joined per node. */
export const assembleSnapshot = (rows: SnapshotRows): AtlasSnapshot => {
	const rates = new Map(Arr.map(rows.rates, (row) => [str(row.host), row] as const))
	const sparks = new Map(Arr.map(rows.sparks, (row) => [str(row.host), row] as const))
	const toNode = (row: Row): AtlasNode => {
		const host = str(row.host)
		const rate = rates.get(host) ?? {}
		const spark = sparks.get(host)?.spark
		return {
			host,
			orgId: str(row.orgId),
			projectId: str(row.projectId),
			project: str(row.project),
			cluster: str(row.cluster),
			replicaSet: str(row.replicaSet),
			provider: str(row.provider),
			region: str(row.region),
			zone: str(row.zone),
			state: num(row.state),
			up: num(row.up),
			connections: num(row.connections),
			connectionsFree: num(row.connectionsFree),
			queue: num(row.queue),
			residentMiB: num(row.residentMiB),
			cacheBytes: num(row.cacheBytes),
			oplogBytes: num(row.oplogBytes),
			oplogMaxBytes: num(row.oplogMaxBytes),
			lastSeenMs: num(row.lastSeenMs),
			ops: {
				query: num(rate.op_query),
				insert: num(rate.op_insert),
				update: num(rate.op_update),
				delete: num(rate.op_delete),
				getmore: num(rate.op_getmore),
				command: num(rate.op_command),
			},
			asserts: num(rate.asserts),
			connectionsSpark: Arr.isArray(spark) ? Arr.map(spark, num) : [],
		}
	}
	return { capturedAtMs: rows.nowMs, nodes: Arr.map(rows.nodes, toNode) }
}

/** The page's one read: three queries in parallel. Rates and sparklines are best-effort. */
export const loadAtlasSnapshot = (nowMs: number) => {
	const window = windowEndingAt(nowMs)
	const optional = (sql: string) =>
		runSql(sql, window).pipe(Effect.orElseSucceed((): ReadonlyArray<Row> => []))
	return Effect.all(
		{ nodes: runSql(NODES_SQL, window), rates: optional(RATES_SQL), sparks: optional(SPARK_SQL) },
		{ concurrency: "unbounded" },
	).pipe(
		Effect.mapBoth({
			onSuccess: (rows) => assembleSnapshot({ ...rows, nowMs }),
			onFailure: toLoadFailure,
		}),
		Effect.result,
	)
}

/** The sidebar row: does any Atlas node report in the last hour? A failure counts as no. */
export const loadAtlasPresence = (nowMs: number) =>
	Effect.map(runSql(PRESENCE_SQL, windowEndingAt(nowMs)), (rows) => rows.length > 0)
