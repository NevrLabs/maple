import { describe, expect, it } from "vitest"
import { isAllowedPrivate, parsePrivateAllowlist } from "./index"

// NevrLabs selfhost (PATCHES #8): the opt-in private-network allowlist.
describe("private allowlist", () => {
	const allow = parsePrivateAllowlist("192.168.0.0/16, home ,10.1.2.0/24")

	it("admits listed CIDRs and suffixes", () => {
		expect(isAllowedPrivate("192.168.1.4", allow)).toBe(true)
		expect(isAllowedPrivate("10.1.2.200", allow)).toBe(true)
		expect(isAllowedPrivate("gev.k3s.home", allow)).toBe(true)
		expect(isAllowedPrivate("home", allow)).toBe(true)
		expect(isAllowedPrivate("monitoring.home.", allow)).toBe(true)
	})

	it("refuses everything else", () => {
		expect(isAllowedPrivate("10.1.3.1", allow)).toBe(false)
		expect(isAllowedPrivate("172.16.0.1", allow)).toBe(false)
		expect(isAllowedPrivate("myhome", allow)).toBe(false)
		expect(isAllowedPrivate("kubernetes.svc", allow)).toBe(false)
	})

	it("never admits loopback or metadata, even when listed", () => {
		const wide = parsePrivateAllowlist("0.0.0.0/8,127.0.0.0/8,169.254.0.0/16,localhost")
		expect(isAllowedPrivate("127.0.0.1", wide)).toBe(false)
		expect(isAllowedPrivate("169.254.169.254", wide)).toBe(false)
		expect(isAllowedPrivate("0.0.0.0", wide)).toBe(false)
		expect(isAllowedPrivate("localhost", wide)).toBe(false)
	})

	it("ignores malformed and over-wide entries", () => {
		const bad = parsePrivateAllowlist("0.0.0.0/0,192.168.0.0/33,not a host,,")
		expect(bad.cidrs).toHaveLength(0)
		expect(bad.suffixes).toHaveLength(0)
	})

	it("is empty by default (upstream behaviour)", () => {
		expect(isAllowedPrivate("192.168.1.4")).toBe(false)
	})
})
