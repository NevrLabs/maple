import { formatBytes } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { meter, segmentedBar } from "@maple/views/ui/meter"
import { miniBars } from "@maple/views/ui/mini-bars"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { columnHead, dataTable, dataTableEmpty, skeletonRows } from "../../kit/data-table"
import { sectionHeading } from "../../kit/section-heading"
import { statRail, statRailItem, statRailLoading } from "../../kit/stat-rail"
import { type AtlasNode, type AtlasSnapshot, OP_KINDS, type OpKind } from "./model"

// `/infra/atlas` (NevrLabs selfhost): a replica set's health in Maple's kit, the Proxmox page's anatomy (stat
// rail, then one row per member). Desktop is a table; below `md` each member is a card.

/** Atlas's Prometheus integration scrapes every 30 s; two minutes of silence is a member down. */
export const SILENT_AFTER_MS = 120_000

export const isDown = (node: AtlasNode, nowMs: number) => node.up < 1 || nowMs - node.lastSeenMs > SILENT_AFTER_MS

/** `silent 5m`: how long a down member has been quiet (Atlas keeps reporting `up 0` for a stopped one). */
const silentFor = (node: AtlasNode, now: number) =>
	node.up < 1 ? "down" : `silent ${Math.max(1, Math.round((now - node.lastSeenMs) / 60_000))}m`

export type Role = "primary" | "secondary" | "other"
export const roleOf = (node: AtlasNode): Role => (node.state === 1 ? "primary" : node.state === 2 ? "secondary" : "other")
const ROLE_LABEL = { primary: "Primary", secondary: "Secondary", other: "Not in set" } as const

/** `noov-mongodb-live-shard-00-01-pri.l2mydt.mongodb.net:27018` → `shard-00-01` (the `-pri` is Atlas's private endpoint, not the role). */
export const shortName = (node: AtlasNode): string => {
	const label = node.host.split(".")[0] ?? node.host
	const shard = /shard-\d+-\d+/.exec(label)?.[0]
	return shard ?? label.replace(/-pri$/, "")
}

const OP_COLOR: Record<OpKind, string> = {
	query: "var(--chart-2)",
	getmore: "var(--chart-4)",
	command: "var(--chart-3)",
	update: "var(--chart-1)",
	insert: "var(--chart-5)",
	delete: "var(--severity-error)",
}

export const opsTotal = (node: AtlasNode) => OP_KINDS.reduce((sum, kind) => sum + node.ops[kind], 0)
const mib = (n: number) => n * 1024 * 1024
const ratio = (used: number, total: number) => (total > 0 ? used / total : 0)
const rate = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1))

/** Primary first, then by host. */
export const orderedNodes = (data: AtlasSnapshot): ReadonlyArray<AtlasNode> =>
	data.nodes.toSorted((a, b) => Number(roleOf(b) === "primary") - Number(roleOf(a) === "primary") || a.host.localeCompare(b.host))

// ── Pieces ────────────────────────────────────────────────────────────────────

const stateDot = <M>(h: HtmlBuilder<M>, down: boolean): Html =>
	statusDot(h, { tone: down ? "crit" : "ok", size: "lg", attributes: [h.AriaHidden(false), h.AriaLabel(down ? "down" : "up")] })

const roleBadge = <M>(h: HtmlBuilder<M>, role: Role): Html =>
	badge(h, { variant: role === "primary" ? "live" : role === "secondary" ? "muted" : "crit", size: "sm", pill: true }, [ROLE_LABEL[role]])

const opMix = <M>(h: HtmlBuilder<M>, node: AtlasNode, className: string): Html => {
	const total = opsTotal(node)
	const top = OP_KINDS.reduce((best, kind) => (node.ops[kind] > node.ops[best] ? kind : best), OP_KINDS[0])
	return hstack(h, { gap: "2", className: "w-full min-w-0" }, [
		segmentedBar(h, {
			className,
			label: OP_KINDS.map((kind) => `${kind} ${rate(node.ops[kind])}/s`).join(", "),
			segments: OP_KINDS.map((kind) => ({ key: kind, value: node.ops[kind], color: OP_COLOR[kind], title: `${kind} ${rate(node.ops[kind])}/s` })),
		}),
		typography(h, { size: "2xs", tone: "soft", mono: true, className: "whitespace-nowrap" }, [
			total > 0 ? `${top} ${Math.round((node.ops[top] / total) * 100)}%` : "idle",
		]),
	])
}

const connSpark = <M>(h: HtmlBuilder<M>, node: AtlasNode, className: string): Html => {
	const values = node.connectionsSpark
	if (values.length < 2) return typography(h, { size: "2xs", tone: "faint", mono: true }, ["—"])
	const lo = Math.min(...values)
	const hi = Math.max(...values)
	return hstack(h, { gap: "2", className: "w-full min-w-0" }, [
		miniBars(h, { values: values.map((v) => v - lo + (hi - lo) * 0.15 + 1), color: "var(--chart-2)", className, label: `${shortName(node)} connections, last 6 hours, ${Math.round(lo)} to ${Math.round(hi)}` }),
		typography(h, { size: "2xs", tone: "soft", mono: true, numeric: true, className: "whitespace-nowrap" }, [`${Math.round(lo)}–${Math.round(hi)} conns`]),
	])
}

const oplogBar = <M>(h: HtmlBuilder<M>, node: AtlasNode): Html =>
	vstack(h, { gap: "1", className: "w-full" }, [
		typography(h, { size: "xs", mono: true, numeric: true, className: "text-right" }, [`${formatBytes(node.oplogBytes)} / ${formatBytes(node.oplogMaxBytes)}`]),
		meter(h, { value: ratio(node.oplogBytes, node.oplogMaxBytes), className: "h-1 w-full rounded-full", fillClassName: "bg-chart-2", label: `${shortName(node)} oplog used` }),
	])

const twoLine = <M>(h: HtmlBuilder<M>, value: string, sub: string, className: string): Html =>
	vstack(h, { gap: "0", className: cn("items-end", className) }, [
		typography(h, { size: "xs", mono: true, numeric: true }, [value]),
		typography(h, { size: "2xs", tone: "soft", mono: true, numeric: true, className: "whitespace-nowrap" }, [sub]),
	])

// ── Rail ──────────────────────────────────────────────────────────────────────

const rail = <M>(h: HtmlBuilder<M>, data: AtlasSnapshot): Html => {
	const now = data.capturedAtMs
	const live = data.nodes.filter((node) => !isDown(node, now))
	const down = data.nodes.filter((node) => isDown(node, now)).map(shortName)
	const primaries = live.filter((node) => roleOf(node) === "primary").length
	const connections = live.reduce((sum, node) => sum + node.connections, 0)
	const minFree = live.length === 0 ? 0 : Math.min(...live.map((node) => node.connectionsFree))
	const ops = live.reduce((sum, node) => sum + opsTotal(node), 0)
	const queue = live.reduce((sum, node) => sum + node.queue, 0)
	const biggest = live.reduce<AtlasNode | undefined>((best, node) => (best === undefined || node.residentMiB > best.residentMiB ? node : best), undefined)
	return statRail(h, { columns: 5 }, [
		statRailItem(h, {
			eyebrow: "Members up",
			value: `${live.length}/${data.nodes.length}`,
			tone: down.length === 0 && primaries === 1 ? "ok" : "crit",
			subline: down.length > 0 ? `${down.join(", ")} down` : primaries === 1 ? "1 primary" : "no primary",
		}),
		statRailItem(h, { eyebrow: "Connections", value: connections.toLocaleString(), subline: `min ${minFree.toLocaleString()} free` }),
		statRailItem(h, { eyebrow: "Operations", value: `${rate(ops)}/s`, subline: "last 15 min" }),
		statRailItem(h, { eyebrow: "Lock queue", value: String(queue), tone: queue > 0 ? "warn" : "ok", subline: "ops waiting" }),
		statRailItem(h, {
			eyebrow: "Resident memory",
			value: biggest === undefined ? "—" : formatBytes(mib(biggest.residentMiB)),
			subline: biggest === undefined ? "" : `cache ${formatBytes(biggest.cacheBytes)}`,
		}),
	])
}

// ── Members ───────────────────────────────────────────────────────────────────

/** Fits the 1280 px content column; zone and the trend drop out first as it narrows. */
const COLS = {
	name: "w-0 min-w-32 flex-1",
	role: "w-22 shrink-0",
	zone: "w-22 shrink-0 hidden 2xl:flex",
	conns: "w-22 shrink-0",
	spark: "w-30 shrink-0 hidden xl:flex",
	ops: "w-14 shrink-0",
	mix: "w-30 shrink-0",
	mem: "w-24 shrink-0",
	oplog: "w-30 shrink-0",
	asserts: "w-18 shrink-0",
} as const

const head = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => [
	columnHead(h, { label: "Member", width: COLS.name }),
	columnHead(h, { label: "Role", width: COLS.role }),
	columnHead(h, { label: "Zone", width: COLS.zone }),
	columnHead(h, { label: "Connections", width: COLS.conns, align: "right" }),
	columnHead(h, { label: "6h trend", width: COLS.spark }),
	columnHead(h, { label: "Ops/s", width: COLS.ops, align: "right" }),
	columnHead(h, { label: "Operation mix", width: COLS.mix }),
	columnHead(h, { label: "Resident", width: COLS.mem, align: "right" }),
	columnHead(h, { label: "Oplog", width: COLS.oplog, align: "right" }),
	columnHead(h, { label: "Asserts/s", width: COLS.asserts, align: "right", tooltip: "regular + warning + msg + user asserts per second, last 15 min" }),
]

const row = <M>(h: HtmlBuilder<M>, node: AtlasNode, now: number): Html => {
	const down = isDown(node, now)
	return hstack(
		h,
		{
			gap: "4",
			className: cn("border-b border-border-subtle px-4 py-2.5 last:border-0", down && "opacity-50"),
			attributes: [h.Key(node.host), h.DataAttribute("atlas-node", shortName(node)), h.DataAttribute("atlas-node-state", down ? "down" : "up")],
		},
		[
			hstack(h, { gap: "2.5", className: COLS.name }, [
				stateDot(h, down),
				vstack(h, { gap: "0", className: "min-w-0" }, [
					typography(h, { size: "xs", weight: "medium", mono: true, truncate: true, attributes: [h.Title(node.host)] }, [shortName(node)]),
					...(down ? [typography(h, { size: "2xs", tone: "error", mono: true }, [silentFor(node, now)])] : []),
				]),
			]),
			h.div([h.Class(COLS.role)], [roleBadge(h, roleOf(node))]),
			typography(h, { size: "2xs", tone: "soft", mono: true, className: COLS.zone }, [node.zone]),
			twoLine(h, node.connections.toLocaleString(), `${node.connectionsFree.toLocaleString()} free`, COLS.conns),
			h.div([h.Class(COLS.spark)], [connSpark(h, node, "h-5 w-14 shrink-0")]),
			typography(h, { size: "xs", mono: true, numeric: true, className: cn("text-right", COLS.ops) }, [rate(opsTotal(node))]),
			h.div([h.Class(COLS.mix)], [opMix(h, node, "h-2 w-12 shrink-0 rounded-xs")]),
			twoLine(h, formatBytes(mib(node.residentMiB)), `cache ${formatBytes(node.cacheBytes)}`, COLS.mem),
			h.div([h.Class(COLS.oplog)], [oplogBar(h, node)]),
			typography(h, { size: "xs", mono: true, numeric: true, className: cn("text-right", COLS.asserts) }, [node.asserts.toFixed(2)]),
		],
	)
}

const fact = <M>(h: HtmlBuilder<M>, label: string, value: string): Html =>
	vstack(h, { gap: "0", className: "min-w-0" }, [
		typography(h, { size: "2xs", tone: "soft" }, [label]),
		typography(h, { size: "xs", mono: true, numeric: true, truncate: true }, [value]),
	])

const card = <M>(h: HtmlBuilder<M>, node: AtlasNode, now: number): Html => {
	const down = isDown(node, now)
	return vstack(
		h,
		{
			gap: "3",
			className: cn("min-w-0 rounded-md border bg-card p-3", down && "opacity-50"),
			attributes: [h.Key(node.host), h.DataAttribute("atlas-card", shortName(node))],
		},
		[
			hstack(h, { gap: "2", justify: "between" }, [
				hstack(h, { gap: "2", shrink: true }, [
					stateDot(h, down),
					typography(h, { size: "xs", weight: "medium", mono: true, truncate: true }, [shortName(node)]),
					...(down ? [typography(h, { size: "2xs", tone: "error", mono: true, className: "whitespace-nowrap" }, [silentFor(node, now)])] : []),
				]),
				roleBadge(h, roleOf(node)),
			]),
			h.div(
				[h.Class("grid grid-cols-2 gap-x-3 gap-y-2")],
				[
					fact(h, "Connections", `${node.connections.toLocaleString()} · ${node.connectionsFree.toLocaleString()} free`),
					fact(h, "Ops/s", rate(opsTotal(node))),
					fact(h, "Resident", formatBytes(mib(node.residentMiB))),
					fact(h, "Oplog", `${formatBytes(node.oplogBytes)} / ${formatBytes(node.oplogMaxBytes)}`),
					fact(h, "Asserts/s", node.asserts.toFixed(2)),
					fact(h, "Zone", node.zone),
				],
			),
			opMix(h, node, "h-2 min-w-0 flex-1 rounded-xs"),
			connSpark(h, node, "h-6 min-w-0 flex-1"),
		],
	)
}

const legend = <M>(h: HtmlBuilder<M>, className: string): Html =>
	hstack(h, { gap: "3", wrap: true, className }, [
		typography(h, { size: "2xs", tone: "soft" }, ["Operation mix, last 15 min:"]),
		...OP_KINDS.map((kind) =>
			hstack(h, { gap: "1", as: "span" }, [
				h.span([h.AriaHidden(true), h.Class("size-2 shrink-0 rounded-xs"), h.Style({ "background-color": OP_COLOR[kind] })], []),
				typography(h, { size: "2xs", tone: "soft", mono: true }, [kind]),
			]),
		),
	])

const members = <M>(h: HtmlBuilder<M>, data: AtlasSnapshot): Html => {
	const nodes = orderedNodes(data)
	const now = data.capturedAtMs
	return h.section(
		[h.Class("space-y-3"), h.DataAttribute("atlas-section", "members")],
		[
			sectionHeading(h, { title: "Members", count: String(nodes.length), hint: "primary first · rates over the last 15 minutes" }),
			h.div(
				[h.Class("hidden md:block")],
				[
					dataTable(h, { ariaLabel: "Replica set members" }, head(h), nodes.length === 0 ? [dataTableEmpty(h, ["No members reporting."])] : nodes.map((node) => row(h, node, now))),
					legend(h, "px-4 py-2"),
				],
			),
			vstack(h, { gap: "3", className: "md:hidden" }, [legend(h, ""), ...nodes.map((node) => card(h, node, now))]),
		],
	)
}

// ── Page ──────────────────────────────────────────────────────────────────────

export const atlasBody = <M>(h: HtmlBuilder<M>, data: AtlasSnapshot): ReadonlyArray<Html> => [rail(h, data), members(h, data)]

export const atlasDescription = (data: AtlasSnapshot): string => {
	const first = orderedNodes(data)[0]
	return first === undefined
		? "MongoDB Atlas"
		: [first.cluster, first.replicaSet, `${data.nodes.length} members`, "Prometheus integration, every 30 s"].filter((part) => part !== "").join(" · ")
}

export const atlasLoadingBody = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => [
	statRailLoading(h, 5, 5),
	dataTable(
		h,
		{ ariaLabel: "Replica set members", isWaiting: true },
		head(h),
		skeletonRows(h, 3, () => [skeleton(h, "h-4 w-0 min-w-36 flex-1"), skeleton(h, "h-3 w-24"), skeleton(h, "h-3 w-24"), skeleton(h, "h-2 w-40"), skeleton(h, "h-3 w-28")]),
	),
]

export const atlasEmptyBody = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => [
	empty(h, [
		emptyHeader(h, [
			emptyMedia(h, { variant: "icon" }, [icon(h, "DatabaseIcon")]),
			emptyTitle(h, ["No MongoDB Atlas metrics in the last hour"]),
			emptyDescription(h, [
				"Turn on Atlas's Prometheus integration (Project → Integrations → Prometheus) and scrape it into this Maple's OTLP ingest. Members appear within a minute of the first scrape.",
			]),
		]),
	]),
]
