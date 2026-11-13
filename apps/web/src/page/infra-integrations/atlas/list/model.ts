import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { AtlasSnapshot } from "../model"

export const Model = Schema.Struct({
	snapshot: KeyedSchema(AtlasSnapshot, LoadFailure),
	/** Bumped per read: every poll is a new key, so a slow answer for an older read is dropped. */
	generation: Schema.Number,
})
export type Model = typeof Model.Type
