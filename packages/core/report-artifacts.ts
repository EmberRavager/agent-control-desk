import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface ReportArtifact {
  path: string;
  status: "present" | "absent";
  bytes?: number;
}

const supported =
  /\.(?:txt|md|markdown|rst|log|csv|tsv|json|ya?ml|xml|html?|pdf|docx?|xlsx?|pptx?|png|jpe?g|webp|gif|svg|bmp|tiff?|avif|zip|tar|tar\.gz|tgz|gz|7z|rar)$/i;
const sensitive =
  /(?:credential|password|passwd|secret|token|private[ _-]?key|api[ _-]?key|access[ _-]?key|keyring|keychain|service[ _-]?account|cookie|(?:^|[ ./_-])(?:auth|oauth|keys?|id_rsa|id_ed25519|secrets?)(?:[ ./_-]|$)|密码|口令|私钥|密钥|凭证|令牌)/i;

function referencedPaths(text: string) {
  const paths = new Set<string>();
  // A quoted reference can contain spaces. Keep unquoted tokens whole so a
  // basename within a URL, absolute path or glob never becomes a local probe.
  const mentions =
    /`([^`\r\n]+)`|[^\s`"'“”‘’「」《》，。；！？、：,;!?()[\]{}<>]+/gu;
  const localText = text.replace(
    /\[[^\]\n]*\]\((?:https?|file):\/\/[^)\s]+\)|(?:https?|file):\/\/[^\s`，。；]+/gi,
    " ",
  );
  for (const match of localText.matchAll(mentions)) {
    const raw: string =
      match[1] ??
      match[0]
        .replace(/\.$/, "")
        .replace(
          /^(?:请(?:帮我)?|已经|已)(?:创建|生成|导出|提供|保存为|交付|输出|写入)/,
          "",
        );
    if (
      /^(?:cat|touch|ls|mv|cp|rm|mkdir|open|git|node|npm|python3?|bash|sh|cd)\s/i.test(
        raw,
      )
    )
      continue;
    const path = raw.replaceAll("\\", "/").replace(/^\.\//, "");
    if (path.length > 500 || !supported.test(path) || sensitive.test(path))
      continue;
    const components = path.split("/");
    if (
      components.length > 20 ||
      components.some(
        (part) =>
          !part ||
          part.length > 255 ||
          part.startsWith(".") ||
          !/^[\p{L}\p{M}\p{N} _().+-]+$/u.test(part),
      )
    )
      continue;
    paths.add(path);
  }
  return paths;
}

function inspectPath(cwd: string, path: string): ReportArtifact | undefined {
  let parent = cwd;
  const parts = path.split("/");
  try {
    for (const [index, part] of parts.entries()) {
      parent = join(parent, part);
      // Walk one component at a time. Even a dangling symlink is unknown.
      const stat = lstatSync(parent);
      if (index === parts.length - 1) {
        if (stat.isFile()) return { path, status: "present", bytes: stat.size };
      } else if (!stat.isDirectory()) return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path, status: "absent" };
  }
}

export function inspectReportArtifacts(
  cwd: string,
  requirements: readonly string[],
  finalText: string,
): ReportArtifact[] {
  if (!isAbsolute(cwd)) return [];
  try {
    if (!lstatSync(cwd).isDirectory()) return [];
  } catch {
    return [];
  }
  const referenced = referencedPaths(finalText);
  const candidates = [...referencedPaths(requirements.join("\n"))].filter(
    (path) => referenced.has(path),
  );
  return candidates.slice(0, 4).flatMap((path) => inspectPath(cwd, path) ?? []);
}
