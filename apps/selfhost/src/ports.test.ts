import { expect, test } from "bun:test"
import { CancellationReviewQueueProducer, ShareLinkRateLimit, VcsBackfillQueueProducer, VcsSyncQueueProducer } from "@maple/backend/platform/bindings"
import { SourceMapBucket, SourceMapReadBucket } from "@maple/backend/platform/bindings"
import { Effect, Option, Result } from "effect"
import { selfhostPorts } from "./ports"

test("upstream backfill shares the durable VCS producer and new ports resolve", async () => {
	let sent = 0
	const producer = { sendBatch: (messages: ReadonlyArray<{ body: unknown }>) => Effect.sync(() => { sent += messages.length }) }
	await Effect.runPromise(Effect.gen(function* () {
		const sync = yield* VcsSyncQueueProducer
		const backfill = yield* VcsBackfillQueueProducer
		expect(sync).toBe(producer)
		expect(backfill).toBe(producer)
		yield* backfill.sendBatch([{ body: { kind: "backfill" } }])
		expect(sent).toBe(1)
		const cancellation = yield* CancellationReviewQueueProducer
		yield* cancellation.sendBatch([])
		const limiter = yield* ShareLinkRateLimit
		expect(yield* limiter.limit("link")).toEqual({ success: true })
		const sourceMaps = yield* SourceMapBucket
		const reader = yield* SourceMapReadBucket
		expect(yield* reader.getBytes("missing")).toEqual(Option.none())
		const upload = yield* Effect.result(sourceMaps.put("map", new Uint8Array(), "application/json"))
		expect(Result.isFailure(upload) && upload.failure.message).toBe("Source map storage is not configured on selfhost")
	}).pipe(Effect.provide(selfhostPorts({} , producer))))
})
