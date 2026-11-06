import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../../charts/theme-colors"
import type { PageContext } from "../../../contract"
import * as Frame from "../../kit/frame"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 11:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const route = { podName: "payment-1", search: { namespace: "shop" } }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const windowed = () =>
	pageUpdate(
		init(route, context).model,
		Message.GotFrameMessage({ message: Frame.Message.CompletedResolveWindow({ window, nowMs: NOW, locale: "en-US", mode: "Load" }) }),
	)

describe("pod detail", () => {
	test("the window fetches the summary, the selected metric and the pod's restarts", () => {
		expect((windowed().commands ?? []).map(({ name }) => name)).toEqual(
			expect.arrayContaining([
				"FetchInfraPodSummary",
				"FetchInfraPodDetailRestarts",
				"FetchInfraPodSeries",
			]),
		)
	})

	test("after a Reload a namespace change reads under the kept window; only a new preset re-resolves", () => {
		const reloaded = pageUpdate(windowed().model, Message.GotFrameMessage({ message: Frame.Message.ClickedReload() })).model
		const moved = routeChanged(reloaded, { ...route, search: { namespace: "billing" } }, context)
		expect((moved.commands ?? []).map(({ name }) => name)).not.toContain("ResolveInfraWindow")
		expect((moved.commands ?? []).map(({ name }) => name)).toContain("FetchInfraPodSummary")
		expect(moved.model.frame.window).toEqual(window)
		const represet = routeChanged(moved.model, { ...route, search: { namespace: "billing", timePreset: "6h" } }, context)
		expect(represet.commands?.map(({ name, args }) => [name, args?.["mode"]])).toEqual([["ResolveInfraWindow", "Refresh"]])
	})

	test("the summary leads with working-set bytes, even with no limit set", () => {
		const model = windowed().model
		const withSummary = pageUpdate(
			model,
			Message.CompletedFetchSummary({
				key: model.summary.key ?? "",
				result: Result.succeed({
					podName: "payment-1",
					namespace: "shop",
					nodeName: "n1",
					deploymentName: "payment",
					statefulsetName: "",
					daemonsetName: "",
					qosClass: "BestEffort",
					podUid: "uid",
					computeType: "",
					podStartTime: "",
					firstSeen: "2026-10-01 11:00:00",
					lastSeen: "2026-10-01 12:00:00",
					cpuUsage: 0.2,
					cpuLimitPct: 0,
					memoryLimitPct: 0,
					cpuRequestPct: 0,
					memoryRequestPct: 0,
					memoryWorkingSet: 2.6 * 2 ** 30,
					memoryWorkingSetPeak: 2.8 * 2 ** 30,
				}),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(withSummary),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			expectView(text("Memory working set")).toExist(),
			expectView(text("2.6 GB")).toExist(),
			expectView(text("peak 2.8 GB")).toExist(),
		)
	})

	test("restarted containers get their own table", () => {
		const model = windowed().model
		const withRestarts = pageUpdate(
			model,
			Message.CompletedFetchRestarts({
				key: model.restarts.key ?? "",
				result: Result.succeed([
					{
						podName: "payment-1",
						namespace: "shop",
						containerName: "app",
						restarts: 4,
						totalRestarts: 9,
						lastTerminatedReason: "OOMKilled",
					},
				]),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(withRestarts),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			expectView(text("Container restarts")).toExist(),
			expectView(text("OOMKilled")).toExist(),
		)
	})
})
