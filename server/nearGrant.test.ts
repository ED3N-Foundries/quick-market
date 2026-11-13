import { expect, test } from "bun:test"
import { MINT_CONFIRMATIONS, MINT_RECEIPT_TIMEOUT_MS } from "../shared/mint"
import { nearExecutionFailed, nearGrantSeen, nearRpcBusy, nextNearGrantWatch } from "./near"

const deadline = MINT_RECEIPT_TIMEOUT_MS
const executed = MINT_CONFIRMATIONS - 1

test("grant status maps inclusion, execution, finality, and failure", () => {
  expect(nearGrantSeen(null)).toEqual({ failed: false, seen: 1 })
  expect(nearGrantSeen({})).toEqual({ failed: false, seen: 1 })
  expect(nearGrantSeen({ final_execution_status: "INCLUDED" })).toEqual({ failed: false, seen: 1 })
  expect(nearGrantSeen({ final_execution_status: "EXECUTED_OPTIMISTIC" })).toEqual({ failed: false, seen: executed })
  expect(nearGrantSeen({ final_execution_status: "EXECUTED" })).toEqual({ failed: false, seen: executed })
  expect(nearGrantSeen({ final_execution_status: "FINAL" })).toEqual({ failed: false, seen: MINT_CONFIRMATIONS })
  expect(nearGrantSeen({ status: { Failure: { ActionError: "mint failed" } } })).toEqual({ failed: true, seen: 1 })
  expect(nearGrantSeen({ status: { SuccessValue: "" } })).toEqual({ failed: false, seen: executed })
  expect(nearGrantSeen({ status: "NotStarted" as unknown as { Failure?: unknown }, final_execution_status: "INCLUDED" })).toEqual({
    failed: false,
    seen: 1,
  })
  expect(nearGrantSeen({ status: "Started" as unknown as { Failure?: unknown } })).toEqual({ failed: false, seen: 1 })
})

test("an included NEAR reply is not an execution failure", () => {
  expect(nearExecutionFailed("NotStarted")).toEqual({ failed: false })
  expect(nearExecutionFailed("Started")).toEqual({ failed: false })
  expect(nearExecutionFailed(undefined)).toEqual({ failed: false })
  expect(nearExecutionFailed({ Failure: { ActionError: "mint failed" } })).toEqual({
    failed: true,
    reason: JSON.stringify({ ActionError: "mint failed" }),
  })
})

test("a grant finishes on final, credits execution at the deadline, and times out before execution", () => {
  expect(
    nextNearGrantWatch({ elapsedMs: 0, deadlineMs: deadline, seen: 1, status: { final_execution_status: "FINAL" } }),
  ).toEqual({ seen: MINT_CONFIRMATIONS, done: true, failed: false })
  expect(
    nextNearGrantWatch({ elapsedMs: 1_000, deadlineMs: deadline, seen: 1, status: { final_execution_status: "EXECUTED" } }),
  ).toEqual({ seen: executed, done: false, failed: false })
  expect(nextNearGrantWatch({ elapsedMs: deadline, deadlineMs: deadline, seen: executed, status: null })).toEqual({
    seen: MINT_CONFIRMATIONS,
    done: true,
    failed: false,
  })
  expect(nextNearGrantWatch({ elapsedMs: deadline, deadlineMs: deadline, seen: 1, status: null })).toEqual({
    seen: 1,
    done: false,
    failed: true,
  })
  expect(
    nextNearGrantWatch({
      elapsedMs: 0,
      deadlineMs: deadline,
      seen: 1,
      status: { status: { Failure: { ActionError: "mint failed" } } },
    }),
  ).toEqual({ seen: 1, done: false, failed: true })
})

test("a NEAR timeout is busy and an execution failure is not", () => {
  expect(nearRpcBusy({ message: "Server error", data: { name: "TIMEOUT_ERROR" } })).toBe(true)
  expect(nearRpcBusy(new Error("The operation timed out."))).toBe(true)
  expect(nearRpcBusy(new Error("Server error"))).toBe(true)
  expect(nearRpcBusy(new Error("NEAR RPC returned 429"))).toBe(true)
  expect(nearRpcBusy({ message: "Server error", data: { TxExecutionError: { InvalidTxError: "Expired" } } })).toBe(false)
  expect(nearRpcBusy(new Error(JSON.stringify({ ActionError: "mint failed" })))).toBe(false)
})
