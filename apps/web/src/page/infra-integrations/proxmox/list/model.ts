import { Schema } from "effect"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { InfraProxmoxSearch } from "../../../../route/search"
import { ProxmoxSnapshot } from "../model"

// `/infra/proxmox`: the tab, node scope, guest scope and search live in the URL (stable review links).

export const Model = Schema.Struct({
	search: InfraProxmoxSearch,
	snapshot: KeyedSchema(ProxmoxSnapshot, LoadFailure),
	/** Bumped per read: every poll is a new key, so a slow answer for an older read is dropped. */
	generation: Schema.Number,
})
export type Model = typeof Model.Type
