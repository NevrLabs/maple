import { Array as Arr, Order, String as Str } from "effect"
import { countLabel, formatBytes } from "@maple/ui/lib/format"
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
import { columnHead, DATA_TABLE_ROW, dataTable, skeletonRows } from "../../kit/data-table"
import { sectionHeading } from "../../kit/section-heading"
import { statRail, statRailItem, statRailLoading } from "../../kit/stat-rail"
import { type AtlasNode, type AtlasSnapshot, OP_KINDS, type OpKind } from "./model"

// `/infra/atlas` (NevrLabs selfhost): MongoDB Atlas in Maple's kit, the Proxmox page's anatomy (stat
// rail, a table of clusters, then one member table per cluster). Desktop is a table; below `md` each
// member is a card.

/** Atlas's Prometheus integration scrapes every 30 s; two minutes of silence is a member down. */
export const SILENT_AFTER_MS = 120_000

export const isDown = (node: AtlasNode, nowMs: number) =>
	node.up < 1 || nowMs - node.lastSeenMs > SILENT_AFTER_MS

/** `silent 5m`: how long a down member has been quiet (Atlas keeps reporting `up 0` for a stopped one). */
const silentFor = (node: AtlasNode, now: number) =>
	node.up < 1 ? "down" : `silent ${Math.max(1, Math.round((now - node.lastSeenMs) / 60_000))}m`

/** `other` is every state but the two (recovering, starting up, arbiter); this scrape carries no state name. */
export type Role = "primary" | "secondary" | "other"
export const roleOf = (node: AtlasNode): Role =>
	node.state === 1 ? "primary" : node.state === 2 ? "secondary" : "other"
const ROLE_LABEL = { primary: "Primary", secondary: "Secondary", other: "Other state" } as const

/** `noov-mongodb-live-shard-00-01-pri.l2mydt.mongodb.net:27018` → `shard-00-01` (the `-pri` is Atlas's private endpoint, not the role). */
export const shortName = (node: AtlasNode): string => {
	const label = Str.split(node.host, ".")[0] ?? node.host
	return /shard-\d+-\d+/.exec(label)?.[0] ?? Str.replace(/-pri$/, "")(label)
}

const OP_COLOR = {
	query: "var(--chart-2)",
	getmore: "var(--chart-4)",
	command: "var(--chart-3)",
	update: "var(--chart-1)",
	insert: "var(--chart-5)",
	delete: "var(--severity-error)",
} satisfies Record<OpKind, string>

export const opsTotal = (node: AtlasNode) => Arr.reduce(OP_KINDS, 0, (sum, kind) => sum + node.ops[kind])
const mib = (n: number) => n * 1024 * 1024
const ratio = (used: number, total: number) => (total > 0 ? used / total : 0)
const rate = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1))

const byHost: Order.Order<AtlasNode> = (a, b) => Str.localeCompare(b.host)(a.host)
/** A primary sorts before everything else; two members of the same rank fall through to the next order. */
const primaryFirst: Order.Order<AtlasNode> = (a, b) => {
	const aPrimary = roleOf(a) === "primary"
	const bPrimary = roleOf(b) === "primary"
	return aPrimary === bPrimary ? 0 : bPrimary ? 1 : -1
}

/** Primary first, then by host. */
export const orderedNodes = (data: AtlasSnapshot): ReadonlyArray<AtlasNode> =>
	Arr.sort(data.nodes, Order.combine(primaryFirst, byHost))

// ── Atlas hierarchy ──────────────────────────────────────────────────────────

/** One cluster as Atlas files it: the members of one project that share a cluster name. */
export type AtlasCluster = Readonly<{
	name: string
	/** The project's name, or its id when Atlas sent no name. */
	project: string
	projectId: string
	orgId: string
	provider: string
	region: string
	/** The distinct replica sets under this cluster's name, by name. Atlas numbers every set `shard-N`,
	 * sharded or not, so the page counts replica sets and claims no cluster type. */
	replicaSets: ReadonlyArray<string>
	/** Primary first, then by host. */
	nodes: ReadonlyArray<AtlasNode>
}>

/** A member's cluster: `cl_name`, else its replica set, else its host, so every member groups somewhere. */
const clusterName = (node: AtlasNode): string => node.cluster || node.replicaSet || node.host
/** Two projects may each hold a cluster of the same name, so a cluster's identity is all three. */
const clusterKey = (orgId: string, projectId: string, name: string): string => `${orgId}|${projectId}|${name}`

const byProjectThenName: Order.Order<AtlasCluster> = Order.combine(
	Order.mapInput(Order.String, (cluster: AtlasCluster) => cluster.project),
	Order.mapInput(Order.String, (cluster) => cluster.name),
)

/** Clusters by project, then name; each keeps its members in `orderedNodes` order. */
export const clustersOf = (data: AtlasSnapshot): ReadonlyArray<AtlasCluster> => {
	const seen = new Map<string, AtlasCluster & { nodes: Array<AtlasNode> }>()
	for (const node of orderedNodes(data)) {
		const key = clusterKey(node.orgId, node.projectId, clusterName(node))
		const cluster = seen.get(key)
		if (cluster === undefined) {
			seen.set(key, {
				name: clusterName(node),
				project: node.project || node.projectId,
				projectId: node.projectId,
				orgId: node.orgId,
				provider: node.provider,
				region: node.region,
				replicaSets: [],
				nodes: [node],
			})
		} else cluster.nodes.push(node)
	}
	return Arr.sort(
		Arr.map([...seen.values()], (cluster) => ({
			...cluster,
			replicaSets: Arr.sort(
				Arr.dedupe(
					Arr.filter(
						Arr.map(cluster.nodes, (node) => node.replicaSet),
						(set) => set !== "",
					),
				),
				Order.String,
			),
		})),
		byProjectThenName,
	)
}

/** `atlas-6fng94-shard-0`, or `2 replica sets: …` once a cluster holds more than one. */
export const clusterSubline = (cluster: AtlasCluster): string =>
	cluster.replicaSets.length > 1
		? `${cluster.replicaSets.length} replica sets: ${Arr.join(cluster.replicaSets, ", ")}`
		: (cluster.replicaSets[0] ?? "")

/** `AWS ap-southeast-1`; either half may be missing on a scrape that relabels it away. */
const regionLabel = (cluster: AtlasCluster): string =>
	Arr.join(
		Arr.filter([cluster.provider, cluster.region], (part) => part !== ""),
		" ",
	) || "—"

/** Healthy once every member reports and is a primary or a secondary (a recovering, syncing or starting
 * member is neither, though it is still in its set), and every replica set has exactly one live
 * primary (one for the whole cluster when the scrape sent no set names). */
type ClusterHealth = Readonly<{
	live: ReadonlyArray<AtlasNode>
	/** Live primaries across the cluster. */
	primaries: number
	/** Replica sets with no live primary. */
	emptySets: number
	/** Every replica set has its one live primary. */
	primariesOk: boolean
	ok: boolean
}>
const healthOf = (cluster: AtlasCluster, now: number): ClusterHealth => {
	const live = Arr.filter(cluster.nodes, (node) => !isDown(node, now))
	const primaries = Arr.filter(live, (node) => roleOf(node) === "primary")
	const sets = cluster.replicaSets.length > 0 ? cluster.replicaSets : [""]
	const emptySets = Arr.filter(
		sets,
		(set) => !Arr.some(primaries, (node) => node.replicaSet === set),
	).length
	const primariesOk = emptySets === 0 && primaries.length === sets.length
	return {
		live,
		primaries: primaries.length,
		emptySets,
		primariesOk,
		ok:
			live.length === cluster.nodes.length &&
			primariesOk &&
			Arr.every(live, (node) => roleOf(node) !== "other"),
	}
}
const sumOf = <A>(items: ReadonlyArray<A>, value: (item: A) => number): number =>
	Arr.reduce(items, 0, (sum, item) => sum + value(item))

// ── Pieces ────────────────────────────────────────────────────────────────────

/** A tile subline that keeps its whole text on hover: the kit cuts a long one without a title. */
const titled = <M>(h: HtmlBuilder<M>, text: string): Html => h.span([h.Title(text)], [text])

/** A status dot for a member (`down`) or a cluster row (`label` says which). */
const stateDot = <M>(h: HtmlBuilder<M>, down: boolean, label: string = down ? "down" : "up"): Html =>
	statusDot(h, {
		tone: down ? "crit" : "ok",
		size: "lg",
		attributes: [h.AriaHidden(false), h.AriaLabel(label)],
	})

const roleBadge = <M>(h: HtmlBuilder<M>, role: Role): Html =>
	badge(
		h,
		{
			variant: role === "primary" ? "live" : role === "secondary" ? "muted" : "crit",
			size: "sm",
			pill: true,
		},
		[ROLE_LABEL[role]],
	)

const opMix = <M>(h: HtmlBuilder<M>, node: AtlasNode, className: string): Html => {
	const total = opsTotal(node)
	const top = Arr.reduce<OpKind, OpKind>(OP_KINDS, OP_KINDS[0], (best, kind) =>
		node.ops[kind] > node.ops[best] ? kind : best,
	)
	return hstack(h, { gap: "2", className: "w-full min-w-0" }, [
		segmentedBar(h, {
			className,
			label: Arr.join(
				Arr.map(OP_KINDS, (kind) => `${kind} ${rate(node.ops[kind])}/s`),
				", ",
			),
			segments: Arr.map(OP_KINDS, (kind) => ({
				key: kind,
				value: node.ops[kind],
				color: OP_COLOR[kind],
				title: `${kind} ${rate(node.ops[kind])}/s`,
			})),
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
		miniBars(h, {
			values: Arr.map(values, (v) => v - lo + (hi - lo) * 0.15 + 1),
			color: "var(--chart-2)",
			className,
			label: `${shortName(node)} connections, last 6 hours, ${Math.round(lo)} to ${Math.round(hi)}`,
		}),
		typography(
			h,
			{ size: "2xs", tone: "soft", mono: true, numeric: true, className: "whitespace-nowrap" },
			[`${Math.round(lo)}–${Math.round(hi)} conns`],
		),
	])
}

const oplogBar = <M>(h: HtmlBuilder<M>, node: AtlasNode): Html =>
	vstack(h, { gap: "1", className: "w-full" }, [
		typography(h, { size: "xs", mono: true, numeric: true, className: "text-right" }, [
			`${formatBytes(node.oplogBytes)} / ${formatBytes(node.oplogMaxBytes)}`,
		]),
		meter(h, {
			value: ratio(node.oplogBytes, node.oplogMaxBytes),
			className: "h-1 w-full",
			fillClassName: "bg-chart-2",
			label: `${shortName(node)} oplog used`,
		}),
	])

const twoLine = <M>(h: HtmlBuilder<M>, value: string, sub: string, className: string): Html =>
	vstack(h, { gap: "0", className: cn("items-end", className) }, [
		typography(h, { size: "xs", mono: true, numeric: true }, [value]),
		typography(
			h,
			{ size: "2xs", tone: "soft", mono: true, numeric: true, className: "whitespace-nowrap" },
			[sub],
		),
	])

// ── Rail ──────────────────────────────────────────────────────────────────────

/** The members tile's subline: who is down, else how the clusters stand on primaries, in words that
 * state what the data shows. After a failover two members report primary for a scrape or two, which is
 * an election finishing, not a fault, so the count is reported rather than called extra. */
const membersSubline = (
	down: string,
	clusters: ReadonlyArray<AtlasCluster>,
	health: ReadonlyArray<ClusterHealth>,
): string => {
	if (down !== "") return down
	if (clusters.length === 1) {
		const only = health[0]
		if (only === undefined) return "no primary"
		if (only.ok) return countLabel(only.primaries, "primary", "primaries")
		if (only.primaries === 0) return "no primary"
		if (!only.primariesOk) {
			return only.emptySets > 0
				? `${countLabel(only.emptySets, "replica set", "replica sets")} without a primary`
				: `${only.primaries} report primary`
		}
		return "a member not primary or secondary"
	}
	const bad = Arr.filter(health, (one) => !one.ok)
	if (bad.length === 0) return `${countLabel(clusters.length, "cluster")}, every replica set with a primary`
	if (sumOf(health, (one) => one.primaries) === 0) return "no primary"
	const empty = Arr.filter(bad, (one) => one.emptySets > 0).length
	return empty === bad.length
		? `${countLabel(bad.length, "cluster")} with a replica set missing its primary`
		: `${countLabel(bad.length, "cluster")} not healthy`
}

/** Who is down, short enough for one tile: the member names for a single cluster, the count and its clusters for more. */
const downLabel = (clusters: ReadonlyArray<AtlasCluster>, now: number): string => {
	const affected = Arr.filter(clusters, (cluster) => Arr.some(cluster.nodes, (node) => isDown(node, now)))
	if (affected.length === 0) return ""
	if (clusters.length > 1) {
		const count = sumOf(
			affected,
			(cluster) => Arr.filter(cluster.nodes, (node) => isDown(node, now)).length,
		)
		return `${count} down in ${Arr.join(
			Arr.map(affected, (cluster) => cluster.name),
			", ",
		)}`
	}
	const only = affected[0]
	return only === undefined
		? ""
		: `${Arr.join(
				Arr.map(
					Arr.filter(only.nodes, (node) => isDown(node, now)),
					shortName,
				),
				", ",
			)} down`
}

/** Atlas-wide health over every cluster. */
const rail = <M>(h: HtmlBuilder<M>, clusters: ReadonlyArray<AtlasCluster>, now: number): Html => {
	const health = Arr.map(clusters, (cluster) => healthOf(cluster, now))
	const live = Arr.flatMap(health, (one) => one.live)
	const healthy = Arr.filter(health, (one) => one.ok).length
	const connections = sumOf(live, (node) => node.connections)
	const minFree = live.length === 0 ? 0 : Math.min(...Arr.map(live, (node) => node.connectionsFree))
	const ops = sumOf(live, opsTotal)
	const queue = sumOf(live, (node) => node.queue)
	const biggest = Arr.reduce<AtlasNode, AtlasNode | undefined>(live, undefined, (best, node) =>
		best === undefined || node.residentMiB > best.residentMiB ? node : best,
	)
	return statRail(h, { columns: 5 }, [
		statRailItem(h, {
			eyebrow: "Members up",
			value: `${live.length}/${sumOf(clusters, (cluster) => cluster.nodes.length)}`,
			tone: healthy === clusters.length ? "ok" : "crit",
			subline: titled(h, membersSubline(downLabel(clusters, now), clusters, health)),
		}),
		statRailItem(h, {
			eyebrow: "Connections",
			value: connections.toLocaleString(),
			subline: `min ${minFree.toLocaleString()} free`,
		}),
		statRailItem(h, { eyebrow: "Operations", value: `${rate(ops)}/s`, subline: "last 15 min" }),
		statRailItem(h, {
			eyebrow: "Lock queue",
			value: String(queue),
			tone: queue > 0 ? "warn" : "ok",
			subline: "ops waiting",
		}),
		/** The largest member's resident memory, labelled as a maximum: with several clusters it is not one cluster's figure. */
		statRailItem(h, {
			eyebrow: "Max resident",
			value: biggest === undefined ? "—" : formatBytes(mib(biggest.residentMiB)),
			subline: biggest === undefined ? "" : `cache ${formatBytes(biggest.cacheBytes)}`,
		}),
	])
}

// ── Clusters ─────────────────────────────────────────────────────────────────

/** Lanes for the 1280 px content column, a phone first: cluster, members and connections are the last
 * to go (the two figure lanes sit at 64 and 72 px below `lg`, which a 360 px phone still holds); a lane
 * spelled `hidden <bp>:flex` drops out below its breakpoint (ops/s under `sm`, project and primaries
 * under `lg`, region and queue under `xl`). Head and cell take the same string, so they cannot disagree. */
const CLUSTER_COLS = {
	name: "w-0 min-w-24 flex-1",
	project: "w-40 shrink-0 hidden lg:flex",
	region: "w-40 shrink-0 hidden xl:flex",
	members: "w-16 shrink-0 lg:w-20",
	primary: "w-16 shrink-0 hidden lg:flex",
	conns: "w-18 shrink-0 lg:w-20",
	ops: "w-12 shrink-0 hidden sm:flex",
	// 56 px: the head is the label plus its help icon, 49 px together.
	queue: "w-14 shrink-0 hidden xl:flex",
} as const

const clusterHead = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => [
	columnHead(h, { label: "Cluster", width: CLUSTER_COLS.name }),
	columnHead(h, { label: "Project", width: CLUSTER_COLS.project }),
	columnHead(h, { label: "Provider · region", width: CLUSTER_COLS.region }),
	columnHead(h, { label: "Members", width: CLUSTER_COLS.members, align: "right" }),
	columnHead(h, { label: "Primaries", width: CLUSTER_COLS.primary, align: "right" }),
	columnHead(h, { label: "Connections", width: CLUSTER_COLS.conns, align: "right" }),
	columnHead(h, { label: "Ops/s", width: CLUSTER_COLS.ops, align: "right" }),
	columnHead(h, {
		label: "Queue",
		width: CLUSTER_COLS.queue,
		align: "right",
		tooltip: "operations waiting on a lock across the cluster's live members",
	}),
]

const FIGURE = { size: "xs", mono: true, numeric: true } as const

/** A right-aligned figure; `className` is its column (a conditional one starts with `hidden`). */
const figure = <M>(h: HtmlBuilder<M>, value: string, className: string, tone?: "error"): Html =>
	hstack(h, { justify: "end", className }, [
		typography(h, tone === undefined ? FIGURE : { ...FIGURE, tone }, [value]),
	])

/** `members down` when a member is silent; `degraded` when they all report but a replica set lacks its
 * primary or a member is neither primary nor secondary. */
const clusterStateLabel = (health: ClusterHealth, total: number): string =>
	health.ok ? "healthy" : health.live.length < total ? "members down" : "degraded"

const clusterRow = <M>(h: HtmlBuilder<M>, cluster: AtlasCluster, now: number): Html => {
	const health = healthOf(cluster, now)
	const subline = clusterSubline(cluster)
	return hstack(
		h,
		{
			gap: "4",
			className: DATA_TABLE_ROW,
			attributes: [
				h.Key(clusterKey(cluster.orgId, cluster.projectId, cluster.name)),
				h.DataAttribute("atlas-cluster", cluster.name),
				h.DataAttribute("atlas-cluster-state", health.ok ? "ok" : "crit"),
			],
		},
		[
			hstack(h, { gap: "2.5", className: CLUSTER_COLS.name }, [
				stateDot(h, !health.ok, clusterStateLabel(health, cluster.nodes.length)),
				vstack(h, { gap: "0", className: "min-w-0" }, [
					typography(
						h,
						{
							size: "xs",
							weight: "medium",
							mono: true,
							truncate: true,
							attributes: [h.Title(cluster.name)],
						},
						[cluster.name],
					),
					...(subline === ""
						? []
						: [
								typography(
									h,
									{
										size: "2xs",
										tone: "soft",
										mono: true,
										truncate: true,
										attributes: [h.Title(subline)],
									},
									[subline],
								),
							]),
				]),
			]),
			vstack(h, { gap: "0", className: CLUSTER_COLS.project }, [
				typography(
					h,
					{ size: "xs", mono: true, truncate: true, attributes: [h.Title(cluster.project)] },
					[cluster.project],
				),
				...(cluster.projectId === ""
					? []
					: [
							typography(h, { size: "2xs", tone: "soft", mono: true, truncate: true }, [
								cluster.projectId,
							]),
						]),
			]),
			hstack(h, { className: CLUSTER_COLS.region }, [
				typography(
					h,
					{ size: "xs", tone: "soft", mono: true, truncate: true, className: "min-w-0" },
					[regionLabel(cluster)],
				),
			]),
			figure(
				h,
				`${health.live.length}/${cluster.nodes.length}`,
				CLUSTER_COLS.members,
				health.live.length < cluster.nodes.length ? "error" : undefined,
			),
			figure(
				h,
				String(health.primaries),
				CLUSTER_COLS.primary,
				health.primariesOk ? undefined : "error",
			),
			figure(h, sumOf(health.live, (node) => node.connections).toLocaleString(), CLUSTER_COLS.conns),
			figure(h, rate(sumOf(health.live, opsTotal)), CLUSTER_COLS.ops),
			figure(h, String(sumOf(health.live, (node) => node.queue)), CLUSTER_COLS.queue),
		],
	)
}

/** The loading rows sit in the head's lanes, so the bars line up at every width. */
const clusterSkeleton = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => {
	const bar = (lane: string, width: string): Html =>
		hstack(h, { justify: "end", className: lane }, [skeleton(h, cn("h-3.5", width))])
	return skeletonRows(h, 2, () => [
		vstack(h, { gap: "1.5", className: CLUSTER_COLS.name }, [
			skeleton(h, "h-3.5 w-36 max-w-full"),
			skeleton(h, "h-2.5 w-48 max-w-full"),
		]),
		vstack(h, { gap: "1.5", className: CLUSTER_COLS.project }, [
			skeleton(h, "h-3.5 w-24 max-w-full"),
			skeleton(h, "h-2.5 w-36 max-w-full"),
		]),
		vstack(h, { gap: "1.5", className: CLUSTER_COLS.region }, [skeleton(h, "h-3.5 w-28")]),
		bar(CLUSTER_COLS.members, "w-8"),
		bar(CLUSTER_COLS.primary, "w-4"),
		bar(CLUSTER_COLS.conns, "w-10"),
		bar(CLUSTER_COLS.ops, "w-8"),
		bar(CLUSTER_COLS.queue, "w-5"),
	])
}

const clustersSection = <M>(h: HtmlBuilder<M>, clusters: ReadonlyArray<AtlasCluster>, now: number): Html =>
	h.section(
		[h.Class("space-y-3"), h.DataAttribute("atlas-section", "clusters")],
		[
			sectionHeading(h, {
				title: "Clusters",
				count: String(clusters.length),
				hint: "by project · figures sum each cluster's live members",
			}),
			dataTable(
				h,
				{ ariaLabel: "Atlas clusters" },
				clusterHead(h),
				Arr.map(clusters, (cluster) => clusterRow(h, cluster, now)),
			),
		],
	)

// ── Members ───────────────────────────────────────────────────────────────────

/** Lanes by the page column's width, not the viewport's (the sidebar opens and closes). The column is the
 * table's box plus a 32 px gutter, and a row needs its lanes plus 16 px per gap plus 32 px padding: member,
 * role, connections and ops/s always show (440 px); the op mix and resident arrive at 744 (688 + 56), the
 * trend and oplog at 1012 (960 + 52, so a 1280 px window with the sidebar open keeps them), asserts at
 * 1104 (1048 + 56) and zone at 1208 (1152 + 56). That leaves the member's name 152 px at each threshold
 * (148 px at 1012), 135 px under a 17 px classic scrollbar (131 px at 1012). The legend
 * under the last member table follows the op mix lane. Below `md` the table gives way to cards. */
const COLS = {
	name: "w-0 min-w-32 flex-1",
	role: "w-22 shrink-0",
	zone: "w-22 shrink-0 hidden @min-[1208px]/page:flex",
	conns: "w-22 shrink-0",
	spark: "w-30 shrink-0 hidden @min-[1012px]/page:flex",
	ops: "w-14 shrink-0",
	mix: "w-30 shrink-0 hidden @min-[744px]/page:flex",
	mem: "w-24 shrink-0 hidden @min-[744px]/page:flex",
	oplog: "w-30 shrink-0 hidden @min-[1012px]/page:flex",
	asserts: "w-18 shrink-0 hidden @min-[1104px]/page:flex",
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
	columnHead(h, {
		label: "Asserts/s",
		width: COLS.asserts,
		align: "right",
		tooltip: "regular + warning + msg + user asserts per second, last 15 min",
	}),
]

const row = <M>(h: HtmlBuilder<M>, node: AtlasNode, now: number): Html => {
	const down = isDown(node, now)
	return hstack(
		h,
		{
			gap: "4",
			className: cn(DATA_TABLE_ROW, down && "opacity-50"),
			attributes: [
				h.Key(node.host),
				h.DataAttribute("atlas-node", shortName(node)),
				h.DataAttribute("atlas-node-state", down ? "down" : "up"),
			],
		},
		[
			hstack(h, { gap: "2.5", className: COLS.name }, [
				stateDot(h, down),
				vstack(h, { gap: "0", className: "min-w-0" }, [
					typography(
						h,
						{
							size: "xs",
							weight: "medium",
							mono: true,
							truncate: true,
							attributes: [h.Title(node.host)],
						},
						[shortName(node)],
					),
					...(down
						? [typography(h, { size: "2xs", tone: "error", mono: true }, [silentFor(node, now)])]
						: []),
				]),
			]),
			h.div([h.Class(COLS.role)], [roleBadge(h, roleOf(node))]),
			typography(h, { size: "2xs", tone: "soft", mono: true, className: COLS.zone }, [node.zone]),
			twoLine(
				h,
				node.connections.toLocaleString(),
				`${node.connectionsFree.toLocaleString()} free`,
				COLS.conns,
			),
			h.div([h.Class(COLS.spark)], [connSpark(h, node, "h-5 w-14 shrink-0")]),
			typography(h, { size: "xs", mono: true, numeric: true, className: cn("text-right", COLS.ops) }, [
				rate(opsTotal(node)),
			]),
			h.div([h.Class(COLS.mix)], [opMix(h, node, "h-2 w-12 shrink-0 rounded-xs")]),
			twoLine(h, formatBytes(mib(node.residentMiB)), `cache ${formatBytes(node.cacheBytes)}`, COLS.mem),
			h.div([h.Class(COLS.oplog)], [oplogBar(h, node)]),
			figure(h, node.asserts.toFixed(2), COLS.asserts),
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
					typography(h, { size: "xs", weight: "medium", mono: true, truncate: true }, [
						shortName(node),
					]),
					...(down
						? [
								typography(
									h,
									{
										size: "2xs",
										tone: "error",
										mono: true,
										className: "whitespace-nowrap",
									},
									[silentFor(node, now)],
								),
							]
						: []),
				]),
				roleBadge(h, roleOf(node)),
			]),
			h.div(
				[h.Class("grid grid-cols-2 gap-x-3 gap-y-2")],
				[
					fact(
						h,
						"Connections",
						`${node.connections.toLocaleString()} · ${node.connectionsFree.toLocaleString()} free`,
					),
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
		...Arr.map(OP_KINDS, (kind) =>
			hstack(h, { gap: "1", as: "span" }, [
				h.span(
					[
						h.AriaHidden(true),
						h.Class("size-2 shrink-0 rounded-xs"),
						h.Style({ "background-color": OP_COLOR[kind] }),
					],
					[],
				),
				typography(h, { size: "2xs", tone: "soft", mono: true }, [kind]),
			]),
		),
	])

/** One cluster's members under its name; the heading names its project, which the cluster table hides
 * below `lg`. The operation-mix legend is drawn once per page: under the last member table, above the
 * first cluster's cards. */
const members = <M>(
	h: HtmlBuilder<M>,
	cluster: AtlasCluster,
	now: number,
	isFirst: boolean,
	isLast: boolean,
): Html =>
	h.section(
		[
			h.Class("space-y-3"),
			h.DataAttribute("atlas-section", "members"),
			h.DataAttribute("atlas-cluster", cluster.name),
		],
		[
			sectionHeading(h, {
				as: "h3",
				title: cluster.name,
				count: String(cluster.nodes.length),
				hint: cluster.project,
			}),
			h.div(
				[h.Class("hidden md:block")],
				[
					dataTable(
						h,
						{ ariaLabel: `${cluster.name} members` },
						head(h),
						Arr.map(cluster.nodes, (node) => row(h, node, now)),
					),
					...(isLast ? [legend(h, "px-4 py-2 hidden @min-[744px]/page:flex")] : []),
				],
			),
			vstack(h, { gap: "3", className: "md:hidden" }, [
				...(isFirst ? [legend(h, "")] : []),
				...Arr.map(cluster.nodes, (node) => card(h, node, now)),
			]),
		],
	)

// ── Page ──────────────────────────────────────────────────────────────────────

/** Atlas-wide health, then every cluster, then each cluster's members under its name. */
export const atlasBody = <M>(h: HtmlBuilder<M>, data: AtlasSnapshot): ReadonlyArray<Html> => {
	const now = data.capturedAtMs
	const clusters = clustersOf(data)
	const last = clusters.length - 1
	return [
		rail(h, clusters, now),
		clustersSection(h, clusters, now),
		...Arr.map(clusters, (cluster, index) => members(h, cluster, now, index === 0, index === last)),
	]
}

/** `project · cluster · 3 members · …` for one of each; counts once the page holds more. */
export const atlasDescription = (data: AtlasSnapshot): string => {
	const clusters = clustersOf(data)
	const first = clusters[0]
	if (first === undefined) return "MongoDB Atlas"
	const projects = new Set(Arr.map(clusters, (cluster) => cluster.projectId || cluster.project)).size
	const scope =
		projects === 1 && clusters.length === 1
			? [first.project, first.name]
			: [countLabel(projects, "project"), countLabel(clusters.length, "cluster")]
	return Arr.join(
		Arr.filter(
			[...scope, `${data.nodes.length} members`, "Prometheus integration, every 30 s"],
			(part) => part !== "",
		),
		" · ",
	)
}

export const atlasLoadingBody = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => [
	// `overflow-hidden`: the kit's fixed-width skeleton bars otherwise push the page column sideways
	// at 768–872 px viewports (two services-detail pages pass the same class).
	statRailLoading(h, 5, 5, "overflow-hidden"),
	dataTable(h, { ariaLabel: "Atlas clusters", isWaiting: true }, clusterHead(h), clusterSkeleton(h)),
	// A table from `md` up, as when loaded; a bar per lane, so the loading rows keep the head's shape.
	h.div(
		[h.Class("hidden md:block")],
		[
			dataTable(
				h,
				{ ariaLabel: "Cluster members", isWaiting: true },
				head(h),
				skeletonRows(h, 3, () => [
					skeleton(h, cn("h-4", COLS.name)),
					skeleton(h, cn("h-3", COLS.role)),
					skeleton(h, cn("h-3", COLS.zone)),
					skeleton(h, cn("h-2", COLS.conns)),
					skeleton(h, cn("h-5", COLS.spark)),
					skeleton(h, cn("h-3", COLS.ops)),
					skeleton(h, cn("h-2", COLS.mix)),
					skeleton(h, cn("h-2", COLS.mem)),
					skeleton(h, cn("h-1", COLS.oplog)),
					skeleton(h, cn("h-3", COLS.asserts)),
				]),
			),
		],
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
