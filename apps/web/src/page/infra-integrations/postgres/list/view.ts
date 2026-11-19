import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "@maple/views/ui/error-state"
import { vstack } from "@maple/views/ui/stack"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import type { PostgresSnapshot } from "../model"
import { postgresBody, postgresDescription, postgresEmptyBody, postgresLoadingBody } from "../view-parts"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

const DESCRIPTION = "PostgreSQL instances reporting through the OpenTelemetry postgresql receiver."

type Shown = Readonly<{ state: "loading" | "empty" | "live" | "error"; body: ReadonlyArray<Html>; data?: PostgresSnapshot }>

const shown = (h: H, model: Model): Shown => {
	const live = (data: PostgresSnapshot): Shown =>
		data.instances.length === 0 ? { state: "empty", body: postgresEmptyBody(h) } : { state: "live", body: postgresBody(h, data), data }
	return AsyncData.match(model.snapshot.data, {
		onIdle: (): Shown => ({ state: "loading", body: postgresLoadingBody(h) }),
		onLoading: (): Shown => ({ state: "loading", body: postgresLoadingBody(h) }),
		onFailure: (failure): Shown => ({
			state: "error",
			body: [errorState(h, { failure, title: "Couldn't load PostgreSQL metrics", onRetry: Message.ClickedRetry() })],
		}),
		// A failed refresh keeps the last snapshot up; the next poll tries again.
		onStale: ({ data }) => live(data),
		onSuccess: live,
		onRefreshing: live,
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	const page = shown(h, model)
	return dashboardPage(
		h,
		{ title: "PostgreSQL", description: page.data === undefined ? DESCRIPTION : postgresDescription(page.data), gap: "lg" },
		[vstack(h, { gap: "8", attributes: [h.DataAttribute("postgres-state", page.state)] }, page.body)],
	)
})
