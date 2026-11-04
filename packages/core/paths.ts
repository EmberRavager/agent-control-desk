import { homedir, platform } from "node:os";
import { join } from "node:path";
export function dataDirectory(): string {
  return (
    process.env.ACD_DATA_DIR ||
    join(
      platform() === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : platform() === "win32"
          ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
          : join(homedir(), ".local", "share"),
      "agent-control-desk",
    )
  );
}
