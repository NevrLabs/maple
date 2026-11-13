import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "@maple/views/ui/error-state"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import type { AtlasSnapshot } from "../model"
import { atlasBody, atlasDescription, atlasEmptyBody, atlasLoadingBody } from "../view-parts"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

const DESCRIPTION = "MongoDB Atlas replica sets reporting through Atlas's Prometheus integration."

type Shown = Readonly<{ state: "loading" | "empty" | "live" | "error"; body: ReadonlyArray<Html>; data?: AtlasSnapshot }>

const shown = (h: H, model: Model): Shown => {
	const live = (data: AtlasSnapshot): Shown =>
		data.nodes.length === 0 ? { state: "empty", body: atlasEmptyBody(h) } : { state: "live", body: atlasBody(h, data), data }
	return AsyncData.match(model.snapshot.data, {
		onIdle: (): Shown => ({ state: "loading", body: atlasLoadingBody(h) }),
		onLoading: (): Shown => ({ state: "loading", body: atlasLoadingBody(h) }),
		onFailure: (failure): Shown => ({
			state: "error",
			body: [errorState(h, { failure, title: "Couldn't load MongoDB Atlas metrics", onRetry: Message.ClickedRetry() })],
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
		{ title: "MongoDB Atlas", description: page.data === undefined ? DESCRIPTION : atlasDescription(page.data), gap: "lg" },
		[h.div([h.Class("flex flex-col gap-8"), h.DataAttribute("atlas-state", page.state)], page.body)],
	)
})
