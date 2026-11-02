/**
 * NevrLabs selfhost: what a `viewer` session may call. Classified per ROUTE (method + path pattern from the
 * generated route table, identified as group.endpoint), never by a path-prefix guess.
 *
 * Viewer = read-only: every GET/HEAD, plus the POST endpoints below that only READ (query engine, search,
 * timeseries, breakdowns, widget data, previews), plus the viewer's own session renewal. Anything else that is
 * not GET/HEAD — including a path that matches no known route — is refused with 403 before the API sees it.
 * Endpoints that look read-ish but act on the outside world (destination/uptime tests send notifications,
 * scrape probes reach out) stay admin-only on purpose.
 */
import { ROUTES } from "./route-table.generated"

/** Whole groups whose every non-GET endpoint is a read (POST because the query is a body). */
export const VIEWER_READ_GROUPS: ReadonlySet<string> = new Set(["queryEngine", "aiSessionsInternal", "sessionReplaysInternal"])

/** Individual read endpoints that use POST. */
export const VIEWER_READ_ENDPOINTS: ReadonlySet<string> = new Set([
	"auth.sessionRefresh",
	"traces.search",
	"traces.timeseries",
	"traces.breakdown",
	"logs.search",
	"logs.timeseries",
	"logs.breakdown",
	"metrics.timeseries",
	"metrics.breakdown",
	"services.health",
	"sessionReplays.search",
	"sessionReplays.forTrace",
	"dashboards.widgetData",
	"dashboards.previewTemplate",
	"alertRules.preview",
	"statusPages.preview",
	"digest.preview",
	"digest.previewWebAnalytics",
	"planetscaleIntegration.queryInsights",
	"errors.evaluateEscalationPolicy",
])

/** Unauthenticated endpoints (login, public share links): not a session's business; the API gates them itself. */
export const PUBLIC_GROUPS: ReadonlySet<string> = new Set(["authPublic", "sharePublic", "emailPublic", "billingPublic"])

type Compiled = Readonly<{ method: string; re: RegExp; id: string; group: string; literal: number }>

const compile = (method: string, path: string, id: string): Compiled => {
	const segments = path.split("/").filter(Boolean)
	const re = new RegExp(`^/${segments.map((s) => (s.startsWith(":") ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}/?$`)
	return { method, re, id, group: id.split(".")[0]!, literal: segments.filter((s) => !s.startsWith(":")).length }
}

// Most literal segments first: `/v2/dashboards/import/perses` must win over `/v2/dashboards/:id/...` shapes.
const TABLE: readonly Compiled[] = ROUTES.map(([m, p, id]) => compile(m, p, id)).sort((a, b) => b.literal - a.literal)

export const matchRoute = (method: string, path: string): Compiled | undefined =>
	TABLE.find((route) => route.method === method && route.re.test(path))

export const isViewerReadEndpoint = (id: string): boolean =>
	VIEWER_READ_GROUPS.has(id.split(".")[0]!) || VIEWER_READ_ENDPOINTS.has(id)

export type ViewerDecision = Readonly<{ allowed: boolean; id: string | null }>

/** May a viewer session make this request? */
export const viewerMay = (method: string, path: string): ViewerDecision => {
	const upper = method.toUpperCase()
	if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS") return { allowed: true, id: null }
	const route = matchRoute(upper, path)
	if (route === undefined) return { allowed: false, id: null }
	return { allowed: isViewerReadEndpoint(route.id) || PUBLIC_GROUPS.has(route.group), id: route.id }
}

export const allRoutes = (): readonly Compiled[] => TABLE
