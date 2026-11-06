import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../../contract"
import * as Dialog from "../../../../ui/dialog"
import { toLoadFailure } from "../../../../data/load-failure"
import * as Frame from "../../kit/frame"
import * as PeekMessage from "../peek/message"
import { PEEK_METRICS, seriesId } from "../peek/model"
import type { PodRow } from "../pod-data"
import { Message } from "./message"
import type { Model } from "./model"
import { init, podsInput, update } from "./update"
import { view as pageView } from "./view"
import { hasNoMemoryLimit } from "../pod-table"
import { MountPodPeek, PeekRowMessage } from "../peek-rows"
import { ResolveThemeColors, ThemeMessage } from "../../../../charts/theme-colors"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const GIB = 2 ** 30

const pod = (podName: string): PodRow => ({
	podName,
	namespace: "shop",
	nodeName: "ip-10-0-12-84",
	clusterName: "prod",
	environment: "production",
	deploymentName: "payment-svc",
	statefulsetName: "",
	daemonsetName: "",
	jobName: "",
	qosClass: "Burstable",
	podUid: "uid",
	computeType: "ec2",
	lastSeen: "2026-10-01 12:00:00",
	cpuUsage: 0.4,
	cpuLimitPct: 0.5,
	memoryLimitPct: 0.9,
	cpuRequestPct: 0.6,
	memoryRequestPct: 0.95,
	memoryWorkingSet: 0.5 * GIB,
	cpuUsagePeak: 0.5,
	cpuLimitPctPeak: 0.55,
	memoryLimitPctPeak: 0.98,
	memoryWorkingSetPeak: 0.75 * GIB,
	saturation: 0.98,
})

/** No limits set: the kubelet emits no limit ratios, only usage. */
const unlimited = (podName: string): PodRow => ({
	...pod(podName),
	cpuLimitPct: 0,
	memoryLimitPct: 0,
	cpuRequestPct: 0,
	memoryRequestPct: 0,
	cpuLimitPctPeak: 0,
	memoryLimitPctPeak: 0,
	saturation: 0,
	memoryWorkingSet: 2.6 * GIB,
	memoryWorkingSetPeak: 2.8 * GIB,
})

const windowed = (search: Model["search"] = {}) =>
	pageUpdate(
		init({ search }, context).model,
		Message.GotFrameMessage({ message: Frame.Message.CompletedResolveWindow({ window, nowMs: NOW, locale: "en-US", mode: "Load" }) }),
	)

describe("pods list", () => {
	test("the Memory column sorts by working-set bytes", () => {
		const sorted = pageUpdate(windowed().model, Message.ClickedSort({ key: "memoryBytes" }))
		expect(sorted.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/infra/kubernetes/pods?sortBy=memoryBytes&sortDir=desc",
				isReplace: false,
			}),
		)
		expect(podsInput(windowed({ sortBy: "memoryBytes" }).model, window)).toMatchObject({
			sortBy: "memoryBytes",
			sortDir: "desc",
		})
	})

	test("a pod with no limit shows its memory in bytes and a dash for % of limit", () => {
		const model = windowed().model
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchPods({
				key: model.pods.key ?? "",
				result: Result.succeed({ data: [unlimited("warden-erp-backend-0"), pod("payment-1")], totalCount: 2 }),
			}),
		).model
		expect(hasNoMemoryLimit(unlimited("x"))).toBe(true)
		expect(hasNoMemoryLimit(pod("x"))).toBe(false)
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			Mount.resolve(MountPodPeek, PeekRowMessage.ClickedPeekRow({ key: "" })),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			expectView(text("Memory")).toExist(),
			expectView(text("2.6 GB")).toExist(),
			expectView(text("2.8 GB")).toExist(),
			expectView(text("512 MB")).toExist(),
			expectView(text("98%")).toExist(),
		)
	})

	test("the Ended scope swaps the lifecycle; the other scopes narrow the live fleet", () => {
		expect(podsInput(windowed({ scope: "ended" }).model, window)).toMatchObject({ scope: undefined, lifecycle: "ended" })
		expect(podsInput(windowed({ scope: "saturated" }).model, window)).toMatchObject({
			scope: "saturated",
			lifecycle: "live",
		})
	})

	test("a loaded page asks for its pods' restarts", () => {
		const model = windowed().model
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchPods({
				key: model.pods.key ?? "",
				result: Result.succeed({ data: [pod("payment-1")], totalCount: 1 }),
			}),
		)
		expect((loaded.commands ?? []).map(({ name }) => name)).toEqual(["FetchInfraPodRestarts"])
	})

	test("a plain row click peeks: the row's key goes to the URL", () => {
		const peeked = pageUpdate(windowed().model, Message.ClickedPeekRow({ key: "shop/payment-1" }))
		expect(peeked.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/infra/kubernetes/pods?peek=shop%2Fpayment-1",
				isReplace: false,
			}),
		)
	})

	const peekedPage = () => {
		const model = windowed({ peek: "shop/payment-2" }).model
		return pageUpdate(
			model,
			Message.CompletedFetchPods({
				key: model.pods.key ?? "",
				result: Result.succeed({ data: [pod("payment-1"), pod("payment-2"), pod("payment-3")], totalCount: 3 }),
			}),
		)
	}
	const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

	test("the window read brings the browser locale the peek counter formats with", () => {
		const read = Frame.Message.CompletedResolveWindow({ window, nowMs: NOW, locale: "ar-EG", mode: "Load" })
		const model = pageUpdate(windowed().model, Message.GotFrameMessage({ message: read })).model
		expect(model.frame.locale).toBe("ar-EG")
	})

	test("a peeked row opens the sheet and warms it and both neighbours", () => {
		const loaded = peekedPage()
		expect(loaded.model.peek.dialog.isOpen).toBe(true)
		expect(names(loaded.commands).filter((name) => name === "FetchInfraPodPeekSummary")).toHaveLength(3)
		expect(names(loaded.commands).filter((name) => name === "FetchInfraPodPeekSeries")).toHaveLength(15)
	})

	test("retrying the peek's summary re-reads the summary alone, not its charts", () => {
		const { model } = peekedPage()
		const peekMessage = (message: PeekMessage.Message) => Message.GotPeekMessage({ message })
		const charted = PEEK_METRICS.reduce(
			(acc, metric) =>
				pageUpdate(
					acc,
					peekMessage(
						PeekMessage.Message.CompletedFetchSeries({
							id: seriesId("shop/payment-2", metric),
							key: acc.peek.series[seriesId("shop/payment-2", metric)]?.key ?? "",
							result: Result.succeed({ rows: [], unit: "percent" }),
						}),
					),
				).model,
			model,
		)
		const failed = pageUpdate(
			charted,
			peekMessage(
				PeekMessage.Message.CompletedFetchSummary({
					podKey: "shop/payment-2",
					key: charted.peek.summaries["shop/payment-2"]?.key ?? "",
					result: Result.fail(toLoadFailure("boom")),
				}),
			),
		).model
		const retried = pageUpdate(failed, Message.GotPeekMessage({ message: PeekMessage.Message.ClickedRetrySummary() }))
		expect(names(retried.commands)).toEqual(["FetchInfraPodPeekSummary"])
	})

	test("a step replaces the peek with the next row; closing clears it", () => {
		const { model } = peekedPage()
		const stepped = pageUpdate(model, Message.GotPeekMessage({ message: PeekMessage.Message.ClickedStep({ step: 1 }) }))
		expect(stepped.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/kubernetes/pods?peek=shop%2Fpayment-3", isReplace: true }),
		)
		const closed = pageUpdate(
			model,
			Message.GotPeekMessage({ message: PeekMessage.Message.GotDialogMessage({ message: Dialog.Message.PressedEscape() }) }),
		)
		expect(closed.outMessage).toEqual(PageOutMessage.RequestedNavigation({ url: "/infra/kubernetes/pods", isReplace: true }))
	})
})
