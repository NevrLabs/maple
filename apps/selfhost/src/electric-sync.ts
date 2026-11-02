/**
 * Self-hosted electric-sync server: the unmodified electric-sync shape proxy route graph
 * (apps/electric-sync, normally a Cloudflare Worker) served by Bun.serve. Same layer wiring as
 * apps/electric-sync/src/worker.ts, minus the Workers wrapper and worker telemetry.
 * Env: ELECTRIC_URL (the Electric HTTP API), MAPLE_AUTH_MODE/MAPLE_ROOT_PASSWORD/MAPLE_DEFAULT_ORG_ID, PORT.
 */
import { Layer } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { TenantResolver } from "../../electric-sync/src/auth/TenantResolver"
import { SyncConfig } from "../../electric-sync/src/config"
import { ElectricClient } from "../../electric-sync/src/electric/ElectricClient"
import { ELECTRIC_SYNC_CORS_OPTIONS } from "../../electric-sync/src/routes/cors"
import { ElectricSyncRouter } from "../../electric-sync/src/routes/shape.http"
import { gate } from "./gate"
import { makeUsersStore, pgSql } from "./users"

const port = Number(process.env.PORT ?? 3476)

const AppLive = ElectricSyncRouter.pipe(
	Layer.provideMerge(HttpRouter.cors(ELECTRIC_SYNC_CORS_OPTIONS)),
	Layer.provideMerge(ElectricClient.layer.pipe(Layer.provide(FetchHttpClient.layer))),
	Layer.provideMerge(TenantResolver.layer),
	Layer.provideMerge(SyncConfig.layer),
)

const { handler } = HttpRouter.toWebHandler(AppLive, { disableLogger: true })

// NevrLabs selfhost (PATCHES #5): a disabled / signed-out-everywhere OIDC user stops syncing at once too.
// Shapes are reads, so only the revoke half of the gate applies (a viewer may sync).
const users = process.env.MAPLE_PG_URL ? makeUsersStore(pgSql(process.env.MAPLE_PG_URL)) : null
const secret = process.env.MAPLE_ROOT_PASSWORD ?? ""

const server = Bun.serve({
	port,
	hostname: "0.0.0.0",
	// Electric live long-polls hold ~20s; give headroom.
	idleTimeout: 120,
	async fetch(request) {
		const url = new URL(request.url)
		if (url.pathname === "/health") return new Response("ok")
		const refused = users === null ? null : await gate(new Request(request.url, { method: "GET", headers: request.headers }), { secret, users })
		if (refused) return refused
		return handler(request)
	},
})
console.log(`maple-electric-sync (selfhost) listening on :${server.port}`)
