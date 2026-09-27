import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyAfshinSourceArchive } from "../scripts/extract-afsin-source"

setDefaultTimeout(60_000)

test("verifies the co-located Afşin source archive against its pinned provenance", async () => {
  const result = await verifyAfshinSourceArchive()

  expect(result.commit).toBe("cf1d310a72320ec55e7b86a091561162567e55d2")
  expect(result.bytes).toBe(90_780_526)
  expect(result.sha256).toBe("13b0f8059b5a55a57ff35b120782d78756df1c8c9574b90a490bd92683002467")
})

test("rejects an Afşin source archive with a mismatched digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skald-afsin-source-invalid-"))
  const archive = join(directory, "afsin-cf1d310a72320ec55e7b86a091561162567e55d2.tar.gz")

  try {
    await writeFile(archive, "")
    await truncate(archive, 90_780_526)
    await expect(verifyAfshinSourceArchive(archive)).rejects.toThrow("SHA-256 mismatch")
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
