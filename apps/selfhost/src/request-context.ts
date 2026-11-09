import { fromExecutionContext, WorkerExecutionContext } from "@alchemy.run/cloudflare/Workers/WorkerRuntime"
import { Effect } from "effect"

/** Bun keeps the process alive; preserve the caller's services for deferred request work. */
export const withRequestContext = <A, E, R>(effect: Effect.Effect<A, E, R>, env: Record<string, unknown>) =>
	effect.pipe(Effect.provideService(WorkerExecutionContext, fromExecutionContext({
		waitUntil: (promise: Promise<unknown>) => { void promise.catch((error) => console.error("selfhost: deferred request failed", error)) },
		passThroughOnException: () => {},
		props: {},
		exports: {},
	} as Parameters<typeof fromExecutionContext>[0], env)))
