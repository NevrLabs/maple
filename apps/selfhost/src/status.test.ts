import { expect, test } from "bun:test"
import { makeSnapshot } from "../../../packages/status-page/src/fixtures"
import { addressOf, makeFakeStorage, postForm, publish } from "../../status/src/test-support"
import type * as Status from "./status"

// Also exercise the packaged entry point (including its Wasm and fonts), without opening Postgres.
const { makeStatusFetch }: typeof Status = await import(process.env.MAPLE_STATUS_BUNDLE ?? "./status")

test("the Bun status handler renders a real PNG link preview", async () => {
	const fake = makeFakeStorage()
	const snapshot = makeSnapshot()
	publish(fake, snapshot, { heartbeatAt: Date.now() })
	const origin = "https://monitoring.example"
	const fetch = makeStatusFetch(fake.storage, origin)
	const path = `/s/${addressOf(snapshot)}/og.png`
	expect((await fetch(new Request(`https://unknown.example${path}`))).status).toBe(404)
	const response = await fetch(new Request(origin + path))
	expect(response.status).toBe(200)
	expect(response.headers.get("content-type")).toBe("image/png")
	const png = new DataView(await response.arrayBuffer())
	expect(png.getBigUint64(0)).toBe(0x89504e470d0a1a0an)
	expect([png.getUint32(16), png.getUint32(20)]).toEqual([1200, 630])
})

test("the Bun status handler limits password attempts across clients without exposing the preview", async () => {
	const fake = makeFakeStorage()
	const page = makeSnapshot().page
	const snapshot = makeSnapshot({ page: { ...page, visibility: "password" } })
	publish(fake, snapshot, { heartbeatAt: Date.now() })
	const origin = "https://monitoring.example"
	const fetch = makeStatusFetch(fake.storage, origin)
	const url = `${origin}/s/${addressOf(snapshot)}`
	const preview = await fetch(new Request(`${url}/og.png`))
	expect(preview.status).toBe(401)
	expect(preview.headers.get("cache-control")).toBe("private, no-store")
	const attempt = (client: number) => fetch(postForm(`${url}/_access`, [], `203.0.113.${client}`))
	for (let client = 1; client <= 100; client++) expect((await attempt(client)).status).toBe(401)
	expect((await attempt(101)).status).toBe(429)
})
