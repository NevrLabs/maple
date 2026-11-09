import { expect, test } from "bun:test"
import { WorkerExecutionContext } from "@alchemy.run/cloudflare/Workers/WorkerRuntime"
import { Context, Effect } from "effect"
import { withRequestContext } from "./request-context"

test("request context preserves services for waitUntil work", async () => {
	class Value extends Context.Service<Value, number>()("selfhost-test/Value") {}
	let resolve!: (value: number) => void
	const deferred = new Promise<number>((done) => { resolve = done })
	await Effect.runPromise(withRequestContext(Effect.gen(function* () {
		const context = yield* WorkerExecutionContext
		yield* context.waitUntil(Effect.gen(function* () { resolve(yield* Value) }))
	}), {}).pipe(Effect.provideService(Value, 42)))
	expect(await deferred).toBe(42)
})
