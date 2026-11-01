/**
 * Self-hosted api server: the unmodified api route graph (`buildApp`/`makeFetch` from
 * apps/api/src/worker/http.ts) served by Bun.serve over the self-hosted ports.
 */
import { Context, Effect, Layer, Scope } from "effect"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { IsolateAge } from "@maple/infra/isolate-age"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { buildApp, makeAppGraphs, makeFetch } from "../../api/src/worker/http"
import { selfhostEnv, selfhostPorts, setSchemaApplyRunner } from "./ports"
import { runSchemaApplyInline } from "./schema-apply"

const env = selfhostEnv()
const ports = selfhostPorts(env)
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

// Warm the full graph so the first user request isn't the cold build (and a broken graph
// fails the readiness probe instead of the first sign-in).
void buildApp

const server = Bun.serve({
	port,
	hostname: "0.0.0.0",
	idleTimeout: 120,
	async fetch(request, srv) {
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
