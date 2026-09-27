import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readManagedFile, UnsafePathError, writeManagedFile } from "../src/fs/safe-file"

test("reads and writes managed files without following a leaf symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "skald-safe-file-"))
  const project = join(root, "project")
  const outsideFile = join(root, "outside.txt")
  await mkdir(project)
  await writeFile(outsideFile, "outside")
  await symlink(outsideFile, join(project, "linked.txt"))

  try {
    expect(await writeManagedFile(project, "nested/context.md", "project context")).toBe("created")
    expect(await readManagedFile(project, "nested/context.md")).toMatchObject({
      relativePath: "nested/context.md",
      exists: true,
      contents: "project context",
    })

    let failure: unknown
    try {
      await readManagedFile(project, "linked.txt")
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(UnsafePathError)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
