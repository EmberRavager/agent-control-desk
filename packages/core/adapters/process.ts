import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { join } from "node:path";

export function launch(
  executable: string,
  args: string[],
  cwd: string,
): ChildProcessWithoutNullStreams {
  if (/\.(cmd|bat)$/i.test(executable))
    throw new Error(
      "Windows shell wrappers are not supported yet; select a native executable.",
    );
  return spawn(executable, args, {
    cwd,
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Terminate our own process group/tree; never interpolate user text into a shell. */
export async function terminate(
  proc: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32") {
    const tool = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "taskkill.exe",
    );
    await new Promise<void>((resolve, reject) =>
      execFile(
        tool,
        ["/PID", String(proc.pid), "/T"],
        { windowsHide: true },
        (error) =>
          error
            ? reject(
                new Error(
                  "Windows could not confirm process-tree termination.",
                ),
              )
            : resolve(),
      ),
    );
    return;
  }
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
