import { formatBytes } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, Order, Result, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { meter } from "@maple/views/ui/meter"
import { miniBars } from "@maple/views/ui/mini-bars"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { columnHead, DATA_TABLE_ROW, dataTable, dataTableEmpty, skeletonRows } from "../../kit/data-table"
import { sectionHeading } from "../../kit/section-heading"
import { statRail, statRailItem, statRailLoading } from "../../kit/stat-rail"
import { type PgInstance, type PostgresSnapshot, SILENT_AFTER_MS } from "./model"

// `/infra/postgres` (NevrLabs selfhost): instance health in Maple's kit, the Atlas page's anatomy (stat rail,
// then one row per instance). Patroni columns read "—" for a standalone instance (RDS, a single server).

const lastSeen = (node: PgInstance) => Math.max(node.lastSeenMs, node.patroni?.lastSeenMs ?? 0)

export const isDown = (node: PgInstance, nowMs: number) =>
	nowMs - lastSeen(node) > SILENT_AFTER_MS || (node.patroni !== null && node.patroni.running < 1)

const silentFor = (node: PgInstance, now: number) =>
	node.patroni !== null && node.patroni.running < 1 && now - lastSeen(node) <= SILENT_AFTER_MS
		? "postgres stopped"
		: `silent ${Math.max(1, Math.round((now - lastSeen(node)) / 60_000))}m`

export type Role = "leader" | "replica" | "standalone" | "unknown"
export const roleOf = (node: PgInstance): Role =>
	node.patroni === null
		? "standalone"
		: node.patroni.primary === 1
			? "leader"
			: node.patroni.replica === 1
				? "replica"
				: "unknown"
const ROLE_LABEL = { leader: "Leader", replica: "Replica", standalone: "Standalone", unknown: "No role" } as const
/** A down member's role is its last report, so it reads as history: "was leader". */
const DOWN_LABEL = { leader: "Down · was leader", replica: "Down · was replica", standalone: "Down", unknown: "Down" } as const

/** 170009 → 17.9, 90624 → 9.6.24. */
export const versionLabel = (v: number): string =>
	v <= 0 ? "—" : v >= 100_000 ? `${Math.floor(v / 10000)}.${v % 10000}` : `${Math.floor(v / 10000)}.${Math.floor(v / 100) % 100}.${v % 100}`

const ratio = (used: number, total: number) => (total > 0 ? used / total : 0)
const rate = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1))
const pct = (n: number) => `${(n * 100).toFixed(n >= 0.995 ? 2 : 1)}%`

const ROLE_RANK = { leader: 0, replica: 1, standalone: 2, unknown: 3 } as const

/** Leaders first, then replicas, then by host. */
export const orderedInstances = (data: PostgresSnapshot): ReadonlyArray<PgInstance> =>
	Arr.sort(
		data.instances,
		Order.combine(
			Order.mapInput(Order.Number, (node: PgInstance) => ROLE_RANK[roleOf(node)]),
			Order.mapInput(Order.String, (node: PgInstance) => node.host),
		),
	)

/** Live leaders per Patroni scope; a scope with anything but one has lost (or split) its leader. */
export const leadersByScope = (data: PostgresSnapshot): ReadonlyMap<string, number> => {
	const now = data.capturedAtMs
	const scopes = new Map<string, number>()
	for (const node of data.instances) {
		if (node.patroni === null) continue
		const live = !isDown(node, now) && roleOf(node) === "leader"
		scopes.set(node.patroni.scope, (scopes.get(node.patroni.scope) ?? 0) + (live ? 1 : 0))
	}
	return scopes
}

// ── Pieces ────────────────────────────────────────────────────────────────────

const stateDot = <M>(h: HtmlBuilder<M>, down: boolean): Html =>
	statusDot(h, { tone: down ? "crit" : "ok", size: "lg", attributes: [h.AriaHidden(false), h.AriaLabel(down ? "down" : "up")] })

const roleBadge = <M>(h: HtmlBuilder<M>, role: Role, down: boolean): Html =>
	badge(
		h,
		{ variant: down || role === "unknown" ? "crit" : role === "leader" ? "live" : "muted", size: "sm", pill: true },
		[down ? DOWN_LABEL[role] : ROLE_LABEL[role]],
	)

/** Relative bars over the 6 h range (a flat series has no bars: it reads "steady"). */
const sparkBars = (values: ReadonlyArray<number>, lo: number, hi: number): ReadonlyArray<number> =>
	Arr.map(values, (v) => v - lo + (hi - lo) * 0.15 + 1)

const connSpark = <M>(h: HtmlBuilder<M>, node: PgInstance, className: string): Html => {
	const values = node.connectionsSpark
	if (values.length < 2) return typography(h, { size: "2xs", tone: "faint", mono: true }, ["—"])
	const lo = Math.min(...values)
	const hi = Math.max(...values)
	if (Math.round(hi) === Math.round(lo)) {
		return typography(h, { size: "2xs", tone: "soft", mono: true, numeric: true }, [`steady ${Math.round(lo)}`])
	}
	return hstack(h, { gap: "2", className: "w-full min-w-0" }, [
		miniBars(h, {
			values: sparkBars(values, lo, hi),
			color: "var(--chart-2)",
			className,
			label: `${node.host} connections, last 6 hours, ${Math.round(lo)} to ${Math.round(hi)}`,
		}),
		typography(h, { size: "2xs", tone: "soft", mono: true, numeric: true, className: "whitespace-nowrap" }, [
			`${Math.round(lo)}–${Math.round(hi)}`,
		]),
	])
}

const connMeter = <M>(h: HtmlBuilder<M>, node: PgInstance): Html => {
	const used = ratio(node.connections, node.maxConnections)
	return vstack(h, { gap: "1", className: "w-full" }, [
		typography(h, { size: "xs", mono: true, numeric: true, className: "text-right" }, [
			node.maxConnections > 0 ? `${node.connections} / ${node.maxConnections}` : String(node.connections),
		]),
		meter(h, {
			value: used,
			className: "h-1 w-full",
			tone: used >= 0.85 ? "crit" : used >= 0.7 ? "warn" : "ok",
			label: `${node.host} connections used`,
		}),
	])
}

/** Replication: a replica's bytes behind its leader; a leader's timeline. */
const replicationText = (node: PgInstance): string => {
	const p = node.patroni
	if (p === null) return "—"
	if (roleOf(node) === "leader") return `timeline ${p.timeline}`
	if (node.lagBytes === null) return p.streaming === 1 ? "streaming" : "not streaming"
	return `${formatBytes(node.lagBytes)} behind`
}

const replicationSub = (node: PgInstance): string => {
	const p = node.patroni
	if (p === null) return ""
	if (roleOf(node) === "leader") return p.paused === 1 ? "cluster paused" : p.scope
	return p.streaming === 1 ? "streaming" : "not streaming"
}

const twoLine = <M>(h: HtmlBuilder<M>, value: string, sub: string, className: string, subTone: "soft" | "error" = "soft"): Html =>
	vstack(h, { gap: "0", className: cn("items-end", className) }, [
		typography(h, { size: "xs", mono: true, numeric: true, className: "whitespace-nowrap" }, [value]),
		typography(h, { size: "2xs", tone: subTone, mono: true, numeric: true, className: "whitespace-nowrap" }, [sub]),
	])

// ── Rail ──────────────────────────────────────────────────────────────────────

const rail = <M>(h: HtmlBuilder<M>, data: PostgresSnapshot): Html => {
	const now = data.capturedAtMs
	const live = Arr.filter(data.instances, (node) => !isDown(node, now))
	const down = Arr.map(
		Arr.filter(data.instances, (node) => isDown(node, now)),
		(node) => node.host,
	)
	const scopes = leadersByScope(data)
	const badScopes = Arr.filter([...scopes], ([, n]) => n !== 1)
	const lags = Arr.filterMap(live, (node) => (node.lagBytes === null ? Result.failVoid : Result.succeed(node.lagBytes)))
	const worstLag = Arr.isReadonlyArrayNonEmpty(lags) ? Arr.max(lags, Order.Number) : null
	const used = (node: PgInstance) => ratio(node.connections, node.maxConnections)
	const busiest = Arr.isReadonlyArrayNonEmpty(live) ? Arr.max(live, Order.mapInput(Order.Number, used)) : undefined
	const busiestRatio = busiest === undefined ? 0 : used(busiest)
	const tps = Arr.reduce(live, 0, (sum, node) => sum + node.tps)
	const hits = Arr.filterMap(live, (node) => (node.cacheHit === null ? Result.failVoid : Result.succeed(node.cacheHit)))
	const worstHit = Arr.isReadonlyArrayNonEmpty(hits) ? Arr.min(hits, Order.Number) : null
	return statRail(h, { columns: 5 }, [
		statRailItem(h, {
			eyebrow: "Instances up",
			value: `${live.length}/${data.instances.length}`,
			tone: down.length === 0 && badScopes.length === 0 ? "ok" : "crit",
			subline:
				badScopes.length > 0
					? Arr.join(
							Arr.map(badScopes, ([scope, n]) => `${scope}: ${n === 0 ? "no leader" : `${n} leaders`}`),
							", ",
						)
					: down.length > 0
						? `${Arr.join(down, ", ")} down`
						: scopes.size === 0
							? "standalone"
							: scopes.size === 1
								? "1 leader"
								: `${scopes.size} clusters, 1 leader each`,
		}),
		statRailItem(h, {
			eyebrow: "Replication lag",
			value: worstLag === null ? "—" : formatBytes(worstLag),
			tone: worstLag !== null && worstLag > 64 * 1024 * 1024 ? "warn" : "ok",
			subline: worstLag === null ? "no streaming replicas" : "worst replica, bytes",
		}),
		statRailItem(h, {
			eyebrow: "Connections",
			value: busiest === undefined ? "—" : pct(busiestRatio),
			tone: busiestRatio >= 0.85 ? "crit" : busiestRatio >= 0.7 ? "warn" : "ok",
			subline: busiest === undefined ? "" : `busiest: ${busiest.host}`,
		}),
		statRailItem(h, { eyebrow: "Transactions", value: `${rate(tps)}/s`, subline: "live instances, 15 min" }),
		statRailItem(h, {
			eyebrow: "Cache hit",
			value: worstHit === null ? "—" : pct(worstHit),
			tone: worstHit !== null && worstHit < 0.9 ? "warn" : "ok",
			subline: "worst live instance, 15 min",
		}),
	])
}

// ── Instances ─────────────────────────────────────────────────────────────────

const COLS = {
	name: "w-0 min-w-28 flex-1",
	role: "w-36 shrink-0",
	version: "w-14 shrink-0 hidden 2xl:flex",
	conns: "w-28 shrink-0",
	spark: "w-30 shrink-0 hidden xl:flex",
	tps: "w-16 shrink-0",
	cache: "w-20 shrink-0",
	repl: "w-36 shrink-0",
	size: "w-24 shrink-0",
} as const

const head = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => [
	columnHead(h, { label: "Instance", width: COLS.name }),
	columnHead(h, { label: "Role", width: COLS.role }),
	columnHead(h, { label: "Version", width: COLS.version }),
	columnHead(h, { label: "Connections", width: COLS.conns, align: "right" }),
	columnHead(h, { label: "6h trend", width: COLS.spark }),
	columnHead(h, { label: "Tx/s", width: COLS.tps, align: "right", tooltip: "commits + rollbacks per second, last 15 min" }),
	columnHead(h, { label: "Hit ratio", width: COLS.cache, align: "right", tooltip: "Buffer cache: blks_hit / (blks_hit + blks_read), last 15 min" }),
	columnHead(h, { label: "Replication", width: COLS.repl, align: "right", tooltip: "Replica: bytes behind the leader's WAL position. Leader: timeline." }),
	columnHead(h, { label: "Size", width: COLS.size, align: "right" }),
]

const row = <M>(h: HtmlBuilder<M>, node: PgInstance, now: number): Html => {
	const down = isDown(node, now)
	const role = roleOf(node)
	return hstack(
		h,
		{
			gap: "4",
			className: cn(DATA_TABLE_ROW, down && "opacity-50"),
			attributes: [h.Key(node.host), h.DataAttribute("pg-node", node.host), h.DataAttribute("pg-node-state", down ? "down" : "up")],
		},
		[
			hstack(h, { gap: "2.5", className: COLS.name }, [
				stateDot(h, down),
				vstack(h, { gap: "0", className: "min-w-0" }, [
					typography(h, { size: "xs", weight: "medium", mono: true, truncate: true }, [node.host]),
					...(down ? [typography(h, { size: "2xs", tone: "error", mono: true }, [silentFor(node, now)])] : []),
				]),
			]),
			h.div([h.Class(COLS.role)], [roleBadge(h, role, down)]),
			typography(h, { size: "2xs", tone: "soft", mono: true, className: COLS.version }, [versionLabel(node.patroni?.version ?? 0)]),
			h.div([h.Class(COLS.conns)], [connMeter(h, node)]),
			h.div([h.Class(COLS.spark)], [connSpark(h, node, "h-5 w-14 shrink-0")]),
			typography(h, { size: "xs", mono: true, numeric: true, className: cn("text-right", COLS.tps) }, [down ? "—" : rate(node.tps)]),
			typography(h, { size: "xs", mono: true, numeric: true, className: cn("text-right", COLS.cache) }, [
				down || node.cacheHit === null ? "—" : pct(node.cacheHit),
			]),
			twoLine(h, replicationText(node), replicationSub(node), COLS.repl, role === "replica" && node.patroni?.streaming !== 1 ? "error" : "soft"),
			twoLine(h, formatBytes(node.sizeBytes), `${node.databases} databases`, COLS.size),
		],
	)
}

const fact = <M>(h: HtmlBuilder<M>, label: string, value: string): Html =>
	vstack(h, { gap: "0", className: "min-w-0" }, [
		typography(h, { size: "2xs", tone: "soft" }, [label]),
		typography(h, { size: "xs", mono: true, numeric: true, truncate: true }, [value]),
	])

const card = <M>(h: HtmlBuilder<M>, node: PgInstance, now: number): Html => {
	const down = isDown(node, now)
	return vstack(
		h,
		{
			gap: "3",
			className: cn("min-w-0 rounded-md border bg-card p-3", down && "opacity-50"),
			attributes: [h.Key(node.host), h.DataAttribute("pg-card", node.host)],
		},
		[
			hstack(h, { gap: "2", justify: "between" }, [
				hstack(h, { gap: "2", shrink: true }, [
					stateDot(h, down),
					typography(h, { size: "xs", weight: "medium", mono: true, truncate: true }, [node.host]),
					...(down ? [typography(h, { size: "2xs", tone: "error", mono: true, className: "whitespace-nowrap" }, [silentFor(node, now)])] : []),
				]),
				roleBadge(h, roleOf(node), down),
			]),
			h.div(
				[h.Class("grid grid-cols-2 gap-x-3 gap-y-2")],
				[
					fact(h, "Connections", node.maxConnections > 0 ? `${node.connections} / ${node.maxConnections}` : String(node.connections)),
					fact(h, "Tx/s", down ? "—" : rate(node.tps)),
					fact(h, "Hit ratio", down || node.cacheHit === null ? "—" : pct(node.cacheHit)),
					fact(h, "Replication", replicationText(node)),
					fact(h, "Size", `${formatBytes(node.sizeBytes)} · ${node.databases} DBs`),
					fact(h, "Version", versionLabel(node.patroni?.version ?? 0)),
				],
			),
			connSpark(h, node, "h-6 min-w-0 flex-1"),
		],
	)
}

const instances = <M>(h: HtmlBuilder<M>, data: PostgresSnapshot): Html => {
	const nodes = orderedInstances(data)
	const now = data.capturedAtMs
	return h.section(
		[h.Class("space-y-3"), h.DataAttribute("pg-section", "instances")],
		[
			sectionHeading(h, { title: "Instances", count: String(nodes.length), hint: "leaders first · rates over the last 15 minutes" }),
			h.div(
				[h.Class("hidden md:block")],
				[
					dataTable(
						h,
						{ ariaLabel: "PostgreSQL instances" },
						head(h),
						nodes.length === 0 ? [dataTableEmpty(h, ["No instances reporting"])] : Arr.map(nodes, (node) => row(h, node, now)),
					),
				],
			),
			vstack(h, { gap: "3", className: "md:hidden" }, Arr.map(nodes, (node) => card(h, node, now))),
		],
	)
}

// ── Page ──────────────────────────────────────────────────────────────────────

export const postgresBody = <M>(h: HtmlBuilder<M>, data: PostgresSnapshot): ReadonlyArray<Html> => [rail(h, data), instances(h, data)]

export const postgresDescription = (data: PostgresSnapshot): string => {
	const scopes = [...leadersByScope(data).keys()]
	const standalone = Arr.filter(data.instances, (node) => node.patroni === null).length
	return Arr.join(
		Arr.filter(
			[
				...Arr.map(scopes, (scope) => `Patroni ${scope}`),
				standalone > 0 ? `${standalone} standalone` : "",
				`${data.instances.length} instances`,
				"postgresql receiver, every 60 s",
			],
			Str.isNonEmpty,
		),
		" · ",
	)
}

export const postgresLoadingBody = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => [
	statRailLoading(h, 5, 5),
	dataTable(
		h,
		{ ariaLabel: "PostgreSQL instances", isWaiting: true },
		head(h),
		skeletonRows(h, 3, () => [skeleton(h, "h-4 w-0 min-w-36 flex-1"), skeleton(h, "h-3 w-24"), skeleton(h, "h-3 w-24"), skeleton(h, "h-2 w-40"), skeleton(h, "h-3 w-28")]),
	),
]

export const postgresEmptyBody = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => [
	empty(h, [
		emptyHeader(h, [
			emptyMedia(h, { variant: "icon" }, [icon(h, "PostgresIcon")]),
			emptyTitle(h, ["No PostgreSQL metrics in the last hour"]),
			emptyDescription(h, [
				"Connect a PostgreSQL source (Sources → Connect a source → PostgreSQL): a collector beside each instance runs the postgresql receiver, plus Patroni's /metrics for a cluster. Instances appear within a minute.",
			]),
		]),
	]),
]
