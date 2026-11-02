import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BATCH_SIZE, LEASE_SECONDS, backoffSeconds, memoryQueueStore, runOnce, storeProducer } from "./vcs-queue"

// NevrLabs selfhost: the Postgres-backed VCS sync queue's delivery semantics (PATCHES #6), on the in-memory twin.

const clocked = () => {
	let t = 1_000
	const store = memoryQueueStore(() => t)
	return { store, advance: (s: number) => (t += s) }
}

describe("vcs-sync queue", () => {
	test("the producer port enqueues what upstream sends (incl. delay)", async () => {
		const { store, advance } = clocked()
		await Effect.runPromise(storeProducer(store).sendBatch([{ body: { a: 1 } }, { body: { b: 2 }, delaySeconds: 60 }]))
		expect(await store.depth()).toEqual({ due: 1, total: 2 })
		advance(60)
		expect(await store.depth()).toEqual({ due: 2, total: 2 })
	})

	test("ack deletes; attempts count deliveries", async () => {
		const { store } = clocked()
		await store.enqueue([{ body: "x" }])
		let seen = 0
		await runOnce(store, async (msgs) => {
			seen = msgs[0]!.attempts
			msgs[0]!.ack()
		})
		expect(seen).toBe(1)
		expect((await store.depth()).total).toBe(0)
	})

	test("retry with delay hides the row for exactly that delay", async () => {
		const { store, advance } = clocked()
		await store.enqueue([{ body: "x" }])
		await runOnce(store, async (msgs) => msgs[0]!.retry({ delaySeconds: 120 }))
		advance(119)
		expect((await store.depth()).due).toBe(0)
		advance(1)
		let attempts = 0
		await runOnce(store, async (msgs) => {
			attempts = msgs[0]!.attempts
			msgs[0]!.ack()
		})
		expect(attempts).toBe(2)
	})

	test("undecided or thrown batches are retried with backoff, never dropped", async () => {
		const { store, advance } = clocked()
		await store.enqueue([{ body: "x" }, { body: "y" }])
		await runOnce(store, async () => {
			throw new Error("boom")
		})
		expect(await store.depth()).toEqual({ due: 0, total: 2 })
		advance(backoffSeconds(1))
		expect((await store.depth()).due).toBe(2)
	})

	test("a claimed row is leased: invisible to a second claim until the lease runs out", async () => {
		const { store, advance } = clocked()
		await store.enqueue([{ body: "x" }])
		expect((await store.claim(5)).length).toBe(1)
		expect((await store.claim(5)).length).toBe(0)
		advance(LEASE_SECONDS)
		const again = await store.claim(5)
		expect(again.length).toBe(1)
		expect(again[0]!.attempts).toBe(2)
	})

	test("ack after retry wins (upstream may call both); batches are capped", async () => {
		const { store } = clocked()
		await store.enqueue(Array.from({ length: BATCH_SIZE + 3 }, (_, i) => ({ body: i })))
		const n = await runOnce(store, async (msgs) => {
			for (const m of msgs) {
				m.retry()
				m.ack()
			}
		})
		expect(n).toBe(BATCH_SIZE)
		expect((await store.depth()).total).toBe(3)
	})
})
