import type { Html, HtmlBuilder } from "foldkit/html"
import type { ProxmoxSnapshot } from "../../page/infra-integrations/proxmox/model"
import {
	type ProxmoxActions,
	proxmoxBody,
	proxmoxDescription,
	proxmoxEmptyBody,
	proxmoxLoadingBody,
	proxmoxTabs,
} from "../../page/infra-integrations/proxmox/view-parts"
import { dashboardPage } from "../../page/kit/dashboard-page"
import type * as Shell from "../../shell"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { PROXMOX_FIXTURE } from "./fixture.generated"
import { LAB_STATES, Message, type Model, STATE_LABEL } from "./model"

type H = HtmlBuilder<Message>

// `/lab/proxmox`: the real `/infra/proxmox` view parts over a frozen FxCluster snapshot, plus a floating
// review toolbar that forces the data state. The toolbar is a lab device only; the route never shows it.

const ACTIONS: ProxmoxActions<Message> = {
	tab: (tab) => Message.ClickedTab({ tab }),
	query: (value) => Message.ChangedQuery({ value }),
	scope: (scope) => Message.ChangedGuestScope({ scope }),
	node: (node) => Message.ClickedNode({ node }),
}

/** The review state applied to the snapshot: `offline` ages one node's last push past the silence cut. */
const dataFor = (model: Model): ProxmoxSnapshot => {
	const base: ProxmoxSnapshot = { ...(PROXMOX_FIXTURE as unknown as ProxmoxSnapshot), backupsAsOfMs: PROXMOX_FIXTURE.capturedAtMs }
	if (model.state !== "offline") return base
	return {
		...base,
		nodes: base.nodes.map((node) =>
			node.name === "thinkcentre-02" ? { ...node, lastSeenMs: base.capturedAtMs - 7 * 60_000 } : node,
		),
	}
}

export const view = (model: Model, h: H): Html => {
	const data = dataFor(model)
	const state = { tab: model.tab, query: model.query, guestScope: model.guestScope, nodeFilter: model.nodeFilter }
	const body =
		model.state === "loading"
			? proxmoxLoadingBody(h)
			: model.state === "empty"
				? proxmoxEmptyBody(h)
				: proxmoxBody(h, state, data, ACTIONS)
	return dashboardPage(
		h,
		{
			title: "Proxmox",
			description:
				model.state === "empty"
					? "Proxmox VE clusters reporting through the native OpenTelemetry metric server."
					: proxmoxDescription(data),
			actions: model.state === "empty" ? undefined : proxmoxTabs(h, model.tab, ACTIONS),
			// The floating lab toolbar (~48px + 16px inset) sits over the page bottom: keep the last row clear of it.
			scrollClassName: "gap-8 pb-28",
		},
		[h.div([h.Class("flex flex-col gap-8"), h.DataAttribute("proxmox-state", model.state)], body)],
	)
}

/** The floating review toolbar (the Cloudflare lab's pattern): data state for the mockup review. */
export const toolbar = (model: Model, h: H): Html =>
	h.div(
		[h.Class("fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-popover px-3 py-2 shadow-popup")],
		[
			h.span([h.Class("font-mono text-2xs text-muted-foreground")], ["Proxmox lab"]),
			segmentedSelect(h, {
				size: "xs",
				ariaLabel: "Lab state",
				options: LAB_STATES.map((value) => ({ value, label: STATE_LABEL[value] })),
				value: model.state,
				onChange: (state) => Message.ClickedLabState({ state }),
			}),
		],
	)

export const breadcrumbs = (model: Model): ReadonlyArray<Shell.BreadcrumbEntry> => [
	{ label: "Infrastructure" },
	{ label: "Proxmox" },
	...(model.nodeFilter === undefined ? [] : [{ label: model.nodeFilter }]),
]
