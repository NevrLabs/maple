/**
 * Self-hosted api server: the unmodified api route graph (`buildApp`/`makeFetch` from
 * apps/api/src/worker/http.ts) served by Bun.serve over the self-hosted ports.
 */
import { Context, Effect, Layer, Scope } from "effect"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { IsolateAge } from "@maple/infra/isolate-age"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { buildApp, makeAppGraphs, makeFetch } from "../../api/src/worker/http"
import { gate } from "./gate"
import { handleOidc, OidcRejection, oidcConfigFromEnv } from "./oidc"
import { mintSession } from "./session"
import { makeUsersStore, pgSql } from "./users"
import { selfhostEnv, selfhostPorts, setSchemaApplyRunner } from "./ports"
import { runSchemaApplyInline } from "./schema-apply"
import { pgQueueStore, startVcsQueue, storeProducer } from "./vcs-queue"

const env = selfhostEnv()
// NevrLabs selfhost (PATCHES #6): VCS sync jobs (GitHub backfill + webhooks) go to a Postgres queue consumed below.
const vcsStore = process.env.MAPLE_PG_URL ? pgQueueStore(process.env.MAPLE_PG_URL) : null
if (vcsStore !== null) await vcsStore.ensureSchema()
const ports = selfhostPorts(env, vcsStore === null ? undefined : storeProducer(vcsStore))
const port = Number(process.env.PORT ?? 3472)

setSchemaApplyRunner((orgId) => runSchemaApplyInline(orgId, env))

const fetchEffect = await Effect.runPromise(
	Effect.gen(function* () {
		const { app, queryApp } = yield* makeAppGraphs(Context.empty(), ports)
		return yield* makeFetch(app, ports, queryApp)
	}).pipe(Effect.provide(IsolateAge.layer)),
)
const serve = Cloudflare.Workers.makeRequestHandler(fetchEffect)
const requestLayer = Layer.mergeAll(ports, workerEnvLayer(env))

// NevrLabs selfhost (PATCHES #4, #5): OIDC sign-in for any provider, the users table, and the gate that
// enforces instant revoke + the read-only viewer role in front of the unmodified route graph.
const oidc = oidcConfigFromEnv(process.env)
const rootPassword = process.env.MAPLE_ROOT_PASSWORD ?? ""
const orgId = process.env.MAPLE_DEFAULT_ORG_ID ?? "default"
const users = oidc !== null && process.env.MAPLE_PG_URL ? makeUsersStore(pgSql(process.env.MAPLE_PG_URL)) : null
if (users !== null) await pgSql(process.env.MAPLE_PG_URL!).ensureSchema()
const signIn = async (identity: Parameters<typeof mintSession>[0]) => {
	if (users !== null) {
		const state = await users.revokeState(identity.sub)
		if (state?.disabled) throw new OidcRejection("user disabled", 403)
		await users.signIn(identity)
	}
	return mintSession(identity, orgId, rootPassword, Math.floor(Date.now() / 1000)).token
}
console.log(
	`maple-api (selfhost) oidc ${oidc ? `on issuer=${oidc.issuer} label=${oidc.label} admin=${oidc.adminRole} viewer=${oidc.viewerRole} claim=${oidc.rolesClaim} users=${users ? "pg" : "off"}` : "off"}`,
)

// Warm the full graph so the first user request isn't the cold build (and a broken graph
// fails the readiness probe instead of the first sign-in).
void buildApp

const server = Bun.serve({
	port,
	hostname: "0.0.0.0",
	idleTimeout: 120,
	async fetch(request, srv) {
		const oidcResponse = await handleOidc(request, oidc, signIn)
		if (oidcResponse) return oidcResponse
		const gated = await gate(request, { secret: rootPassword, users, log: (line) => console.log(line) })
		if (gated) return gated
		// Workers set cf-connecting-ip; the auth layer reads it for rate-limit keys.
		const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? srv.requestIP(request)?.address
		const headers = new Headers(request.headers)
		if (ip && !headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", ip)
		const forwarded = new Request(request, { headers })
		const effect = serve({ kind: "Cloudflare.Workers.WorkerEvent", type: "fetch", input: forwarded }) as Effect.Effect<
			Response,
			never,
			Scope.Scope | Cloudflare.WorkerEnvironment
		>
		return Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(requestLayer)))
	},
})
console.log(`maple-api (selfhost) listening on :${server.port}`)
if (vcsStore !== null) startVcsQueue({ store: vcsStore, ports, env, workerEnv: workerEnvLayer(env) })
else console.log("[vcs-queue] off (no MAPLE_PG_URL): VCS sync jobs are dropped")
