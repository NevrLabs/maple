import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../../contract"
import { assembleSnapshot } from "../data"
import type { ProxmoxSnapshot } from "../model"
import { shownGuests } from "../view-parts"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update, viewStateOf } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = 1_793_600_000_000

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

const nodeRow = (name: string, lastSeenMs = NOW - 5_000) => ({
	name,
	cluster: "FxCluster",
	version: "9.2.21",
	cpu: 0.25,
	cpus: 8,
	load1: 1.5,
	memUsed: 30e9,
	arc: 2e9,
	memTotal: 48e9,
	swapUsed: 1e9,
	swapTotal: 8e9,
	rootUsed: 20e9,
	rootTotal: 300e9,
	uptime: 600_000,
	lastSeenMs,
	cpuRaw: Array.from({ length: 30 }, (_, i) => i / 100),
})
const guestRow = (vmid: string, name: string, node: string, uptime: number, cpu = 0.1) => ({
	vmid,
	name,
	type: "lxc",
	node,
	uptime,
	cpu,
	cpus: 2,
	mem: 1e9,
	maxmem: 2e9,
	disk: 4e9,
	maxdisk: 8e9,
	netIn: 1200,
	netOut: 900,
	diskRead: 0,
	diskWrite: 0,
})

/** Raw-SQL rows as the API returns them (numbers as numbers, flags as 0/1). */
const snapshot = (overrides: Partial<Parameters<typeof assembleSnapshot>[0]> = {}): ProxmoxSnapshot =>
	assembleSnapshot({
		nowMs: NOW,
		nodes: [nodeRow("akasha"), nodeRow("thinkcentre-01")],
		guests: [
			guestRow("101", "adguard", "akasha", 1000, 0.05),
			guestRow("130", "maple", "akasha", 2000, 0.4),
			guestRow("105", "nocodb", "thinkcentre-01", 0),
		],
		storage: [{ name: "DeepVault", nodes: ["akasha", "thinkcentre-01"], shared: 1, used: 8e11, total: 1e12 }],
		storageMeta: [{ name: "DeepVault", type: "nfs", shared: 1, snapshotMs: NOW - 60_000 }],
		backups: [
			{ vmid: "130", storage: "DeepVault", ctime: (NOW - 3_600_000) / 1000, size: 1.8e9, sizeKnown: 1, format: "lxc", protected: 0, snapshotMs: NOW - 60_000 },
			{ vmid: "999", storage: "DeepVault", ctime: (NOW - 90 * 86_400_000) / 1000, size: 0, sizeKnown: 0, format: "qemu", protected: 0, snapshotMs: NOW - 60_000 },
		],
		jobs: [{ id: "backup-maple130", schedule: "01:45", storage: "DeepVault", vmids: "130", enabled: 1, comment: "", snapshotMs: NOW - 60_000 }],
		...overrides,
	})

const loaded = (data: ProxmoxSnapshot, search: Model["search"] = {}): Model => {
	const entered = init({ search }, context)
	return pageUpdate(
		entered.model,
		Message.CompletedFetchSnapshot({ key: entered.model.snapshot.key ?? "", result: Result.succeed(data) }),
	).model
}

describe("proxmox route", () => {
	test("entry reads the snapshot once; a refresh tick reads again under a new key", () => {
		const entered = init({ search: {} }, context)
		expect(names(entered.commands)).toEqual(["FetchProxmoxSnapshot"])
		const model = loaded(snapshot())
		const ticked = pageUpdate(model, Message.TickedRefresh())
		expect(names(ticked.commands)).toEqual(["FetchProxmoxSnapshot"])
		expect(ticked.model.snapshot.key).not.toEqual(model.snapshot.key)
	})

	test("an answer for a superseded read is dropped", () => {
		const first = init({ search: {} }, context).model
		const second = pageUpdate(first, Message.TickedRefresh()).model
		const late = pageUpdate(
			second,
			Message.CompletedFetchSnapshot({ key: first.snapshot.key ?? "", result: Result.succeed(snapshot({ nodes: [] })) }),
		)
		expect(late.model.snapshot).toEqual(second.snapshot)
	})

	test("raw-SQL rows assemble into the snapshot the view draws", () => {
		const data = snapshot()
		expect(data.cluster).toBe("FxCluster")
		expect(data.pveVersion).toBe("9.2.21")
		expect(data.nodes[0]?.cpuSpark).toHaveLength(28)
		expect(data.guests.map((guest) => guest.status)).toEqual(["running", "running", "stopped"])
		expect(data.storage[0]).toMatchObject({ type: "nfs", shared: true })
		expect(data.backups[0]).toMatchObject({ ctime: NOW - 3_600_000, sizeKnown: true })
		expect(data.backups[1]?.sizeKnown).toBe(false)
		expect(data.backupJobs[0]?.enabled).toBe(true)
		expect(data.backupsAsOfMs).toBe(NOW - 60_000)
	})

	test("live: node cards, guests and storage render, and no lab toolbar", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot())),
			expectView(text("FxCluster · PVE 9.2.21 · 2 nodes, 3 guests")).toExist(),
			expectView(role("button", { name: /akasha/ })).toExist(),
			expectView(text("adguard")).toExist(),
			expectView(text("DeepVault")).toExist(),
			expectView(role("radiogroup", { name: "Lab state" })).not.toExist(),
			expectView(text("Proxmox lab")).not.toExist(),
		)
	})

	test("a node silent past the cut is offline and its guests unknown", () => {
		const data = snapshot({ nodes: [nodeRow("akasha", NOW - 7 * 60_000), nodeRow("thinkcentre-01")] })
		scene({ update: pageUpdate, view }, given(loaded(data)), expectView(text("OFFLINE · 7m ago")).toExist())
		const state = viewStateOf({})
		expect(shownGuests(state, data).filter((row) => row.state === "unknown").map((row) => row.guest.vmid)).toEqual(["101", "130"])
	})

	test("no node in the window shows the setup state, not an empty table", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot({ nodes: [], guests: [], storage: [] }))),
			expectView(text("No Proxmox metrics in the last hour")).toExist(),
		)
	})

	test("backups tab: per-guest rows, deleted guests, unknown sizes and the collector's age", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(snapshot(), { tab: "backups" })),
			expectView(text("Deleted guests (999)")).toExist(),
			expectView(text("1 archives predate PVE's task history: size unknown, counted as 0")).toExist(),
			expectView(text(/backup data as of 1m ago/)).toExist(),
		)
	})

	test("tab, node and search go to the URL; pressing the scoped node again clears it", () => {
		const model = loaded(snapshot())
		expect(pageUpdate(model, Message.ClickedTab({ tab: "storage" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/proxmox?tab=storage", isReplace: false }),
		)
		expect(pageUpdate(model, Message.ChangedQuery({ value: "map" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/proxmox?q=map", isReplace: true }),
		)
		const scoped = loaded(snapshot(), { node: "akasha" })
		expect(pageUpdate(scoped, Message.ClickedNode({ node: "akasha" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/proxmox", isReplace: false }),
		)
		expect(shownGuests(viewStateOf({ node: "akasha" }), snapshot()).map((row) => row.guest.vmid)).toEqual(["130", "101"])
	})
})
