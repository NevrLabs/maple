import { Schema } from "effect"

// `/infra/proxmox` (NevrLabs selfhost): one FxCluster snapshot. Nodes, guests and storage come from Proxmox VE's
// native OpenTelemetry metric server (`service.name = proxmox-ve`); backups, jobs and storage types from the
// CT130 collector (`maple.proxmox_backups`, `proxmox_backup_jobs`, `proxmox_storage`; PVE's OTel stream has none).
// The `/lab/proxmox` mockup renders the same shape from a fixture.

export const ProxmoxNode = Schema.Struct({
	name: Schema.String,
	cpu: Schema.Number,
	cpus: Schema.Number,
	load1: Schema.Number,
	memUsed: Schema.Number,
	/** ZFS ARC: counted in memUsed by PVE, but reclaimable cache, so the bar excludes it. */
	arc: Schema.Number,
	memTotal: Schema.Number,
	swapUsed: Schema.Number,
	swapTotal: Schema.Number,
	rootUsed: Schema.Number,
	rootTotal: Schema.Number,
	uptime: Schema.Number,
	lastSeenMs: Schema.Number,
	cpuSpark: Schema.Array(Schema.Number),
})
export type ProxmoxNode = typeof ProxmoxNode.Type

export const ProxmoxGuest = Schema.Struct({
	vmid: Schema.String,
	name: Schema.String,
	type: Schema.String,
	node: Schema.String,
	status: Schema.Literals(["running", "stopped"]),
	uptime: Schema.Number,
	cpu: Schema.Number,
	cpus: Schema.Number,
	mem: Schema.Number,
	maxmem: Schema.Number,
	disk: Schema.Number,
	maxdisk: Schema.Number,
	netIn: Schema.Number,
	netOut: Schema.Number,
	diskRead: Schema.Number,
	diskWrite: Schema.Number,
})
export type ProxmoxGuest = typeof ProxmoxGuest.Type

export const ProxmoxStorage = Schema.Struct({
	name: Schema.String,
	type: Schema.String,
	shared: Schema.Boolean,
	nodes: Schema.Array(Schema.String),
	used: Schema.Number,
	total: Schema.Number,
})
export type ProxmoxStorage = typeof ProxmoxStorage.Type

export const ProxmoxBackup = Schema.Struct({
	vmid: Schema.String,
	storage: Schema.String,
	ctime: Schema.Number,
	size: Schema.Number,
	/** False when PVE no longer keeps the vzdump task log the size is read from. */
	sizeKnown: Schema.optional(Schema.Boolean),
	format: Schema.String,
	protected: Schema.Boolean,
	notes: Schema.String,
})
export type ProxmoxBackup = typeof ProxmoxBackup.Type

export const ProxmoxBackupJob = Schema.Struct({
	id: Schema.String,
	schedule: Schema.String,
	storage: Schema.String,
	vmids: Schema.String,
	enabled: Schema.Boolean,
	comment: Schema.String,
})
export type ProxmoxBackupJob = typeof ProxmoxBackupJob.Type

export const ProxmoxSnapshot = Schema.Struct({
	capturedAtMs: Schema.Number,
	cluster: Schema.String,
	pveVersion: Schema.String,
	nodes: Schema.Array(ProxmoxNode),
	guests: Schema.Array(ProxmoxGuest),
	storage: Schema.Array(ProxmoxStorage),
	backups: Schema.Array(ProxmoxBackup),
	backupJobs: Schema.Array(ProxmoxBackupJob),
	/** When the backups collector last wrote; `null` when it never has. */
	backupsAsOfMs: Schema.NullOr(Schema.Number),
})
export type ProxmoxSnapshot = typeof ProxmoxSnapshot.Type

export const TABS = ["overview", "storage", "backups"] as const
export const Tab = Schema.Literals(TABS)
export type Tab = typeof Tab.Type
export const TAB_LABEL = { overview: "Overview", storage: "Storage", backups: "Backups" } as const

export const GuestScope = Schema.Literals(["running", "stopped", "unknown"])
export type GuestScope = typeof GuestScope.Type

/** The view's own state: shared by the real route and the lab. */
export type ProxmoxViewState = Readonly<{
	tab: Tab
	query: string
	guestScope: GuestScope | undefined
	nodeFilter: string | undefined
}>
