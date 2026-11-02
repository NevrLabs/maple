// `/lab/proxmox`: the shape of one FxCluster snapshot (see fixture.generated.ts). A real route would
// read the same fields from ClickHouse (`service.name = proxmox-ve`, PVE's native OpenTelemetry push).

export type ProxmoxNode = Readonly<{
	name: string
	cpu: number
	cpus: number
	load1: number
	memUsed: number
	/** ZFS ARC: counted in memUsed by PVE, but reclaimable cache, so the bar excludes it. */
	arc: number
	memTotal: number
	swapUsed: number
	swapTotal: number
	rootUsed: number
	rootTotal: number
	uptime: number
	lastSeenMs: number
	cpuSpark: ReadonlyArray<number>
}>

export type ProxmoxGuest = Readonly<{
	vmid: string
	name: string
	type: string
	node: string
	status: "running" | "stopped"
	uptime: number
	cpu: number
	cpus: number
	mem: number
	maxmem: number
	disk: number
	maxdisk: number
	netIn: number
	netOut: number
	diskRead: number
	diskWrite: number
}>

export type ProxmoxStorage = Readonly<{
	name: string
	type: string
	shared: boolean
	nodes: ReadonlyArray<string>
	used: number
	total: number
}>

export type ProxmoxBackup = Readonly<{
	vmid: string
	storage: string
	ctime: number
	size: number
	format: string
	protected: boolean
	notes: string
}>

export type ProxmoxBackupJob = Readonly<{
	id: string
	schedule: string
	storage: string
	vmids: string
	enabled: boolean
	comment: string
}>

export type ProxmoxFixture = Readonly<{
	capturedAtMs: number
	cluster: string
	pveVersion: string
	nodes: ReadonlyArray<ProxmoxNode>
	guests: ReadonlyArray<ProxmoxGuest>
	storage: ReadonlyArray<ProxmoxStorage>
	backups: ReadonlyArray<ProxmoxBackup>
	backupJobs: ReadonlyArray<ProxmoxBackupJob>
}>
