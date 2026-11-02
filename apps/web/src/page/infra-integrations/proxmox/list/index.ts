import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/proxmox`: nodes, guests, storage and backups of the Proxmox VE cluster (NevrLabs selfhost). */
export const page = definePage(
	"InfraProxmox",
	{ Model, Message },
	{
		routes: ["InfraProxmox"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: (model) => [
			{ label: "Infrastructure", href: "/infra" },
			{ label: "Proxmox", ...(model.search.node === undefined ? {} : { href: "/infra/proxmox" }) },
			...(model.search.node === undefined ? [] : [{ label: model.search.node }]),
		],
	},
)
