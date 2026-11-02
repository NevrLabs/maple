/**
 * Self-hosted api server: the unmodified api route graph (`buildApp`/`makeFetch` from
 * apps/api/src/worker/http.ts) served by Bun.serve over the self-hosted ports.
 */
import { Context, Effect, Layer, Scope } from "effect"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { IsolateAge } from "@maple/infra/isolate-age"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { buildApp, makeAppGraphs, makeFetch } from "../../api/src/worker/http"
import { makeMintSelfHostedSessionForSubject } from "@maple/auth"
import { Option, Redacted } from "effect"
import { handleOidc, oidcConfigFromEnv } from "./oidc"
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

// NevrLabs selfhost: "Sign in with Zitadel" (PATCHES #4). Minting reuses the root-password login's signer.
const oidc = oidcConfigFromEnv(process.env)
const mintForSubject = makeMintSelfHostedSessionForSubject({
	MAPLE_AUTH_MODE: process.env.MAPLE_AUTH_MODE ?? "self_hosted",
	MAPLE_DEFAULT_ORG_ID: process.env.MAPLE_DEFAULT_ORG_ID ?? "default",
	MAPLE_ROOT_PASSWORD: Option.map(Option.fromNullishOr(process.env.MAPLE_ROOT_PASSWORD), Redacted.make),
})
const mint = (subject: string) => Effect.runPromise(Effect.map(mintForSubject(subject), (session) => session.token))
console.log(`maple-api (selfhost) oidc ${oidc ? `on issuer=${oidc.issuer} role=${oidc.requiredRole}` : "off"}`)

// Warm the full graph so the first user request isn't the cold build (and a broken graph
// fails the readiness probe instead of the first sign-in).
void buildApp

const server = Bun.serve({
	port,
	hostname: "0.0.0.0",
	idleTimeout: 120,
	async fetch(request, srv) {
		const oidcResponse = await handleOidc(request, oidc, mint)
		if (oidcResponse) return oidcResponse
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
