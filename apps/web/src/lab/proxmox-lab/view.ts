import { formatBytes, formatBytesPerSecond, formatLoad, formatPercent, formatUptime } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { severityLevel } from "../../components/infra/format"
import { BAR_FILL, SPARK_COLOR } from "../../components/infra/severity-tokens"
import { columnHead, dataTable, dataTableEmpty, skeletonRows } from "../../page/infra/kit/data-table"
import { FLEET_BAND_BOXED, fleetBand, fleetBandLoading } from "../../page/infra/kit/fleet-band"
import { meterRows } from "../../page/infra/kit/meter-rows"
import { metaLine } from "../../page/infra/kit/meta-line"
import { searchToolbar } from "../../page/infra/kit/page-parts"
import { severityDot } from "../../page/infra/kit/status"
import { dashboardPage } from "../../page/kit/dashboard-page"
import { relativeTime } from "../../page/kit/relative-time"
import { sectionHeading } from "../../page/kit/section-heading"
import { statRail, statRailItem, statRailLoading } from "../../page/kit/stat-rail"
import type * as Shell from "../../shell"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../ui/empty"
import { icon } from "../../ui/icon"
import { meter } from "../../ui/meter"
import { miniBars } from "../../ui/mini-bars"
import { segmentedSelect } from "../../ui/segmented-select"
import { skeleton } from "../../ui/skeleton"
import { statusDot } from "../../ui/status-dot"
import { PROXMOX_FIXTURE } from "./fixture.generated"
import { LAB_STATES, Message, type Model, STATE_LABEL, TAB_LABEL, TABS } from "./model"
import type { ProxmoxBackup, ProxmoxFixture, ProxmoxGuest, ProxmoxNode, ProxmoxStorage } from "./types"

type H = HtmlBuilder<Message>

// Pulse (rcourtman/Pulse) anatomy in Maple's kit: dense node cards with CPU/MEM/DISK bars, one guest
// table with status dots and inline bars, storage bars, and backups by guest. Everything here is an
// existing Maple primitive (infra kit, stat rail, fleet band, data table, meters); no new UI pieces.

const SILENT_AFTER_MS = 90_000

/** The review state applied to the snapshot: `offline` ages one node's last push past the silence cut. */
const dataFor = (model: Model): ProxmoxFixture => {
	const base = PROXMOX_FIXTURE as unknown as ProxmoxFixture
	if (model.state !== "offline") return base
	return {
		...base,
		nodes: base.nodes.map((node) =>
			node.name === "thinkcentre-02" ? { ...node, lastSeenMs: base.capturedAtMs - 7 * 60_000 } : node,
		),
	}
}

const nowOf = (data: ProxmoxFixture) => data.capturedAtMs
const isSilent = (node: ProxmoxNode, nowMs: number) => nowMs - node.lastSeenMs > SILENT_AFTER_MS
const memFraction = (node: ProxmoxNode) => (node.memUsed - node.arc) / node.memTotal
const ratio = (used: number, total: number) => (total > 0 ? used / total : Number.NaN)
const toneOf = (fraction: number): Tone => {
	const level = severityLevel(fraction)
	return level === "ok" ? "ok" : level
}

// ── Node cards ────────────────────────────────────────────────────────────────

const nodeCard = (h: H, node: ProxmoxNode, model: Model, data: ProxmoxFixture): Html => {
	const silent = isSilent(node, nowOf(data))
	const guests = data.guests.filter((guest) => guest.node === node.name)
	const running = guests.filter((guest) => guest.status === "running").length
	const isSelected = model.nodeFilter === node.name
	return h.button(
		[
			h.Key(node.name),
			h.Type("button"),
			h.OnClick(Message.ClickedNode({ node: node.name })),
			h.DataAttribute("proxmox-node", node.name),
			h.Class(
				cn(
					"flex min-w-0 flex-col gap-3 rounded-md border bg-card p-4 text-left transition-colors",
					"hover:bg-surface-sunken active:bg-surface-sunken",
					isSelected && "border-primary ring-1 ring-primary",
					silent && "opacity-70",
				),
			),
		],
		[
			h.div(
				[h.Class("flex items-center justify-between gap-2")],
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							severityDot(h, { status: silent ? "ended" : "active", size: "md" }),
							h.span([h.Class("truncate font-mono text-sm font-medium text-foreground")], [node.name]),
						],
					),
					silent
						? h.span([h.Class("text-2xs font-medium text-severity-crit")], ["Not reporting"])
						: h.span(
								[h.Class("font-mono text-2xs text-muted-foreground")],
								[`up ${formatUptime(node.uptime)}`],
							),
				],
			),
			meterRows(h, [
				{ label: "CPU", fraction: node.cpu },
				{ label: "MEM", fraction: memFraction(node) },
				{ label: "DSK", fraction: ratio(node.rootUsed, node.rootTotal) },
				{ label: "SWP", fraction: ratio(node.swapUsed, node.swapTotal) },
			]),
			h.div(
				[h.Class("flex items-end justify-between gap-3")],
				[
					metaLine(h, [
						`${node.cpus} vCPU`,
						`load ${formatLoad(node.load1)}`,
						`${formatBytes(node.memTotal)} RAM`,
						`${running}/${guests.length} guests`,
					]),
					miniBars(h, {
						values: node.cpuSpark,
						color: SPARK_COLOR[toneOf(node.cpu)],
						className: "h-6 w-24 shrink-0",
						label: `${node.name} CPU, last hour`,
					}),
				],
			),
			silent
				? h.span(
						[h.Class("text-2xs text-muted-foreground")],
						[
							"Last metrics ",
							relativeTime(h, {
								value: new Date(node.lastSeenMs).toISOString(),
								nowMs: nowOf(data),
								timeZone: model.timeZone,
							}),
						],
					)
				: null,
		].filter((child): child is Html => child !== null),
	)
}

const nodeCardSkeleton = (h: H, key: number): Html =>
	h.div(
		[h.Key(String(key)), h.Class("flex flex-col gap-3 rounded-md border bg-card p-4")],
		[skeleton(h, "h-4 w-32"), skeleton(h, "h-14 w-full"), skeleton(h, "h-3 w-48")],
	)

// ── Cluster rail ──────────────────────────────────────────────────────────────

const clusterRail = (h: H, data: ProxmoxFixture): Html => {
	const now = nowOf(data)
	const live = data.nodes.filter((node) => !isSilent(node, now))
	const cpus = live.reduce((sum, node) => sum + node.cpus, 0)
	const cpuUsed = live.reduce((sum, node) => sum + node.cpu * node.cpus, 0)
	const memUsed = live.reduce((sum, node) => sum + node.memUsed - node.arc, 0)
	const memTotal = live.reduce((sum, node) => sum + node.memTotal, 0)
	const fullest = data.storage[0]
	const fullestFraction = fullest === undefined ? Number.NaN : ratio(fullest.used, fullest.total)
	return statRail(h, { columns: 4 }, [
		statRailItem(h, {
			eyebrow: "Nodes",
			value: `${live.length}/${data.nodes.length}`,
			subline: live.length === data.nodes.length ? "all reporting" : `${data.nodes.length - live.length} not reporting`,
			tone: live.length === data.nodes.length ? "ok" : "crit",
		}),
		statRailItem(h, {
			eyebrow: "Cluster CPU",
			value: formatPercent(cpus > 0 ? cpuUsed / cpus : Number.NaN),
			subline: `${cpus} vCPU across live nodes`,
			tone: toneOf(cpus > 0 ? cpuUsed / cpus : 0),
		}),
		statRailItem(h, {
			eyebrow: "Cluster memory",
			value: formatPercent(ratio(memUsed, memTotal)),
			subline: `${formatBytes(memUsed)} of ${formatBytes(memTotal)}, ZFS ARC excluded`,
			tone: toneOf(ratio(memUsed, memTotal)),
		}),
		statRailItem(h, {
			eyebrow: "Fullest storage",
			value: formatPercent(fullestFraction),
			subline: fullest === undefined ? "no storage" : `${fullest.name} · ${formatBytes(fullest.total - fullest.used)} free`,
			tone: toneOf(fullestFraction),
		}),
	])
}

// ── Guest table ───────────────────────────────────────────────────────────────

const GUEST_COLS = {
	name: "w-0 flex-1 min-w-56",
	node: "w-28",
	bar: "w-28",
	io: "w-36 hidden xl:flex",
	uptime: "w-20",
} as const

/** One bar per column, label-less (the column head names it): every row is one line, like Pulse. */
const barCell = (h: H, fraction: number | null, detail?: string): Html =>
	h.div(
		[h.Class(cn("flex h-4 items-center", GUEST_COLS.bar)), ...(detail === undefined ? [] : [h.Title(detail)])],
		fraction === null
			? [h.span([h.Class("font-mono text-2xs leading-none text-foreground-faint")], ["—"])]
			: [meterRows(h, [{ label: "", fraction }], { hideLabels: true, className: "w-full" })],
	)

const guestHead = (h: H): ReadonlyArray<Html> => [
	columnHead(h, { label: "Guest", width: GUEST_COLS.name }),
	columnHead(h, { label: "Node", width: GUEST_COLS.node }),
	columnHead(h, { label: "CPU", width: GUEST_COLS.bar }),
	columnHead(h, { label: "Memory", width: GUEST_COLS.bar }),
	columnHead(h, { label: "Disk", width: GUEST_COLS.bar }),
	columnHead(h, { label: "Net in / out", width: GUEST_COLS.io, align: "right" }),
	columnHead(h, { label: "Uptime", width: GUEST_COLS.uptime, align: "right" }),
]

const guestRow = (h: H, guest: ProxmoxGuest): Html => {
	const running = guest.status === "running"
	return h.div(
		[
			h.Key(guest.vmid),
			h.DataAttribute("proxmox-guest", guest.vmid),
			h.Class(
				cn(
					"flex items-center gap-4 border-b border-border-subtle px-4 py-2 last:border-0",
					!running && "text-muted-foreground",
				),
			),
		],
		[
			h.div(
				[h.Class(cn("flex items-center gap-2.5", GUEST_COLS.name))],
				[
					statusDot(h, {
						tone: running ? "ok" : "neutral",
						size: "lg",
						attributes: [h.AriaHidden(false), h.AriaLabel(guest.status)],
					}),
					h.span([h.Class("w-12 shrink-0 font-mono text-2xs tabular-nums text-muted-foreground")], [guest.vmid]),
					h.span(
						[h.Class(cn("truncate text-xs font-medium", running ? "text-foreground" : "text-muted-foreground"))],
						[guest.name],
					),
					h.span(
						[h.Class("shrink-0 rounded-xs border px-1 font-mono text-3xs uppercase text-muted-foreground")],
						[guest.type === "qemu" ? "VM" : "CT"],
					),
				],
			),
			h.span([h.Class(cn("truncate font-mono text-2xs text-foreground-soft", GUEST_COLS.node))], [guest.node]),
			barCell(h, running ? guest.cpu : null, `${guest.cpus} vCPU`),
			barCell(h, running ? ratio(guest.mem, guest.maxmem) : null, `${formatBytes(guest.mem)} / ${formatBytes(guest.maxmem)}`),
			// PVE reports VM disk usage as 0 without the guest agent; only containers carry a real figure.
			barCell(h, running && guest.type === "lxc" ? ratio(guest.disk, guest.maxdisk) : null, `${formatBytes(guest.disk)} / ${formatBytes(guest.maxdisk)}`),
			h.span(
				[h.Class(cn("justify-end truncate whitespace-nowrap text-right font-mono text-2xs tabular-nums text-foreground-soft", GUEST_COLS.io))],
				[running ? `${formatBytesPerSecond(guest.netIn)} / ${formatBytesPerSecond(guest.netOut)}` : "—"],
			),
			h.span(
				[h.Class(cn("whitespace-nowrap text-right font-mono text-2xs tabular-nums", GUEST_COLS.uptime))],
				[running ? formatUptime(guest.uptime) : "—"],
			),
		],
	)
}

const guestsSection = (h: H, model: Model, data: ProxmoxFixture): Html => {
	const q = model.query.trim().toLowerCase()
	const inNode = data.guests.filter((guest) => model.nodeFilter === undefined || guest.node === model.nodeFilter)
	const shown = inNode
		.filter((guest) => model.guestScope === undefined || guest.status === model.guestScope)
		.filter((guest) => q === "" || guest.name.toLowerCase().includes(q) || guest.vmid.includes(q))
		// Running first (busiest first), stopped after by vmid: Pulse's default reading order.
		.toSorted((a, b) =>
			a.status !== b.status ? (a.status === "running" ? -1 : 1) : a.status === "running" ? b.cpu - a.cpu : Number(a.vmid) - Number(b.vmid),
		)
	const running = inNode.filter((guest) => guest.status === "running").length
	return h.section(
		[h.Class("space-y-3"), h.DataAttribute("proxmox-section", "guests")],
		[
			sectionHeading(h, {
				title: model.nodeFilter === undefined ? "Guests" : `Guests on ${model.nodeFilter}`,
				count: String(inNode.length),
				hint: "VMs and containers, running first and busiest first",
			}),
			fleetBand(h, {
				total: inNode.length,
				noun: "guest",
				caption: `${running} running · ${inNode.length - running} stopped`,
				segments: [
					{ key: "running", count: running, className: BAR_FILL.ok },
					{ key: "stopped", count: inNode.length - running, className: "bg-foreground-faint" },
				],
				cells: [
					{ scope: "running", label: "Running", hint: "uptime > 0", value: running, tone: "ok" },
					{ scope: "stopped", label: "Stopped", hint: "powered off", value: inNode.length - running, tone: "neutral" },
				],
				activeScope: model.guestScope,
				onScopeChange: (scope) => Message.ChangedGuestScope({ scope }),
				className: FLEET_BAND_BOXED,
			}),
			searchToolbar(h, {
				id: "proxmox-guest-search",
				value: model.query,
				onInput: (value) => Message.ChangedQuery({ value }),
				onClear: Message.ChangedQuery({ value: "" }),
				placeholder: "Search name or VMID…",
				trailing: `${shown.length} of ${inNode.length} guests`,
			}),
			dataTable(
				h,
				{ ariaLabel: "Guests" },
				guestHead(h),
				shown.length === 0 ? [dataTableEmpty(h, ["No guests match."])] : shown.map((guest) => guestRow(h, guest)),
			),
		],
	)
}

// ── Storage ───────────────────────────────────────────────────────────────────

const storageRow = (h: H, store: ProxmoxStorage): Html => {
	const fraction = ratio(store.used, store.total)
	const level = severityLevel(fraction)
	return h.div(
		[h.Key(store.name), h.DataAttribute("proxmox-storage", store.name), h.Class("flex items-center gap-4 border-b border-border-subtle px-4 py-3 last:border-0")],
		[
			h.div(
				[h.Class("w-0 min-w-48 flex-1")],
				[
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							icon(h, "DatabaseIcon", { size: 14, className: "text-muted-foreground" }),
							h.span([h.Class("font-mono text-xs font-medium text-foreground")], [store.name]),
						],
					),
					metaLine(h, [store.type, store.shared ? "shared" : store.nodes.join(", ")]),
				],
			),
			h.div(
				[h.Class("flex w-80 items-center gap-3")],
				[
					meter(h, { value: Number.isFinite(fraction) ? fraction : 0, className: "h-1.5 flex-1 rounded-full", fillClassName: BAR_FILL[level], label: `${store.name} used` }),
					h.span([h.Class(cn("w-12 text-right font-mono text-xs tabular-nums", level === "ok" ? "text-foreground-soft" : `text-severity-${level}`))], [formatPercent(fraction)]),
				],
			),
			h.span(
				[h.Class("w-44 text-right font-mono text-2xs tabular-nums text-muted-foreground")],
				[`${formatBytes(store.used)} / ${formatBytes(store.total)}`],
			),
		],
	)
}

const storageSection = (h: H, data: ProxmoxFixture, compact: boolean): Html =>
	h.section(
		[h.Class("space-y-3"), h.DataAttribute("proxmox-section", "storage")],
		[
			sectionHeading(h, {
				title: "Storage",
				count: String(data.storage.length),
				hint: compact ? "fullest first" : "every PVE storage, fullest first; shared stores count once",
			}),
			dataTable(
				h,
				{ ariaLabel: "Storage" },
				[
					columnHead(h, { label: "Storage", width: "w-0 flex-1 min-w-48" }),
					columnHead(h, { label: "Used", width: "w-80" }),
					columnHead(h, { label: "Capacity", width: "w-44", align: "right" }),
				],
				(compact ? data.storage.slice(0, 4) : data.storage).map((store) => storageRow(h, store)),
			),
		],
	)

// ── Backups ───────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

const backupsSection = (h: H, model: Model, data: ProxmoxFixture): Html => {
	const now = nowOf(data)
	const latest = new Map<string, ProxmoxBackup>()
	const counts = new Map<string, number>()
	for (const backup of data.backups) {
		counts.set(backup.vmid, (counts.get(backup.vmid) ?? 0) + 1)
		const seen = latest.get(backup.vmid)
		if (seen === undefined || backup.ctime > seen.ctime) latest.set(backup.vmid, backup)
	}
	const rows = data.guests
		.map((guest) => ({ guest, last: latest.get(guest.vmid), count: counts.get(guest.vmid) ?? 0 }))
		.toSorted((a, b) => (a.last?.ctime ?? 0) - (b.last?.ctime ?? 0))
	const fresh = rows.filter((row) => row.last !== undefined && now - row.last.ctime < 1.5 * DAY_MS).length
	const stale = rows.filter((row) => row.last !== undefined && now - row.last.ctime >= 1.5 * DAY_MS).length
	const none = rows.filter((row) => row.last === undefined).length
	const totalBytes = data.backups.reduce((sum, backup) => sum + backup.size, 0)
	return h.section(
		[h.Class("space-y-3"), h.DataAttribute("proxmox-section", "backups")],
		[
			sectionHeading(h, {
				title: "Backups",
				count: String(data.backups.length),
				hint: `vzdump archives on DeepVault · ${formatBytes(totalBytes)} · oldest last-backup first`,
			}),
			statRail(h, { columns: 4 }, [
				statRailItem(h, { eyebrow: "Backed up < 36h", value: String(fresh), tone: "ok", subline: "guests with a fresh archive" }),
				statRailItem(h, { eyebrow: "Stale", value: String(stale), tone: stale > 0 ? "warn" : "ok", subline: "last archive older than 36h" }),
				statRailItem(h, { eyebrow: "Never", value: String(none), tone: none > 0 ? "crit" : "ok", subline: "no archive on DeepVault" }),
				statRailItem(h, { eyebrow: "Jobs", value: String(data.backupJobs.filter((job) => job.enabled).length), subline: `${data.backupJobs.length} defined in jobs.cfg` }),
			]),
			dataTable(
				h,
				{ ariaLabel: "Backups by guest" },
				[
					columnHead(h, { label: "Guest", width: "w-0 flex-1 min-w-56" }),
					columnHead(h, { label: "Last backup", width: "w-36" }),
					columnHead(h, { label: "Size", width: "w-24", align: "right" }),
					columnHead(h, { label: "Kept", width: "w-16", align: "right" }),
				],
				rows.map(({ guest, last, count }) => {
					const age = last === undefined ? Number.POSITIVE_INFINITY : now - last.ctime
					const tone: Tone = last === undefined ? "crit" : age >= 1.5 * DAY_MS ? "warn" : "ok"
					return h.div(
						[h.Key(guest.vmid), h.DataAttribute("proxmox-backup", guest.vmid), h.Class("flex items-center gap-4 border-b border-border-subtle px-4 py-2 last:border-0")],
						[
							h.div(
								[h.Class("flex w-0 min-w-56 flex-1 items-center gap-2.5")],
								[
									statusDot(h, { tone, size: "lg", attributes: [h.AriaHidden(false), h.AriaLabel(tone)] }),
									h.span([h.Class("w-12 shrink-0 font-mono text-2xs tabular-nums text-muted-foreground")], [guest.vmid]),
									h.span([h.Class("truncate text-xs font-medium text-foreground")], [guest.name]),
								],
							),
							h.span(
								[h.Class(cn("w-36 text-2xs", tone === "ok" ? "text-foreground-soft" : `text-severity-${tone}`))],
								[
									last === undefined
										? "never"
										: relativeTime(h, { value: new Date(last.ctime).toISOString(), nowMs: now, timeZone: model.timeZone, mono: true }),
								],
							),
							h.span([h.Class("w-24 text-right font-mono text-2xs tabular-nums text-foreground-soft")], [last === undefined ? "—" : formatBytes(last.size)]),
							h.span([h.Class("w-16 text-right font-mono text-2xs tabular-nums text-muted-foreground")], [String(count)]),
						],
					)
				}),
			),
		],
	)
}

// ── States ────────────────────────────────────────────────────────────────────

const loadingBody = (h: H): ReadonlyArray<Html> => [
	statRailLoading(h, 4, 4),
	h.div([h.Class("grid gap-3 md:grid-cols-3")], [0, 1, 2].map((key) => nodeCardSkeleton(h, key))),
	fleetBandLoading(h, 2, FLEET_BAND_BOXED),
	dataTable(h, { ariaLabel: "Guests", isWaiting: true }, guestHead(h), skeletonRows(h, 8, () => [
		skeleton(h, "h-4 w-0 min-w-56 flex-1"),
		skeleton(h, "h-3 w-28"),
		skeleton(h, "h-2 w-28"),
		skeleton(h, "h-2 w-28"),
		skeleton(h, "h-2 w-28"),
		skeleton(h, "hidden h-3 w-36 xl:block"),
		skeleton(h, "h-3 w-20"),
	])),
]

const emptyBody = (h: H): ReadonlyArray<Html> => [
	empty(h, [
		emptyHeader(h, [
			emptyMedia(h, { variant: "icon" }, [icon(h, "ServerIcon")]),
			emptyTitle(h, ["No Proxmox metrics yet"]),
			emptyDescription(h, [
				"Add an OpenTelemetry metric server in Proxmox (Datacenter → Metric Server) pointing at this Maple's ingest with an ingest key. Nodes appear within a minute.",
			]),
		]),
		h.pre(
			[h.Class("mx-auto max-w-xl overflow-x-auto rounded-md border bg-surface-sunken p-3 text-left font-mono text-2xs")],
			[
				"pvesh create /cluster/metrics/server/maple --type opentelemetry \\\n  --server 192.168.5.110 --port 80 --otel-protocol http \\\n  --otel-path /v1/metrics --otel-headers <base64 {\"Authorization\":\"Bearer …\"}>",
			],
		),
	]),
]

// ── Page ──────────────────────────────────────────────────────────────────────

const tabsBar = (h: H, model: Model): Html =>
	segmentedSelect(h, {
		size: "sm",
		ariaLabel: "Proxmox section",
		options: TABS.map((value) => ({ value, label: TAB_LABEL[value] })),
		value: model.tab,
		onChange: (tab) => Message.ClickedTab({ tab }),
	})

const liveBody = (h: H, model: Model, data: ProxmoxFixture): ReadonlyArray<Html> => {
	switch (model.tab) {
		case "storage":
			return [clusterRail(h, data), storageSection(h, data, false)]
		case "backups":
			return [backupsSection(h, model, data)]
		default:
			return [
				clusterRail(h, data),
				h.section(
					[h.Class("space-y-3"), h.DataAttribute("proxmox-section", "nodes")],
					[
						sectionHeading(h, { title: "Nodes", count: String(data.nodes.length), hint: "press a node to scope the guests below" }),
						h.div([h.Class("grid gap-3 md:grid-cols-3")], data.nodes.map((node) => nodeCard(h, node, model, data))),
					],
				),
				h.div(
					[h.Class("grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]")],
					[guestsSection(h, model, data), h.div([h.Class("min-w-0")], [storageSection(h, data, true)])],
				),
			]
	}
}

export const view = (model: Model, h: H): Html => {
	const data = dataFor(model)
	const body =
		model.state === "loading" ? loadingBody(h) : model.state === "empty" ? emptyBody(h) : liveBody(h, model, data)
	return dashboardPage(
		h,
		{
			title: "Proxmox",
			description:
				model.state === "empty"
					? "Proxmox VE clusters reporting through the native OpenTelemetry metric server."
					: `${data.cluster} · PVE ${data.pveVersion} · ${data.nodes.length} nodes, ${data.guests.length} guests`,
			actions: model.state === "empty" ? undefined : tabsBar(h, model),
			scrollClassName: "gap-8",
		},
		[h.div([h.Class("flex flex-col gap-8"), h.DataAttribute("proxmox-state", model.state)], body)],
	)
}

/** The floating review toolbar (the Cloudflare lab's pattern): data state for the mockup review. */
export const toolbar = (model: Model, h: H): Html =>
	h.div(
		[h.Class("fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-popover px-3 py-2 shadow-popup")],
		[
			h.span([h.Class("font-mono text-2xs text-muted-foreground")], ["Proxmox lab"]),
			segmentedSelect(h, {
				size: "xs",
				ariaLabel: "Lab state",
				options: LAB_STATES.map((value) => ({ value, label: STATE_LABEL[value] })),
				value: model.state,
				onChange: (state) => Message.ClickedLabState({ state }),
			}),
		],
	)

export const breadcrumbs = (model: Model): ReadonlyArray<Shell.BreadcrumbEntry> => [
	{ label: "Infrastructure" },
	{ label: "Proxmox" },
	...(model.nodeFilter === undefined ? [] : [{ label: model.nodeFilter }]),
]
