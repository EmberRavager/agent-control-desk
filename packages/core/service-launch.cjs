const path = require("node:path");
const { pathToFileURL } = require("node:url");

/** Choose a real host directory; an ASAR archive cannot be a child cwd. */
function serviceLaunch({
  root,
  executable,
  compiled = false,
  packaged = false,
}) {
  const runtimeRoot = packaged
    ? root.replace(/\.asar$/, ".asar.unpacked")
    : root;
  const args =
    compiled || packaged
      ? [path.join(runtimeRoot, "dist/runtime/server.mjs")]
      : [
          "--import",
          pathToFileURL(require.resolve("tsx", { paths: [root] })).href,
          path.join(root, "packages/core/server.ts"),
        ];
  return {
    args,
    cwd: packaged ? path.dirname(executable) : runtimeRoot,
  };
}
module.exports = { serviceLaunch };
