import { RawSqlExecuteRequest } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Effect } from "effect"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import type { ProxmoxBackup, ProxmoxBackupJob, ProxmoxGuest, ProxmoxNode, ProxmoxSnapshot, ProxmoxStorage } from "./model"

// `/infra/proxmox` reads: raw SQL through the query engine's `executeRawSql` (the dashboard widgets' path:
// `$__orgFilter` scoping, the same limits and validator), so no new backend endpoint. Nodes, guests and
// storage come from PVE's OTel metrics; backups, jobs and storage types from the CT130 collector tables.

const PVE = "ServiceName = 'proxmox-ve'"

/** The last hour: the node sparklines span it; the latest-value reads take each series' last sample. */
export const WINDOW_MS = 60 * 60 * 1000

export const NODES_SQL = `SELECT ResourceAttributes['proxmox.node'] AS name,
  any(ResourceAttributes['proxmox.cluster']) AS cluster,
  any(splitByChar('/', ResourceAttributes['service.version'])[1]) AS version,
  argMaxIf(Value, TimeUnix, MetricName = 'proxmox_node_cpustat_cpu') AS cpu,
  argMaxIf(Value, TimeUnix, MetricName = 'proxmox_node_cpustat_cpus') AS cpus,
  argMaxIf(Value, TimeUnix, MetricName = 'proxmox_node_cpustat_avg1') AS load1,
  argMaxIf(Value, TimeUnix, MetricName = 'proxmox_node_memory_memused') AS memUsed,
  argMaxIf(Value, TimeUnix, MetricName = 'proxmox_node_memory_arcsize') AS arc,
  argMaxIf(Value, TimeUnix, MetricName = 'proxmox_node_memory_memtotal') AS memTotal,
  argMaxIf(Value, TimeUnix, MetricName = 'proxmox_node_memory_swapused') AS swapUsed,
  argMaxIf(Value, TimeUnix, MetricName = 'proxmox_node_memory_swaptotal') AS swapTotal,
  argMaxIf(Value, TimeUnix, MetricName = 'proxmox_node_blockstat_used') AS rootUsed,
  argMaxIf(Value, TimeUnix, MetricName = 'proxmox_node_blockstat_blocks') AS rootTotal,
  argMaxIf(Value, TimeUnix, MetricName = 'proxmox_node_uptime') AS uptime,
  toUnixTimestamp64Milli(max(TimeUnix)) AS lastSeenMs,
  arrayMap(x -> round(x.2, 4), arraySort(x -> x.1, groupArrayIf((toStartOfInterval(TimeUnix, INTERVAL 2 MINUTE), Value), MetricName = 'proxmox_node_cpustat_cpu'))) AS cpuRaw
FROM metrics_gauge m
WHERE $__orgFilter(m) AND $__timeFilter(TimeUnix) AND ${PVE} AND MetricName LIKE 'proxmox_node_%'
  AND ResourceAttributes['proxmox.node'] NOT IN ('', 'synthetic-probe')
GROUP BY name ORDER BY name`

/** Latest gauges per guest (last 10 min) joined to byte rates over the last 5 min of the counters. */
export const GUESTS_SQL = `SELECT g.vmid AS vmid, g.name AS name, g.type AS type, g.node AS node, g.uptime AS uptime, g.cpu AS cpu,
  g.cpus AS cpus, g.mem AS mem, g.maxmem AS maxmem, g.disk AS disk, g.maxdisk AS maxdisk,
  r.netIn AS netIn, r.netOut AS netOut, r.diskRead AS diskRead, r.diskWrite AS diskWrite
FROM (
  SELECT Attributes['vmid'] AS vmid, argMax(Attributes['name'], TimeUnix) AS name, any(Attributes['type']) AS type,
    argMax(Attributes['node'], TimeUnix) AS node,
    argMaxIf(Value, TimeUnix, MetricName = 'proxmox_vm_uptime') AS uptime,
    argMaxIf(Value, TimeUnix, MetricName = 'proxmox_vm_cpu') AS cpu,
    argMaxIf(Value, TimeUnix, MetricName = 'proxmox_vm_cpus') AS cpus,
    argMaxIf(Value, TimeUnix, MetricName = 'proxmox_vm_mem') AS mem,
    argMaxIf(Value, TimeUnix, MetricName = 'proxmox_vm_maxmem') AS maxmem,
    argMaxIf(Value, TimeUnix, MetricName = 'proxmox_vm_disk') AS disk,
    argMaxIf(Value, TimeUnix, MetricName = 'proxmox_vm_maxdisk') AS maxdisk
  FROM metrics_gauge mg
  WHERE $__orgFilter(mg) AND TimeUnix >= $__endTime - INTERVAL 10 MINUTE AND TimeUnix <= $__endTime AND ${PVE}
    AND MetricName IN ('proxmox_vm_uptime', 'proxmox_vm_cpu', 'proxmox_vm_cpus', 'proxmox_vm_mem', 'proxmox_vm_maxmem', 'proxmox_vm_disk', 'proxmox_vm_maxdisk')
    AND Attributes['vmid'] NOT IN ('', '99999')
  GROUP BY vmid
) g LEFT JOIN (
  SELECT vmid,
    sumIf(rate, metric = 'proxmox_vm_netin_total') AS netIn, sumIf(rate, metric = 'proxmox_vm_netout_total') AS netOut,
    sumIf(rate, metric = 'proxmox_vm_diskread_total') AS diskRead, sumIf(rate, metric = 'proxmox_vm_diskwrite_total') AS diskWrite
  FROM (
    SELECT Attributes['vmid'] AS vmid, MetricName AS metric,
      greatest(argMax(Value, TimeUnix) - argMin(Value, TimeUnix), 0) / greatest(dateDiff('second', min(TimeUnix), max(TimeUnix)), 1) AS rate
    FROM metrics_sum ms
    WHERE $__orgFilter(ms) AND TimeUnix >= $__endTime - INTERVAL 5 MINUTE AND TimeUnix <= $__endTime AND ${PVE}
      AND MetricName IN ('proxmox_vm_netin_total', 'proxmox_vm_netout_total', 'proxmox_vm_diskread_total', 'proxmox_vm_diskwrite_total')
    GROUP BY vmid, metric
  ) GROUP BY vmid
) r ON r.vmid = g.vmid
ORDER BY toUInt32OrZero(vmid)`

/**
 * PATCHES #14: one row per (storage, node). Node-local storages (local, local-lvm, local-zfs-vms) share a NAME
 * across nodes but are different disks; `assembleStorage` keeps them per node and collapses shared ones.
 */
export const STORAGE_SQL = `SELECT Attributes['storage'] AS name, Attributes['node'] AS node,
  maxIf(Value, MetricName = 'proxmox_storage_shared') > 0 AS shared,
  argMaxIf(Value, TimeUnix, MetricName = 'proxmox_storage_used') AS used,
  argMaxIf(Value, TimeUnix, MetricName = 'proxmox_storage_total') AS total
FROM metrics_gauge m
WHERE $__orgFilter(m) AND TimeUnix >= $__endTime - INTERVAL 10 MINUTE AND TimeUnix <= $__endTime AND ${PVE}
  AND MetricName IN ('proxmox_storage_used', 'proxmox_storage_total', 'proxmox_storage_shared')
GROUP BY name, node HAVING total > 0 ORDER BY used / total DESC`

/** The collector's tables keep one row per item and snapshot; only the newest snapshot is current. */
const latestSnapshot = (table: string, alias: string, columns: string, order: string) =>
	`SELECT ${columns}, toUnixTimestamp(SnapshotTime) * 1000 AS snapshotMs FROM ${table} ${alias} FINAL
WHERE $__orgFilter(${alias}) AND SnapshotTime = (SELECT max(SnapshotTime) FROM ${table} q WHERE $__orgFilter(q))
ORDER BY ${order}`

export const BACKUPS_SQL = latestSnapshot(
	"proxmox_backups",
	"b",
	"Vmid AS vmid, Storage AS storage, Ctime AS ctime, SizeBytes AS size, SizeKnown AS sizeKnown, GuestType AS format, Protected AS protected",
	"Ctime DESC",
)
export const JOBS_SQL = latestSnapshot(
	"proxmox_backup_jobs",
	"j",
	"JobId AS id, Schedule AS schedule, Storage AS storage, Vmids AS vmids, Enabled AS enabled, Comment AS comment",
	"JobId",
)
export const STORAGE_META_SQL = latestSnapshot("proxmox_storage", "s", "Storage AS name, Type AS type, Shared AS shared", "Storage")

/** The sidebar's presence check: one PVE node sample in the window, nothing more. */
export const PRESENCE_SQL = `SELECT 1 AS present FROM metrics_gauge m
WHERE $__orgFilter(m) AND $__timeFilter(TimeUnix) AND ${PVE} AND MetricName = 'proxmox_node_uptime' LIMIT 1`

type Row = Readonly<Record<string, unknown>>

const num = (value: unknown): number => {
	const n = typeof value === "number" ? value : Number(value)
	return Number.isFinite(n) ? n : 0
}
const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value))
const bool = (value: unknown): boolean => value === true || num(value) > 0
const nums = (value: unknown): ReadonlyArray<number> => (Array.isArray(value) ? value.map(num) : [])
const strs = (value: unknown): ReadonlyArray<string> => (Array.isArray(value) ? value.map(str) : [])

/** The last 28 two-minute buckets: the card's sparkline width, as in the mockup. */
const SPARK_POINTS = 28

export const toNode = (row: Row): ProxmoxNode => ({
	name: str(row.name),
	cpu: num(row.cpu),
	cpus: num(row.cpus),
	load1: num(row.load1),
	memUsed: num(row.memUsed),
	arc: num(row.arc),
	memTotal: num(row.memTotal),
	swapUsed: num(row.swapUsed),
	swapTotal: num(row.swapTotal),
	rootUsed: num(row.rootUsed),
	rootTotal: num(row.rootTotal),
	uptime: num(row.uptime),
	lastSeenMs: num(row.lastSeenMs),
	cpuSpark: nums(row.cpuRaw).slice(-SPARK_POINTS),
})

export const toGuest = (row: Row): ProxmoxGuest => ({
	vmid: str(row.vmid),
	name: str(row.name),
	type: str(row.type),
	node: str(row.node),
	status: num(row.uptime) > 0 ? "running" : "stopped",
	uptime: num(row.uptime),
	cpu: num(row.cpu),
	cpus: num(row.cpus),
	mem: num(row.mem),
	maxmem: num(row.maxmem),
	disk: num(row.disk),
	maxdisk: num(row.maxdisk),
	netIn: Math.max(num(row.netIn), 0),
	netOut: Math.max(num(row.netOut), 0),
	diskRead: Math.max(num(row.diskRead), 0),
	diskWrite: Math.max(num(row.diskWrite), 0),
})

export const toStorage = (row: Row, meta: ReadonlyMap<string, Row>): ProxmoxStorage => {
	const name = str(row.name)
	const known = meta.get(name)
	// Older rows (and the lab fixture) carry `nodes`; per-node rows carry `node`.
	const nodes = row.node === undefined ? strs(row.nodes) : [str(row.node)].filter((node) => node !== "")
	return {
		name,
		type: known === undefined ? "" : str(known.type),
		shared: known === undefined ? bool(row.shared) : bool(known.shared),
		nodes,
		used: num(row.used),
		total: num(row.total),
	}
}

/**
 * PATCHES #14: shared storages (Ceph, NFS) report the same pool from every node: one entry listing every node.
 * Non-shared ones stay one entry per node (`nodes` = [that node]). Fullest first.
 */
export const assembleStorage = (rows: ReadonlyArray<Row>, meta: ReadonlyMap<string, Row>): ReadonlyArray<ProxmoxStorage> => {
	const stores = rows.map((row) => toStorage(row, meta))
	const shared = new Map<string, ProxmoxStorage>()
	const local: Array<ProxmoxStorage> = []
	stores.forEach((store) => {
		if (!store.shared) return local.push(store)
		const seen = shared.get(store.name)
		shared.set(
			store.name,
			seen === undefined
				? store
				: { ...seen, nodes: [...new Set([...seen.nodes, ...store.nodes])].sort(), used: Math.max(seen.used, store.used), total: Math.max(seen.total, store.total) },
		)
	})
	const fill = (store: ProxmoxStorage) => (store.total > 0 ? store.used / store.total : 0)
	return [...shared.values(), ...local].toSorted((a, b) => fill(b) - fill(a))
}

/** Storage key: shared ones by name, node-local ones by node + name. */
export const storageKey = (store: ProxmoxStorage): string =>
	store.shared || store.nodes.length !== 1 ? store.name : `${store.nodes[0]}/${store.name}`

export const toBackup = (row: Row): ProxmoxBackup => ({
	vmid: str(row.vmid),
	storage: str(row.storage),
	ctime: num(row.ctime) * 1000,
	size: num(row.size),
	sizeKnown: bool(row.sizeKnown),
	format: str(row.format),
	protected: bool(row.protected),
	notes: "",
})

export const toJob = (row: Row): ProxmoxBackupJob => ({
	id: str(row.id),
	schedule: str(row.schedule),
	storage: str(row.storage),
	vmids: str(row.vmids),
	enabled: bool(row.enabled),
	comment: str(row.comment),
})

export type SnapshotRows = Readonly<{
	nowMs: number
	nodes: ReadonlyArray<Row>
	guests: ReadonlyArray<Row>
	storage: ReadonlyArray<Row>
	storageMeta: ReadonlyArray<Row>
	backups: ReadonlyArray<Row>
	jobs: ReadonlyArray<Row>
}>

/** Pure: the query answers as one snapshot (the shape the lab fixture has). */
export const assembleSnapshot = (rows: SnapshotRows): ProxmoxSnapshot => {
	const meta = new Map(rows.storageMeta.map((row) => [str(row.name), row] as const))
	const first = rows.nodes[0]
	const backupsAsOf = rows.backups[0] ?? rows.jobs[0]
	return {
		capturedAtMs: rows.nowMs,
		cluster: first === undefined || str(first.cluster) === "" ? "Proxmox" : str(first.cluster),
		pveVersion: first === undefined ? "" : str(first.version),
		nodes: rows.nodes.map(toNode),
		guests: rows.guests.map(toGuest),
		storage: assembleStorage(rows.storage, meta),
		backups: rows.backups.map(toBackup),
		backupJobs: rows.jobs.map(toJob),
		backupsAsOfMs: backupsAsOf === undefined ? null : num(backupsAsOf.snapshotMs),
	}
}

const runSql = (sql: string, window: Readonly<{ startTime: string; endTime: string }>) =>
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		const response = yield* client.queryEngine.executeRawSql({
			payload: new RawSqlExecuteRequest({ sql, displayType: "table", ...window }),
		})
		return response.data as ReadonlyArray<Row>
	})

export const windowEndingAt = (nowMs: number) => ({
	startTime: formatWarehouseDateTime(nowMs - WINDOW_MS),
	endTime: formatWarehouseDateTime(nowMs),
})

/**
 * The page's one read: the six queries in parallel. Nodes, guests and storage must answer; the
 * collector's tables are best-effort (an absent or failing collector shows as "no backup data").
 */
export const loadProxmoxSnapshot = (nowMs: number) => {
	const window = windowEndingAt(nowMs)
	const optional = (sql: string) => runSql(sql, window).pipe(Effect.orElseSucceed((): ReadonlyArray<Row> => []))
	return Effect.all(
		{
			nodes: runSql(NODES_SQL, window),
			guests: runSql(GUESTS_SQL, window),
			storage: runSql(STORAGE_SQL, window),
			storageMeta: optional(STORAGE_META_SQL),
			backups: optional(BACKUPS_SQL),
			jobs: optional(JOBS_SQL),
		},
		{ concurrency: "unbounded" },
	).pipe(
		Effect.map((rows) => assembleSnapshot({ ...rows, nowMs })),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)
}

/** The sidebar row: does any PVE node report in the last hour? A failure counts as no. */
export const loadProxmoxPresence = (nowMs: number) =>
	Effect.map(runSql(PRESENCE_SQL, windowEndingAt(nowMs)), (rows) => rows.length > 0)
