import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "@maple/views/ui/error-state"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import type { ProxmoxSnapshot } from "../model"
import {
	type ProxmoxActions,
	proxmoxBody,
	proxmoxDescription,
	proxmoxEmptyBody,
	proxmoxLoadingBody,
	proxmoxTabs,
} from "../view-parts"
import { Message } from "./message"
import type { Model } from "./model"
import { viewStateOf } from "./update"

type H = HtmlBuilder<Message>

const ACTIONS: ProxmoxActions<Message> = {
	tab: (tab) => Message.ClickedTab({ tab }),
	query: (value) => Message.ChangedQuery({ value }),
	scope: (scope) => Message.ChangedGuestScope({ scope }),
	node: (node) => Message.ClickedNode({ node }),
}

const DESCRIPTION = "Proxmox VE clusters reporting through the native OpenTelemetry metric server."

type Shown = Readonly<{ state: "loading" | "empty" | "live" | "error"; body: ReadonlyArray<Html>; data?: ProxmoxSnapshot }>

const shown = (h: H, model: Model): Shown => {
	const live = (data: ProxmoxSnapshot): Shown =>
		data.nodes.length === 0
			? { state: "empty", body: proxmoxEmptyBody(h) }
			: { state: "live", body: proxmoxBody(h, viewStateOf(model.search), data, ACTIONS), data }
	return AsyncData.match(model.snapshot.data, {
		onIdle: (): Shown => ({ state: "loading", body: proxmoxLoadingBody(h) }),
		onLoading: (): Shown => ({ state: "loading", body: proxmoxLoadingBody(h) }),
		onFailure: (failure): Shown => ({
			state: "error",
			body: [errorState(h, { failure, title: "Couldn't load Proxmox metrics", onRetry: Message.ClickedRetry() })],
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
		{
			title: "Proxmox",
			description: page.data === undefined ? DESCRIPTION : proxmoxDescription(page.data),
			actions: page.data === undefined ? undefined : proxmoxTabs(h, viewStateOf(model.search).tab, ACTIONS),
			gap: "lg",
		},
		[h.div([h.Class("flex flex-col gap-8"), h.DataAttribute("proxmox-state", page.state)], page.body)],
	)
})
