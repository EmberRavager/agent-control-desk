const { checkTarget } = require("./scripts/check-package-target.cjs");

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "io.github.emberravager.agentcontroldesk",
  productName: "Agent Control Desk",
  directories: { output: "release" },
  extraMetadata: { main: "apps/desktop/main.cjs" },
  files: [
    "apps/desktop/*.cjs",
    "!apps/desktop/*.test.cjs",
    "apps/desktop/assets/**",
    "dist/renderer/**",
    "dist/runtime/**",
    "packages/core/service-launch.cjs",
    "!**/*.map",
    "!**/{test,tests,__tests__}{,/**}",
  ],
  asar: true,
  // The independent Node host uses real ESM files and native modules.
  asarUnpack: ["dist/runtime/**", "node_modules/**"],
  allowMissingDependencies: false,
  npmRebuild: false, // @napi-rs/keyring ships prebuilt N-API binaries.
  publish: null,
  beforePack: checkTarget,
  mac: {
    target: ["dmg", "zip"],
    category: "public.app-category.developer-tools",
    icon: "dist/app-icon.png",
  },
  win: { target: ["nsis"], icon: "dist/app-icon.png" },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
  artifactName: "Agent-Control-Desk-${version}-${os}-${arch}.${ext}",
};
