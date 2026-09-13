export class ConfigParseError extends Error {
  readonly name = "ConfigParseError"

  constructor(
    readonly path: string,
    readonly format: string,
    cause?: unknown,
  ) {
    super(`Cannot safely update ${path}: invalid ${format}`, { cause })
  }
}

export class ConfigShapeError extends Error {
  readonly name = "ConfigShapeError"

  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Cannot safely update ${path}: ${detail}`)
  }
}

export class EngineNotFoundError extends Error {
  readonly name = "EngineNotFoundError"

  constructor(readonly command: string) {
    super(
      `MCP engine '${command}' was not found. Run 'skald setup' to install the official engine, or pass --mcp-command <path> for a custom engine.`,
    )
  }
}

export class EngineIntegrityError extends Error {
  readonly name = "EngineIntegrityError"

  constructor(
    readonly command: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `MCP engine '${command}' changed after it was trusted (expected ${expected}, found ${actual})`,
    )
  }
}
