console.error(
  "The source tree is not a publishable universal package. Run the release workflow and publish its root package plus platform companion archives.",
)
process.exitCode = 1
