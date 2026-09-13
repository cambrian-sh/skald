import { expect, test } from "bun:test"
import { parseCommand } from "../src/cli/command"

test("parses the one-command initialization and context workflow", () => {
  expect(parseCommand(["--version"])).toEqual({ kind: "version" })
  expect(parseCommand(["backend", "--root", "/tmp/project"])).toEqual({
    kind: "backend",
    root: "/tmp/project",
  })
  expect(parseCommand(["init", "--help"])).toEqual({ kind: "help" })
  expect(parseCommand(["engine", "index", "--help"])).toEqual({ kind: "help" })
  expect(parseCommand(["init", "--no-index", "--index-mode", "full"])).toMatchObject({
    kind: "init",
    index: false,
    indexMode: "full",
  })
  expect(
    parseCommand(["setup", "--engine-package", "codebase-memory-mcp@0.10.8", "--no-index"]),
  ).toMatchObject({
    kind: "setup",
    enginePackage: "codebase-memory-mcp@0.10.8",
    index: false,
  })
  expect(
    parseCommand(["setup", "--knowledge-dir", "/tmp/cambrian-knowledge", "--no-index"]),
  ).toMatchObject({
    kind: "setup",
    knowledgeDirectory: "/tmp/cambrian-knowledge",
    index: false,
  })
  expect(parseCommand(["engine", "install", "--package", "codebase-memory-mcp@0.10.8"])).toEqual({
    kind: "engine-install",
    root: undefined,
    json: false,
    packageSpec: "codebase-memory-mcp@0.10.8",
    upgrade: false,
  })
  expect(parseCommand(["engine", "install", "--root", "/tmp/project"])).toMatchObject({
    kind: "engine-install",
    root: "/tmp/project",
  })
  expect(parseCommand(["engine", "locate", "--mode", "full"])).toMatchObject({
    kind: "error",
  })
  expect(parseCommand(["engine", "serve", "--upgrade"])).toMatchObject({ kind: "error" })
  expect(
    parseCommand(["engine", "conformance", "--root", "/tmp/project", "--smoke"]),
  ).toMatchObject({
    kind: "engine-conformance",
    root: "/tmp/project",
    smoke: true,
  })
  expect(parseCommand(["agents", "list", "--json"])).toEqual({
    kind: "agents-list",
    json: true,
  })
  expect(parseCommand(["doctor", "--json"])).toEqual({
    kind: "doctor",
    root: undefined,
    json: true,
  })
  expect(parseCommand(["context", "--query", "architecture", "--root", "/tmp/project"])).toEqual({
    kind: "context",
    root: "/tmp/project",
    json: false,
    query: "architecture",
  })
  expect(parseCommand(["context", "--path", "src/context", "--max-chars", "12000"])).toMatchObject({
    kind: "context",
    path: "src/context",
    maxChars: 12000,
  })
  expect(
    parseCommand([
      "memory",
      "record",
      "decision",
      "--title",
      "Use MCP",
      "--summary",
      "Keep the backend replaceable",
      "--source",
      "README.md",
    ]),
  ).toEqual({
    kind: "memory-record",
    root: undefined,
    json: false,
    recordKind: "decision",
    title: "Use MCP",
    summary: "Keep the backend replaceable",
    sourceRefs: ["README.md"],
  })

  expect(
    parseCommand(["memory", "record", "contract", "--title", "API", "--summary", "Stable"]),
  ).toMatchObject({ recordKind: "contract" })
  expect(parseCommand(["memory", "review", "--json"])).toEqual({
    kind: "memory-review",
    root: undefined,
    json: true,
  })
  expect(parseCommand(["memory", "promote", "decisions/example.md"])).toEqual({
    kind: "memory-promote",
    root: undefined,
    json: false,
    recordPath: "decisions/example.md",
  })
  expect(
    parseCommand([
      "knowledge",
      "index",
      "--root",
      "/tmp/project",
      "--knowledge-dir",
      "/tmp/knowledge",
      "--repo",
      "core=/tmp/core",
      "--mode",
      "full",
      "--write",
    ]),
  ).toEqual({
    kind: "knowledge-index",
    root: "/tmp/project",
    knowledgeDirectory: "/tmp/knowledge",
    repositories: [{ origin: "core", path: "/tmp/core" }],
    mode: "full",
    write: true,
    json: false,
  })
})
