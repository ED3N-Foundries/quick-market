import { expect, test } from "bun:test"
import { BRIEF_KEY, BRIEF_MS, briefDue, readBriefAt, writeBriefAt, type BriefStore } from "./testnetBrief"

function memory(): BriefStore {
  const bag = new Map<string, string>()
  return {
    getItem: (key) => bag.get(key) ?? null,
    setItem: (key, value) => {
      bag.set(key, value)
    },
  }
}

const now = 1_800_000_000_000
const hour = 60 * 60 * 1000

test("a missing stamp is due", () => {
  expect(briefDue(null, now)).toBe(true)
  expect(briefDue(Number.NaN, now)).toBe(true)
  expect(readBriefAt(memory())).toBeNull()
})

test("23 hours is quiet and 24 hours is due", () => {
  expect(briefDue(now - 23 * hour, now)).toBe(false)
  expect(briefDue(now - BRIEF_MS + 1, now)).toBe(false)
  expect(briefDue(now - BRIEF_MS, now)).toBe(true)
  expect(briefDue(now - BRIEF_MS - 1, now)).toBe(true)
})

test("garbage is treated as missing", () => {
  const source = memory()
  source.setItem(BRIEF_KEY, "nope")
  expect(readBriefAt(source)).toBeNull()
  expect(briefDue(readBriefAt(source), now)).toBe(true)
  source.setItem(BRIEF_KEY, "1.5")
  expect(readBriefAt(source)).toBeNull()
  source.setItem(BRIEF_KEY, "")
  expect(readBriefAt(source)).toBeNull()
})

test("a dismiss is read back and stays quiet for a day", () => {
  const source = memory()
  writeBriefAt(now, source)
  expect(readBriefAt(source)).toBe(now)
  expect(source.getItem(BRIEF_KEY)).toBe(String(now))
  expect(briefDue(readBriefAt(source), now + 23 * hour)).toBe(false)
  expect(briefDue(readBriefAt(source), now + BRIEF_MS)).toBe(true)
  writeBriefAt(1.5, source)
  expect(readBriefAt(source)).toBe(now)
})

test("a store that throws does not throw", () => {
  const broken: BriefStore = {
    getItem() {
      throw new Error("denied")
    },
    setItem() {
      throw new Error("denied")
    },
  }
  expect(readBriefAt(broken)).toBeNull()
  expect(briefDue(readBriefAt(broken), now)).toBe(true)
  expect(() => writeBriefAt(now, broken)).not.toThrow()
})
