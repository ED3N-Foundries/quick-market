import { expect, test } from "bun:test"
import { planTokenLines } from "./token"

test("token deploy lines do not replace the Base treasury key", () => {
  const source = `TREASURY_PRIVATE_KEY=0x${"ab".repeat(32)}\nTOKEN_ACCOUNT=\nTOKEN_PRIVATE_KEY=\n`
  const next = planTokenLines(source, "qm.testnet", "ed25519:secret")
  expect(next).toContain(`TREASURY_PRIVATE_KEY=0x${"ab".repeat(32)}`)
  expect(next).toContain("TOKEN_ACCOUNT=qm.testnet")
  expect(next).toContain("TOKEN_PRIVATE_KEY=ed25519:secret")
  expect(next).not.toContain("NEAR_TREASURY_PRIVATE_KEY=")
  expect(next.match(/TREASURY_PRIVATE_KEY=/g)).toHaveLength(1)
})
