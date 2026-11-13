import { Duration, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { pollTicks } from "../../../../data/poll"
import type { Resources } from "../../../../platform/resources"
import type { PageSubscriptionInput } from "../../../contract"
import { Message } from "./message"
import type { Model } from "./model"

const REFRESH = Duration.seconds(30)

/** A live page: re-read on a fixed beat (skipped while the tab is hidden, caught up on return). */
export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()((entry) => ({
	refresh: entry(
		{ isOn: Schema.Boolean },
		{
			modelToDependencies: () => ({ isOn: true }),
			dependenciesToStream: ({ isOn }) =>
				isOn ? Stream.map(pollTicks(REFRESH), () => Message.TickedRefresh()) : Stream.empty,
		},
	),
}))
