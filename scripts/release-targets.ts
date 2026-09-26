export const SUPPORTED_TARGETS = [
  { platform: "linux", arch: "amd64", os: "linux", cpu: "x64" },
  { platform: "linux", arch: "arm64", os: "linux", cpu: "arm64" },
  { platform: "darwin", arch: "arm64", os: "darwin", cpu: "arm64" },
  { platform: "darwin", arch: "amd64", os: "darwin", cpu: "x64" },
] as const

export type SupportedTarget = (typeof SUPPORTED_TARGETS)[number]
