const { Arch } = require("electron-builder");

/** Native prebuilds must match the app target; a host-only node_modules is insufficient. */
function checkTarget({ electronPlatformName, arch }) {
  const targetArch = Arch[arch];
  if (electronPlatformName !== process.platform || targetArch !== process.arch)
    throw Error(
      "请在目标系统及对应架构上运行 npm ci 后构建，避免打包错误的原生凭证模块。",
    );
  const suffix =
    electronPlatformName === "win32"
      ? `win32-${targetArch}-msvc`
      : electronPlatformName === "darwin"
        ? `darwin-${targetArch}`
        : null;
  if (!suffix) throw Error("当前桌面安装包只配置了 macOS 和 Windows。");
  require.resolve(`@napi-rs/keyring-${suffix}`);
}
module.exports = { checkTarget };
