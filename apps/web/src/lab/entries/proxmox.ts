import { defineShellLab } from "../shell-lab"
import { Flags, flags, init, Message, Model, update } from "../proxmox-lab/model"
import { breadcrumbs, toolbar, view } from "../proxmox-lab/view"

// `/lab/proxmox`: Pulse-style Proxmox page mockup over a real FxCluster snapshot (NevrLabs selfhost).

export const lab = defineShellLab("Proxmox", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	before: toolbar,
	currentPath: "/lab/proxmox",
	breadcrumbs,
})
