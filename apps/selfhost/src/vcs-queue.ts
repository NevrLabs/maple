/**
 * NevrLabs selfhost: the VCS sync queue (GitHub commit backfill + webhook deltas) without Cloudflare Queues.
 *
 * Upstream's producer port (`VcsSyncQueueProducer`) writes rows into Postgres `selfhost_vcs_queue`; a loop in the
 * (single-replica) api process claims due rows, runs upstream's unmodified consumer (`processBatch` from
 * apps/api/src/vcs-sync-runtime.ts) over them and applies its per-message decisions: ack = delete, retry = make
 * visible again after the requested delay (or a backoff). A claim is a lease: a process that dies mid-batch leaves
 * its rows to be re-claimed when the lease runs out, exactly like an unacked queue message. Also fires upstream's
 * 12 h scheduled sync (the Worker cron `0 *\/12 * * *`).
 *
 * Fork-only file (PATCHES #6). Upstream files are not edited.
 */
import { Effect, Layer } from "effect"
import { QueueSendError, type QueueProducer } from "@maple/backend/platform/bindings"

export const LEASE_SECONDS = 300
export const BATCH_SIZE = 10
/** Redelivery backoff when the consumer asks for a retry without a delay: 10 s, 40 s, 90 s, ... capped at 15 min. */
export const backoffSeconds = (attempts: number) => Math.min(900, 10 * attempts * attempts)

export type QueuedRow = Readonly<{ id: string; body: unknown; attempts: number }>

export type QueueStore = Readonly<{
	ensureSchema: () => Promise<void>
	enqueue: (items: ReadonlyArray<{ body: unknown; delaySeconds?: number | undefined }>) => Promise<void>
	/** Due rows, leased for LEASE_SECONDS, attempts already incremented (this delivery's number). */
	claim: (limit: number) => Promise<ReadonlyArray<QueuedRow>>
	ack: (id: string) => Promise<void>
	retry: (id: string, delaySeconds: number) => Promise<void>
	depth: () => Promise<{ due: number; total: number }>
}>

export const pgQueueStore = (url: string): QueueStore => {
	const db = new Bun.SQL(url, { max: 2, idleTimeout: 30 })
	return {
		ensureSchema: async () => {
			await db`CREATE TABLE IF NOT EXISTS selfhost_vcs_queue (
				id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				body jsonb NOT NULL,
				attempts integer NOT NULL DEFAULT 0,
				visible_at timestamptz NOT NULL DEFAULT now(),
				created_at timestamptz NOT NULL DEFAULT now()
			)`
			await db`CREATE INDEX IF NOT EXISTS selfhost_vcs_queue_visible_idx ON selfhost_vcs_queue (visible_at)`
		},
		enqueue: async (items) => {
			for (const item of items) {
				const delay = Math.max(0, Math.floor(item.delaySeconds ?? 0))
				await db`INSERT INTO selfhost_vcs_queue (body, visible_at)
					VALUES (${JSON.stringify(item.body)}::jsonb, now() + make_interval(secs => ${delay}))`
			}
		},
		claim: async (limit) =>
			(
				(await db`UPDATE selfhost_vcs_queue SET attempts = attempts + 1,
						visible_at = now() + make_interval(secs => ${LEASE_SECONDS})
					WHERE id IN (SELECT id FROM selfhost_vcs_queue WHERE visible_at <= now()
						ORDER BY visible_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
					RETURNING id::text AS id, body, attempts`) as Array<{ id: string; body: unknown; attempts: number }>
			).map((r) => ({ id: r.id, body: typeof r.body === "string" ? JSON.parse(r.body) : r.body, attempts: r.attempts })),
		ack: async (id) => {
			await db`DELETE FROM selfhost_vcs_queue WHERE id = ${id}::uuid`
		},
		retry: async (id, delaySeconds) => {
			await db`UPDATE selfhost_vcs_queue SET visible_at = now() + make_interval(secs => ${delaySeconds}) WHERE id = ${id}::uuid`
		},
		depth: async () => {
			const [r] = (await db`SELECT count(*) FILTER (WHERE visible_at <= now())::int AS due, count(*)::int AS total
				FROM selfhost_vcs_queue`) as Array<{ due: number; total: number }>
			return { due: r?.due ?? 0, total: r?.total ?? 0 }
		},
	}
}

/** In-memory store with the same semantics, for tests. `clock` is seconds. */
export const memoryQueueStore = (clock: () => number = () => Date.now() / 1000) => {
	const rows = new Map<string, { body: unknown; attempts: number; visibleAt: number; seq: number }>()
	let seq = 0
	const store: QueueStore = {
		ensureSchema: async () => {},
		enqueue: async (items) => {
			for (const item of items) {
				seq += 1
				rows.set(`m${seq}`, { body: item.body, attempts: 0, visibleAt: clock() + (item.delaySeconds ?? 0), seq })
			}
		},
		claim: async (limit) => {
			const now = clock()
			const due = [...rows.entries()].filter(([, r]) => r.visibleAt <= now).sort((a, b) => a[1].visibleAt - b[1].visibleAt || a[1].seq - b[1].seq)
			return due.slice(0, limit).map(([id, r]) => {
				r.attempts += 1
				r.visibleAt = now + LEASE_SECONDS
				return { id, body: r.body, attempts: r.attempts }
			})
		},
		ack: async (id) => void rows.delete(id),
		retry: async (id, delay) => {
			const r = rows.get(id)
			if (r) r.visibleAt = clock() + delay
		},
		depth: async () => ({ due: [...rows.values()].filter((r) => r.visibleAt <= clock()).length, total: rows.size }),
	}
	return Object.assign(store, { rows })
}

/** The producer port upstream's VcsSyncQueue service sends through. */
export const storeProducer = (store: QueueStore): QueueProducer => ({
	sendBatch: (messages) =>
		Effect.tryPromise({
			try: () => store.enqueue(messages),
			catch: (cause) => new QueueSendError({ message: "selfhost: vcs-sync enqueue failed", cause }),
		}),
})

/** A claimed row as the Cloudflare `Message` upstream's consumer expects; its decision is recorded, then applied. */
type Decision = { kind: "ack" } | { kind: "retry"; delaySeconds: number | undefined }
export const asMessage = (row: QueuedRow, decisions: Map<string, Decision>) => ({
	id: row.id,
	timestamp: new Date(),
	body: row.body,
	attempts: row.attempts,
	ack: () => void decisions.set(row.id, { kind: "ack" }),
	retry: (options?: { delaySeconds?: number }) =>
		void (decisions.get(row.id)?.kind === "ack" ? undefined : decisions.set(row.id, { kind: "retry", delaySeconds: options?.delaySeconds })),
})

/**
 * One claim → process → settle cycle. `process` gets Cloudflare-shaped messages; a message it neither acked nor
 * retried (or a batch that threw) is retried with backoff. Returns how many rows it handled.
 */
export const runOnce = async (
	store: QueueStore,
	process: (messages: ReadonlyArray<ReturnType<typeof asMessage>>) => Promise<void>,
	log: (line: string) => void = () => {},
): Promise<number> => {
	const rows = await store.claim(BATCH_SIZE)
	if (rows.length === 0) return 0
	const decisions = new Map<string, Decision>()
	try {
		await process(rows.map((row) => asMessage(row, decisions)))
	} catch (error) {
		log(`[vcs-queue] batch of ${rows.length} failed: ${String(error).slice(0, 300)}`)
	}
	let acked = 0
	for (const row of rows) {
		const d = decisions.get(row.id)
		if (d?.kind === "ack") {
			await store.ack(row.id)
			acked += 1
		} else await store.retry(row.id, d?.delaySeconds ?? backoffSeconds(row.attempts))
	}
	log(`[vcs-queue] batch ${rows.length}: acked=${acked} retried=${rows.length - acked}`)
	return rows.length
}

/** Starts the consumer loop (+ the 12 h scheduled sync). Single replica by design, like alerting. */
export const startVcsQueue = (opts: {
	store: QueueStore
	ports: Layer.Layer<any, any, never>
	env: Record<string, unknown>
	workerEnv: Layer.Layer<any, never, never>
	log?: (line: string) => void
	pollMs?: number
}) => {
	const log = opts.log ?? ((line: string) => console.log(line))
	const runtime = import("../../api/src/vcs-sync-runtime")
	const caches = import("@maple/backend/services/integrations/vcs/vcs-sync-isolate-caches").then((m) =>
		Effect.runPromise(m.makeVcsSyncIsolateCaches),
	)
	const events = import("../../api/src/worker/events")

	const process = async (messages: ReadonlyArray<ReturnType<typeof asMessage>>) => {
		const [{ processBatch, VcsSyncLive, vcsSyncTelemetry }, cacheLayer, { runEvent }] = await Promise.all([runtime, caches, events])
		const layer = VcsSyncLive.pipe(
			Layer.provide(cacheLayer),
			Layer.provideMerge(vcsSyncTelemetry),
			Layer.provideMerge(opts.ports),
			Layer.provideMerge(opts.workerEnv),
		)
		await Effect.runPromise(runEvent(processBatch({ messages: messages as any }), layer as any) as Effect.Effect<void, unknown, never>)
	}

	let busy = false
	const tick = async () => {
		if (busy) return
		busy = true
		try {
			// Drain: keep going while full batches come back.
			while ((await runOnce(opts.store, process, log)) === BATCH_SIZE) {}
		} catch (error) {
			log(`[vcs-queue] tick failed: ${String(error).slice(0, 300)}`)
		} finally {
			busy = false
		}
	}
	setInterval(() => void tick(), opts.pollMs ?? 2_000)

	const scheduled = async () => {
		try {
			const [{ runScheduledSync, VcsScheduledLive, vcsSyncTelemetry }, { runEvent }] = await Promise.all([runtime, events])
			const layer = VcsScheduledLive.pipe(
				Layer.provideMerge(vcsSyncTelemetry),
				Layer.provideMerge(opts.ports),
				Layer.provideMerge(opts.workerEnv),
			)
			await Effect.runPromise(runEvent(runScheduledSync, layer as any) as Effect.Effect<void, unknown, never>)
			log("[vcs-queue] scheduled sync tick done")
		} catch (error) {
			log(`[vcs-queue] scheduled sync failed: ${String(error).slice(0, 300)}`)
		}
	}
	// Upstream cron `0 */12 * * *` (UTC).
	const msToNext12h = () => {
		const now = new Date()
		const next = new Date(now)
		next.setUTCMinutes(0, 0, 0)
		next.setUTCHours(now.getUTCHours() < 12 ? 12 : 24)
		return next.getTime() - now.getTime()
	}
	const arm = () => setTimeout(() => void scheduled().finally(arm), msToNext12h())
	arm()
	log(`[vcs-queue] consumer on (poll ${opts.pollMs ?? 2_000} ms, batch ${BATCH_SIZE}, lease ${LEASE_SECONDS}s, scheduled sync every 12 h UTC)`)
	return { tick, scheduled }
}
