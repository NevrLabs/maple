import { formatBytes, formatLoad, formatPercent, formatUptime } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { severityLevel } from "../../../components/infra/format"
import { BAR_FILL, SPARK_COLOR } from "../../../components/infra/severity-tokens"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { meter } from "../../../ui/meter"
import { miniBars } from "../../../ui/mini-bars"
import { segmentedSelect } from "../../../ui/segmented-select"
import { skeleton } from "../../../ui/skeleton"
import { statusDot } from "../../../ui/status-dot"
import { columnHead, dataTable, dataTableEmpty, skeletonRows } from "../../infra/kit/data-table"
import { FLEET_BAND_BOXED, fleetBand, fleetBandLoading } from "../../infra/kit/fleet-band"
import { meterRows } from "../../infra/kit/meter-rows"
import { metaLine } from "../../infra/kit/meta-line"
import { searchToolbar } from "../../infra/kit/page-parts"
import { severityDot } from "../../infra/kit/status"
import { sectionHeading } from "../../kit/section-heading"
import { statRail, statRailItem, statRailLoading } from "../../kit/stat-rail"
import {
	type GuestScope,
	type ProxmoxBackup,
	type ProxmoxGuest,
	type ProxmoxNode,
	type ProxmoxSnapshot,
	type ProxmoxStorage,
	type ProxmoxViewState,
	type Tab,
	TAB_LABEL,
	TABS,
} from "./model"
import { storageKey } from "./data"

// Pulse (rcourtman/Pulse) anatomy in Maple's kit: dense node cards with CPU/MEM/DISK bars, one guest
// table with status dots and inline bars, storage bars, and backups by guest. Shared by `/infra/proxmox`
// (live ClickHouse snapshot) and the `/lab/proxmox` mockup (fixture); every piece is an existing Maple
// primitive. The page owns its Messages: the parts take `ProxmoxActions` to build them.

export type ProxmoxActions<M> = Readonly<{
	tab: (tab: Tab) => M
	query: (value: string) => M
	scope: (scope: GuestScope | undefined) => M
	node: (node: string) => M
}>

type Ctx<M> = Readonly<{ h: HtmlBuilder<M>; actions: ProxmoxActions<M> }>

/** A node silent this long is offline (PVE pushes every ~10 s); its guests' last values are stale. */
export const SILENT_AFTER_MS = 120_000

const nowOf = (data: ProxmoxSnapshot) => data.capturedAtMs
export const isSilent = (node: ProxmoxNode, nowMs: number) => nowMs - node.lastSeenMs > SILENT_AFTER_MS
const memFraction = (node: ProxmoxNode) => (node.memTotal > 0 ? (node.memUsed - node.arc) / node.memTotal : Number.NaN)
const ratio = (used: number, total: number) => (total > 0 ? used / total : Number.NaN)
const toneOf = (fraction: number): Tone => {
	const level = severityLevel(fraction)
	return level === "ok" ? "ok" : level
}

/** A guest's shown state: its last sample is stale when its node stopped reporting, so it is unknown, not running. */
export type GuestState = "running" | "stopped" | "unknown"
export const silentNodes = (data: ProxmoxSnapshot): ReadonlySet<string> =>
	new Set(data.nodes.filter((node) => isSilent(node, nowOf(data))).map((node) => node.name))
export const guestState = (guest: ProxmoxGuest, silent: ReadonlySet<string>): GuestState =>
	silent.has(guest.node) ? "unknown" : guest.status

/** Ages: minutes, then hours up to 48h (so they read against the 36h backup threshold), then days. */
export const formatAge = (ms: number): string => {
	const minutes = Math.floor(ms / 60_000)
	if (minutes < 60) return `${Math.max(minutes, 1)}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 48) return `${hours}h`
	return `${Math.floor(hours / 24)}d`
}

/** Compact byte rate for the dense guest table, unit included: `782 B/s`, `650 KB/s`, `1.6 MB/s` (decimal). */
const compactRate = (bytesPerSecond: number): string => {
	const units = ["B/s", "KB/s", "MB/s", "GB/s"]
	let value = bytesPerSecond
	let unit = 0
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000
		unit++
	}
	return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * One step up from `text-muted-foreground` for captions, VMIDs, heads and dimmed rows: on dark the muted
 * token was too faint at these sizes (review item 8). Applied per element, not as a page-wide override.
 */
const CAPTION = "text-foreground-soft"
const OFFLINE_BADGE =
	"inline-flex items-center gap-1 whitespace-nowrap rounded-xs border border-severity-error/50 bg-severity-error/10 px-1.5 py-0.5 font-mono text-3xs font-semibold text-severity-error"

// ── Node cards ────────────────────────────────────────────────────────────────

const nodeCard = <M>({ h, actions }: Ctx<M>, node: ProxmoxNode, state: ProxmoxViewState, data: ProxmoxSnapshot): Html => {
	const now = nowOf(data)
	const silent = isSilent(node, now)
	const guests = data.guests.filter((guest) => guest.node === node.name)
	const running = guests.filter((guest) => guest.status === "running").length
	const isSelected = state.nodeFilter === node.name
	return h.button(
		[
			h.Key(node.name),
			h.Type("button"),
			h.OnClick(actions.node(node.name)),
			h.DataAttribute("proxmox-node", node.name),
			h.DataAttribute("proxmox-node-state", silent ? "offline" : "online"),
			h.Class(
				cn(
					"flex min-w-0 flex-col gap-3 rounded-md border bg-card p-4 text-left transition-colors",
					"hover:bg-surface-sunken active:bg-surface-sunken",
					isSelected && "border-primary ring-1 ring-primary",
					silent && "border-severity-error/40",
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
							silent
								? statusDot(h, { tone: "crit", size: "lg", attributes: [h.AriaHidden(false), h.AriaLabel("offline")] })
								: severityDot(h, { status: "active", size: "md" }),
							h.span([h.Class(cn("truncate font-mono text-sm font-medium", silent ? CAPTION : "text-foreground"))], [node.name]),
						],
					),
					silent
						? h.span([h.Class(OFFLINE_BADGE), h.DataAttribute("proxmox-offline-badge", "")], [`OFFLINE · ${formatAge(now - node.lastSeenMs)} ago`])
						: h.span([h.Class(cn("font-mono text-2xs", CAPTION))], [`up ${formatUptime(node.uptime)}`]),
				],
			),
			// Offline: the last values are frozen, not current. Grey them so nothing reads as healthy.
			h.div(
				[h.Class(cn(silent && "opacity-50 grayscale")), ...(silent ? [h.Title("Last values before the node stopped reporting")] : [])],
				[
					meterRows(h, [
						{ label: "CPU", fraction: node.cpu },
						{ label: "MEM", fraction: memFraction(node) },
						{ label: "DSK", fraction: ratio(node.rootUsed, node.rootTotal) },
						{ label: "SWP", fraction: ratio(node.swapUsed, node.swapTotal) },
					]),
				],
			),
			h.div(
				[h.Class(cn("flex items-center justify-between gap-3", silent && "opacity-50 grayscale"))],
				[
					h.span([h.Class(cn("font-mono text-3xs uppercase tracking-wider", CAPTION))], ["CPU · 1h"]),
					miniBars(h, {
						values: node.cpuSpark,
						color: silent ? "var(--muted-foreground)" : SPARK_COLOR[toneOf(node.cpu)],
						className: "h-5 w-40 shrink-0",
						label: `${node.name} CPU, last hour`,
					}),
				],
			),
			// Footer on its own row: specs left, guest count right — never truncated (review item 7).
			h.div(
				[h.Class(cn("flex items-center justify-between gap-3 border-t border-border-subtle pt-2 text-2xs", CAPTION))],
				[
					h.span([h.Class("min-w-0 truncate font-mono")], [`${node.cpus} vCPU · load ${formatLoad(node.load1)} · ${formatBytes(node.memTotal)}`]),
					h.span(
						[h.Class("shrink-0 whitespace-nowrap font-mono"), h.DataAttribute("proxmox-node-guests", "")],
						[silent ? `${guests.length} guests · unknown` : `${running}/${guests.length} guests running`],
					),
				],
			),
		],
	)
}

const nodeCardSkeleton = <M>(h: HtmlBuilder<M>, key: number): Html =>
	h.div(
		[h.Key(String(key)), h.Class("flex flex-col gap-3 rounded-md border bg-card p-4")],
		[skeleton(h, "h-4 w-32"), skeleton(h, "h-14 w-full"), skeleton(h, "h-3 w-48")],
	)

// ── Cluster rail ──────────────────────────────────────────────────────────────

const clusterRail = <M>(h: HtmlBuilder<M>, data: ProxmoxSnapshot): Html => {
	const now = nowOf(data)
	const live = data.nodes.filter((node) => !isSilent(node, now))
	const down = data.nodes.filter((node) => isSilent(node, now)).map((node) => node.name)
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
			valueClassName: down.length === 0 ? undefined : TONE_TEXT.crit,
			subline: down.length === 0 ? "all reporting" : `${down.join(", ")} not reporting`,
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
			subline: fullest === undefined ? "no storage" : `${storageLabel(fullest)} · ${formatBytes(fullest.total - fullest.used)} free`,
			tone: toneOf(fullestFraction),
		}),
	])
}

// ── Guest table ───────────────────────────────────────────────────────────────

const GUEST_COLS = {
	name: "w-0 flex-1 min-w-48",
	node: "w-28 shrink-0",
	bar: "w-20 shrink-0",
	io: "w-36 shrink-0 hidden xl:flex",
	uptime: "w-20 shrink-0",
} as const

/**
 * One bar per column, label-less (the column head names it): every row is one line, like Pulse. An idle guest under
 * 0.01% reads `0%`: the kit's `<0.01%` is one character too wide for the meter's fixed value slot.
 */
const barCell = <M>(h: HtmlBuilder<M>, fraction: number | null, detail?: string): Html =>
	h.div(
		[h.Class(cn("flex h-4 items-center", GUEST_COLS.bar)), ...(detail === undefined ? [] : [h.Title(detail)])],
		fraction === null
			? [h.span([h.Class("font-mono text-2xs leading-none text-foreground-faint")], ["—"])]
			: [meterRows(h, [{ label: "", fraction: fraction < 0.0001 ? 0 : fraction }], { hideLabels: true, className: "w-full" })],
	)

const guestHead = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => [
	columnHead(h, { label: "Guest", width: GUEST_COLS.name }),
	columnHead(h, { label: "Node", width: GUEST_COLS.node }),
	columnHead(h, { label: "CPU", width: GUEST_COLS.bar }),
	columnHead(h, { label: "Memory", width: GUEST_COLS.bar }),
	columnHead(h, { label: "Disk", width: GUEST_COLS.bar }),
	columnHead(h, { label: "Net in/out", width: GUEST_COLS.io, align: "right" }),
	columnHead(h, { label: "Uptime", width: GUEST_COLS.uptime, align: "right" }),
]

const STATE_TONE = { running: "ok", stopped: "neutral", unknown: "warn" } as const

const guestRow = <M>(h: HtmlBuilder<M>, guest: ProxmoxGuest, state: GuestState): Html => {
	const running = state === "running"
	return h.div(
		[
			h.Key(guest.vmid),
			h.DataAttribute("proxmox-guest", guest.vmid),
			h.DataAttribute("proxmox-guest-state", state),
			h.Class(cn("flex items-center gap-4 border-b border-border-subtle px-4 py-2 last:border-0", !running && CAPTION)),
		],
		[
			h.div(
				[h.Class(cn("flex items-center gap-2.5", GUEST_COLS.name))],
				[
					statusDot(h, {
						tone: STATE_TONE[state],
						size: "lg",
						attributes: [
							h.AriaHidden(false),
							h.AriaLabel(state === "unknown" ? "unknown: node not reporting, last values stale" : state),
							h.Title(state === "unknown" ? `Unknown — ${guest.node} is not reporting; last values are stale` : state),
						],
					}),
					h.span(
						[h.Class(cn("w-16 shrink-0 font-mono text-2xs tabular-nums", CAPTION)), h.Title(guest.type === "qemu" ? "virtual machine" : "container")],
						[`${guest.vmid} `, h.span([h.Class("text-3xs uppercase opacity-70")], [guest.type === "qemu" ? "vm" : "ct"])],
					),
					h.span(
						[h.Class(cn("min-w-0 truncate text-xs font-medium", running ? "text-foreground" : CAPTION)), h.Title(guest.name)],
						[guest.name],
					),
				],
			),
			h.span([h.Class(cn("truncate font-mono text-2xs", CAPTION, GUEST_COLS.node))], [guest.node]),
			barCell(h, running ? guest.cpu : null, `${guest.cpus} vCPU`),
			barCell(h, running ? ratio(guest.mem, guest.maxmem) : null, `${formatBytes(guest.mem)} / ${formatBytes(guest.maxmem)}`),
			// PVE reports VM disk usage as 0 without the guest agent; only containers carry a real figure.
			barCell(h, running && guest.type === "lxc" ? ratio(guest.disk, guest.maxdisk) : null, `${formatBytes(guest.disk)} / ${formatBytes(guest.maxdisk)}`),
			h.span(
				[h.Class(cn("shrink-0 justify-end whitespace-nowrap pl-2 text-right font-mono text-2xs tabular-nums", CAPTION, GUEST_COLS.io))],
				[running ? `${compactRate(guest.netIn)} / ${compactRate(guest.netOut)}` : "—"],
			),
			h.span(
				[h.Class(cn("whitespace-nowrap text-right font-mono text-2xs tabular-nums", GUEST_COLS.uptime))],
				[running ? formatUptime(guest.uptime) : "—"],
			),
		],
	)
}

const STATE_ORDER = { running: 0, unknown: 1, stopped: 2 } as const

/** The guest list as shown: node + scope + search, running first (busiest first), then stale, then stopped by VMID. */
export const shownGuests = (
	state: ProxmoxViewState,
	data: ProxmoxSnapshot,
): ReadonlyArray<Readonly<{ guest: ProxmoxGuest; state: GuestState }>> => {
	const silent = silentNodes(data)
	const q = state.query.trim().toLowerCase()
	return data.guests
		.filter((guest) => state.nodeFilter === undefined || guest.node === state.nodeFilter)
		.map((guest) => ({ guest, state: guestState(guest, silent) }))
		.filter((row) => state.guestScope === undefined || row.state === state.guestScope)
		.filter(({ guest }) => q === "" || guest.name.toLowerCase().includes(q) || guest.vmid.includes(q))
		.toSorted((a, b) =>
			a.state !== b.state
				? STATE_ORDER[a.state] - STATE_ORDER[b.state]
				: (a.state === "running" ? b.guest.cpu - a.guest.cpu : 0) || Number(a.guest.vmid) - Number(b.guest.vmid),
		)
}

const guestsSection = <M>({ h, actions }: Ctx<M>, state: ProxmoxViewState, data: ProxmoxSnapshot): Html => {
	const silent = silentNodes(data)
	const inNode = data.guests.filter((guest) => state.nodeFilter === undefined || guest.node === state.nodeFilter)
	const shown = shownGuests(state, data)
	const count = (s: GuestState) => inNode.filter((guest) => guestState(guest, silent) === s).length
	const running = count("running")
	const stopped = count("stopped")
	const unknown = count("unknown")
	return h.section(
		[h.Class("space-y-3"), h.DataAttribute("proxmox-section", "guests")],
		[
			sectionHeading(h, {
				title: state.nodeFilter === undefined ? "Guests" : `Guests on ${state.nodeFilter}`,
				count: String(inNode.length),
				hint: "VMs and containers, running first and busiest first",
			}),
			fleetBand(h, {
				total: inNode.length,
				noun: "guest",
				caption: [`${running} running`, ...(unknown > 0 ? [`${unknown} unknown`] : []), `${stopped} stopped`].join(" · "),
				segments: [
					{ key: "running", count: running, className: BAR_FILL.ok },
					{ key: "unknown", count: unknown, className: BAR_FILL.warn },
					{ key: "stopped", count: stopped, className: "bg-foreground-faint" },
				],
				cells: [
					{ scope: "running", label: "Running", hint: "uptime > 0", value: running, tone: "ok" },
					...(unknown > 0
						? [{ scope: "unknown" as const, label: "Unknown", hint: "node not reporting", value: unknown, tone: "warn" as const }]
						: []),
					{ scope: "stopped", label: "Stopped", hint: "powered off", value: stopped, tone: "neutral" },
				],
				activeScope: state.guestScope,
				onScopeChange: (scope) => actions.scope(scope),
				className: FLEET_BAND_BOXED,
			}),
			searchToolbar(h, {
				id: "proxmox-guest-search",
				value: state.query,
				onInput: (value) => actions.query(value),
				onClear: actions.query(""),
				placeholder: "Search name or VMID…",
				trailing: `${shown.length} of ${inNode.length} guests`,
			}),
			dataTable(
				h,
				{ ariaLabel: "Guests" },
				guestHead(h),
				shown.length === 0 ? [dataTableEmpty(h, ["No guests match."])] : shown.map(({ guest, state: s }) => guestRow(h, guest, s)),
			),
		],
	)
}

// ── Storage ───────────────────────────────────────────────────────────────────

/** PATCHES #14: a node-local store reads `node · name`; shared ones by name. */
const storageLabel = (store: ProxmoxStorage): string =>
	store.shared || store.nodes.length !== 1 ? store.name : `${store.nodes[0]} · ${store.name}`

const storageRow = <M>(h: HtmlBuilder<M>, store: ProxmoxStorage, compact: boolean, inHostGroup = false): Html => {
	const key = storageKey(store)
	const fraction = ratio(store.used, store.total)
	const level = severityLevel(fraction)
	const pct = h.span(
		[h.Class(cn("w-11 shrink-0 text-right font-mono text-xs tabular-nums", level === "ok" ? CAPTION : TONE_TEXT[level]))],
		[formatPercent(fraction)],
	)
	const bar = meter(h, {
		value: Number.isFinite(fraction) ? fraction : 0,
		className: "h-1.5 min-w-0 flex-1 rounded-full",
		fillClassName: BAR_FILL[level],
		label: `${storageLabel(store)} used`,
	})
	const free = `${formatBytes(Math.max(store.total - store.used, 0))} free of ${formatBytes(store.total)}`
	const title = h.div(
		[h.Class("flex min-w-0 items-center gap-2")],
		[
			icon(h, "DatabaseIcon", { size: 14, className: "shrink-0 text-muted-foreground" }),
			h.span([h.Class("truncate font-mono text-xs font-medium text-foreground")], [compact ? storageLabel(store) : store.name]),
		],
	)
	// Narrow side panel: two lines per store (name + % / bar + free), so nothing runs to the edge.
	if (compact)
		return h.div(
			[h.Key(key), h.DataAttribute("proxmox-storage", key), h.Class("flex flex-col gap-1.5 border-b border-border-subtle px-4 py-2.5 last:border-0")],
			[
				h.div([h.Class("flex items-center justify-between gap-3")], [title, pct]),
				h.div(
					[h.Class("flex items-center gap-3")],
					[bar, h.span([h.Class(cn("shrink-0 whitespace-nowrap font-mono text-3xs tabular-nums", CAPTION))], [free])],
				),
			],
		)
	return h.div(
		[h.Key(key), h.DataAttribute("proxmox-storage", key), h.Class(cn("flex items-center gap-4 border-b border-border-subtle px-4 py-3 last:border-0", inHostGroup && "pl-8"))],
		[
			h.div([h.Class("w-0 min-w-48 flex-1")], [title, metaLine(h, [store.type === "" ? "storage" : store.type, store.shared ? `shared · ${store.nodes.length} nodes` : store.nodes.join(", ")])]),
			h.div([h.Class("flex w-80 items-center gap-3")], [bar, pct]),
			h.span([h.Class(cn("w-56 whitespace-nowrap pr-1 text-right font-mono text-2xs tabular-nums", CAPTION))], [free]),
		],
	)
}

const COMPACT_STORAGE = 4

/** PATCHES #14: a group header inside the storage table ("Cluster storage", then one per host). */
const storageGroupHeader = <M>(h: HtmlBuilder<M>, id: string, label: string, hint: string): Html =>
	h.div(
		[
			h.Key(`group-${id}`),
			h.DataAttribute("proxmox-storage-group", id),
			h.Class("flex items-center gap-2 border-b border-border-subtle bg-surface-sunken px-4 py-1.5"),
		],
		[
			icon(h, id === "cluster" ? "DatabaseIcon" : "ServerIcon", { size: 12, className: "shrink-0 text-muted-foreground" }),
			h.span([h.Class("font-mono text-2xs font-medium text-foreground")], [label]),
			h.span([h.Class(cn("text-2xs", CAPTION))], [hint]),
		],
	)

/** Shared stores once under "Cluster storage"; node-local ones under their host (hosts by name). */
const groupedStorageRows = <M>(h: HtmlBuilder<M>, storage: ReadonlyArray<ProxmoxStorage>): ReadonlyArray<Html> => {
	const shared = storage.filter((store) => store.shared || store.nodes.length !== 1)
	const local = storage.filter((store) => !(store.shared || store.nodes.length !== 1))
	const hosts = [...new Set(local.map((store) => store.nodes[0] ?? ""))].sort()
	return [
		...(shared.length === 0
			? []
			: [
					storageGroupHeader(h, "cluster", "Cluster storage", `${shared.length} shared · counted once`),
					...shared.map((store) => storageRow(h, store, false)),
				]),
		...hosts.flatMap((host) => {
			const rows = local.filter((store) => store.nodes[0] === host)
			return [
				storageGroupHeader(h, host, host, `${rows.length} local`),
				...rows.map((store) => storageRow(h, store, false, true)),
			]
		}),
	]
}

const storageSection = <M>({ h, actions }: Ctx<M>, data: ProxmoxSnapshot, compact: boolean): Html => {
	const shown = compact ? data.storage.slice(0, COMPACT_STORAGE) : data.storage
	const hidden = data.storage.length - shown.length
	return h.section(
		[h.Class("space-y-3"), h.DataAttribute("proxmox-section", "storage")],
		[
			sectionHeading(h, {
				title: "Storage",
				count: compact && hidden > 0 ? `${shown.length} of ${data.storage.length}` : String(data.storage.length),
				hint: compact ? "fullest first" : "shared stores once, local stores under their host; fullest first",
			}),
			dataTable(
				h,
				{ ariaLabel: "Storage" },
				compact
					? [columnHead(h, { label: "Storage · used · free", width: "w-full" })]
					: [
							columnHead(h, { label: "Storage", width: "w-0 flex-1 min-w-48" }),
							columnHead(h, { label: "Used", width: "w-80" }),
							columnHead(h, { label: "Free / capacity", width: "w-56", align: "right" }),
						],
				[
					...(shown.length === 0
						? [dataTableEmpty(h, ["No storage reported."])]
						: compact
							? shown.map((store) => storageRow(h, store, true))
							: groupedStorageRows(h, shown)),
					...(hidden > 0
						? [
								h.button(
									[
										h.Type("button"),
										h.OnClick(actions.tab("storage")),
										h.DataAttribute("proxmox-storage-more", String(hidden)),
										h.Class("flex w-full items-center justify-between px-4 py-2 text-2xs font-medium text-primary hover:bg-surface-sunken"),
									],
									[`+${hidden} more storage`, h.span([h.Class("font-mono")], ["Storage tab →"])],
								),
							]
						: []),
				],
			),
		],
	)
}

// ── Backups ───────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

const BACKUP_TEXT: Record<"ok" | "warn" | "crit", string> = {
	ok: CAPTION,
	warn: TONE_TEXT.warn,
	crit: TONE_TEXT.crit,
}

const isSized = (backup: ProxmoxBackup) => backup.sizeKnown !== false

/** A byte sum over archives; `≥` when any of them has an unknown size (the sum is then a floor). */
const sumLabel = (bytes: number, hasUnknown: boolean): string =>
	hasUnknown && bytes === 0 ? "—" : `${hasUnknown ? "≥ " : ""}${formatBytes(bytes)}`

const backupsSection = <M>(h: HtmlBuilder<M>, data: ProxmoxSnapshot): Html => {
	const now = nowOf(data)
	const guestIds = new Set(data.guests.map((guest) => guest.vmid))
	const latest = new Map<string, ProxmoxBackup>()
	const kept = new Map<string, { count: number; bytes: number; unknown: boolean }>()
	for (const backup of data.backups) {
		const k = kept.get(backup.vmid) ?? { count: 0, bytes: 0, unknown: false }
		kept.set(backup.vmid, { count: k.count + 1, bytes: k.bytes + backup.size, unknown: k.unknown || !isSized(backup) })
		const seen = latest.get(backup.vmid)
		if (seen === undefined || backup.ctime > seen.ctime) latest.set(backup.vmid, backup)
	}
	const rows = data.guests
		.map((guest) => ({ guest, last: latest.get(guest.vmid), kept: kept.get(guest.vmid) ?? { count: 0, bytes: 0, unknown: false } }))
		.toSorted((a, b) => (a.last?.ctime ?? 0) - (b.last?.ctime ?? 0) || Number(a.guest.vmid) - Number(b.guest.vmid))
	// Archives of guests that no longer exist: listed as one row so the column totals add up to the header.
	const orphans = data.backups.filter((backup) => !guestIds.has(backup.vmid))
	const orphanIds = new Set(orphans.map((backup) => backup.vmid))
	const orphanBytes = orphans.reduce((sum, backup) => sum + backup.size, 0)
	const orphanUnknown = orphans.some((backup) => !isSized(backup))
	const fresh = rows.filter((row) => row.last !== undefined && now - row.last.ctime < 1.5 * DAY_MS).length
	const stale = rows.filter((row) => row.last !== undefined && now - row.last.ctime >= 1.5 * DAY_MS).length
	const none = rows.filter((row) => row.last === undefined).length
	const totalBytes = data.backups.reduce((sum, backup) => sum + backup.size, 0)
	const unsized = data.backups.filter((backup) => !isSized(backup)).length
	const storages = [...new Set(data.backups.map((backup) => backup.storage))].sort()
	const enabledJobs = data.backupJobs.filter((job) => job.enabled).length
	const cell = (className: string, text: string) => h.span([h.Class(cn("text-right font-mono text-2xs tabular-nums", className))], [text])
	const asOf =
		data.backupsAsOfMs === null
			? "backup collector has not reported yet"
			: `backup data as of ${formatAge(Math.max(now - data.backupsAsOfMs, 0))} ago`
	return h.section(
		[h.Class("space-y-3"), h.DataAttribute("proxmox-section", "backups")],
		[
			sectionHeading(h, {
				title: "Backups",
				count: `${data.backups.length} archives · ${sumLabel(totalBytes, unsized > 0)}`,
				hint: `vzdump archives on ${storages.length === 0 ? "backup storage" : storages.join(", ")}, oldest last-backup first · ${asOf}`,
			}),
			statRail(h, { columns: 4 }, [
				statRailItem(h, { eyebrow: "Backed up < 36h", value: String(fresh), tone: "ok", valueClassName: "text-success-foreground", subline: `of ${data.guests.length} guests` }),
				statRailItem(h, { eyebrow: "Stale", value: String(stale), tone: stale > 0 ? "warn" : "ok", subline: "last archive older than 36h" }),
				statRailItem(h, { eyebrow: "Never", value: String(none), tone: none > 0 ? "crit" : "ok", subline: "no archive on any backup storage" }),
				statRailItem(h, {
					eyebrow: "Jobs enabled",
					value: `${enabledJobs}/${data.backupJobs.length}`,
					subline: `${data.backupJobs.length - enabledJobs} disabled in jobs.cfg`,
				}),
			]),
			dataTable(
				h,
				{ ariaLabel: "Backups by guest" },
				[
					columnHead(h, { label: "Guest", width: "w-0 flex-1 min-w-56" }),
					columnHead(h, { label: "Last backup", width: "w-28" }),
					columnHead(h, { label: "Latest size", width: "w-24", align: "right" }),
					columnHead(h, { label: "Archives kept", width: "w-28", align: "right" }),
					columnHead(h, { label: "Total size", width: "w-24", align: "right" }),
				],
				[
					...rows.map(({ guest, last, kept: k }) => {
						const age = last === undefined ? Number.POSITIVE_INFINITY : now - last.ctime
						const tone = last === undefined ? "crit" : age >= 1.5 * DAY_MS ? "warn" : "ok"
						return h.div(
							[h.Key(guest.vmid), h.DataAttribute("proxmox-backup", guest.vmid), h.DataAttribute("proxmox-backup-tone", tone), h.Class("flex items-center gap-4 border-b border-border-subtle px-4 py-2 last:border-0")],
							[
								h.div(
									[h.Class("flex w-0 min-w-56 flex-1 items-center gap-2.5")],
									[
										statusDot(h, { tone, size: "lg", attributes: [h.AriaHidden(false), h.AriaLabel(tone)] }),
										h.span([h.Class(cn("w-12 shrink-0 font-mono text-2xs tabular-nums", CAPTION))], [guest.vmid]),
										h.span([h.Class("truncate text-xs font-medium text-foreground")], [guest.name]),
									],
								),
								h.span(
									[h.Class(cn("w-28 font-mono text-2xs", BACKUP_TEXT[tone])), ...(last === undefined ? [] : [h.Title(new Date(last.ctime).toISOString())])],
									[last === undefined ? "never" : `${formatAge(age)} ago`],
								),
								cell(cn("w-24", CAPTION), last === undefined || !isSized(last) ? "—" : formatBytes(last.size)),
								cell(cn("w-28", CAPTION), String(k.count)),
								cell(cn("w-24", CAPTION), k.count === 0 ? "—" : sumLabel(k.bytes, k.unknown)),
							],
						)
					}),
					...(orphans.length > 0
						? [
								h.div(
									[h.Key("orphans"), h.DataAttribute("proxmox-backup", "orphans"), h.Class("flex items-center gap-4 border-b border-border-subtle bg-surface-sunken/50 px-4 py-2 last:border-0")],
									[
										h.div(
											[h.Class(cn("flex w-0 min-w-56 flex-1 items-center gap-2.5 text-xs", CAPTION))],
											[statusDot(h, { tone: "neutral", size: "lg" }), `Deleted guests (${[...orphanIds].sort((a, b) => Number(a) - Number(b)).join(", ")})`],
										),
										cell(cn("w-28", CAPTION), ""),
										cell(cn("w-24", CAPTION), "—"),
										cell(cn("w-28", CAPTION), String(orphans.length)),
										cell(cn("w-24", CAPTION), sumLabel(orphanBytes, orphanUnknown)),
									],
								),
							]
						: []),
					// Totals: equal the header by construction.
					h.div(
						[h.Key("totals"), h.DataAttribute("proxmox-backup-totals", `${data.backups.length}|${totalBytes}`), h.Class("flex items-center gap-4 border-t px-4 py-2 font-medium")],
						[
							h.span([h.Class("w-0 min-w-56 flex-1 text-2xs text-foreground")], ["Total"]),
							cell("w-28", ""),
							cell("w-24", ""),
							cell("w-28 text-foreground", String(data.backups.length)),
							cell("w-24 text-foreground", sumLabel(totalBytes, unsized > 0)),
						],
					),
					// The caveat on its own line under the totals, so it never reads as part of a figure.
					...(unsized > 0
						? [
								h.p(
									[h.Key("unsized"), h.DataAttribute("proxmox-backup-unsized", String(unsized)), h.Class(cn("px-4 pb-2.5 text-2xs", CAPTION))],
									[
										`≥ marks a sum that leaves out unknown sizes (—): ${unsized} ${unsized === 1 ? "archive is" : "archives are"} older than PVE's task history.`,
									],
								),
							]
						: []),
				],
			),
		],
	)
}

// ── States ────────────────────────────────────────────────────────────────────

export const proxmoxLoadingBody = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => [
	statRailLoading(h, 4, 4),
	h.div([h.Class("grid gap-3 md:grid-cols-3")], [0, 1, 2].map((key) => nodeCardSkeleton(h, key))),
	fleetBandLoading(h, 2, FLEET_BAND_BOXED),
	dataTable(
		h,
		{ ariaLabel: "Guests", isWaiting: true },
		guestHead(h),
		skeletonRows(h, 8, () => [
			skeleton(h, "h-4 w-0 min-w-48 flex-1"),
			skeleton(h, "h-3 w-28"),
			skeleton(h, "h-2 w-20"),
			skeleton(h, "h-2 w-20"),
			skeleton(h, "h-2 w-20"),
			skeleton(h, "hidden h-3 w-36 xl:block"),
			skeleton(h, "h-3 w-20"),
		]),
	),
]

export const proxmoxEmptyBody = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => [
	empty(h, [
		emptyHeader(h, [
			emptyMedia(h, { variant: "icon" }, [icon(h, "StackPerspectiveIcon")]),
			emptyTitle(h, ["No Proxmox metrics in the last hour"]),
			emptyDescription(h, [
				"Add an OpenTelemetry metric server in Proxmox (Datacenter → Metric Server) pointing at this Maple's ingest with an ingest key. Nodes appear within a minute.",
			]),
		]),
		h.pre(
			[h.Class("mx-auto max-w-xl overflow-x-auto rounded-md border bg-surface-sunken p-3 text-left font-mono text-2xs")],
			[
				"pvesh create /cluster/metrics/server/maple --type opentelemetry \\\n  --server <maple ingest host> --port 3474 --otel-protocol http \\\n  --otel-path /v1/metrics --otel-headers <base64 {\"Authorization\":\"Bearer …\"}>",
			],
		),
	]),
]

// ── Page ──────────────────────────────────────────────────────────────────────

export const proxmoxTabs = <M>(h: HtmlBuilder<M>, tab: Tab, actions: ProxmoxActions<M>): Html =>
	segmentedSelect(h, {
		size: "sm",
		ariaLabel: "Proxmox section",
		options: TABS.map((value) => ({ value, label: TAB_LABEL[value] })),
		value: tab,
		onChange: (next) => actions.tab(next),
	})

export const proxmoxBody = <M>(
	h: HtmlBuilder<M>,
	state: ProxmoxViewState,
	data: ProxmoxSnapshot,
	actions: ProxmoxActions<M>,
): ReadonlyArray<Html> => {
	const ctx: Ctx<M> = { h, actions }
	switch (state.tab) {
		case "storage":
			return [clusterRail(h, data), storageSection(ctx, data, false)]
		case "backups":
			return [backupsSection(h, data)]
		default:
			return [
				clusterRail(h, data),
				h.section(
					[h.Class("space-y-3"), h.DataAttribute("proxmox-section", "nodes")],
					[
						sectionHeading(h, { title: "Nodes", count: String(data.nodes.length), hint: "press a node to scope the guests below" }),
						h.div([h.Class("grid gap-3 md:grid-cols-3")], data.nodes.map((node) => nodeCard(ctx, node, state, data))),
					],
				),
				h.div(
					[h.Class("grid gap-6 2xl:grid-cols-[minmax(0,1fr)_22rem]")],
					[guestsSection(ctx, state, data), h.div([h.Class("min-w-0")], [storageSection(ctx, data, true)])],
				),
			]
	}
}

export const proxmoxDescription = (data: ProxmoxSnapshot): string =>
	`${data.cluster} · PVE ${data.pveVersion} · ${data.nodes.length} nodes, ${data.guests.length} guests`
