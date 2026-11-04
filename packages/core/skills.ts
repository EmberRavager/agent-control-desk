import { constants } from "node:fs";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import type {
  SkillSource,
  SkillRecord,
  SkillCatalog,
  SkillDetail,
  AgentKind,
} from "../contracts/index.js";

const MAX_DEPTH = 6;
const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_PREVIEW_BYTES = 256 * 1024;
const inside = (root: string, path: string) => {
  const tail = relative(root, path);
  return tail === "" || (!tail.startsWith("..") && !isAbsolute(tail));
};

/** These are discovery associations, not confirmation that an Agent loaded a skill. */
export function skillRoots(
  home = homedir(),
  projectPath?: string,
): SkillSource[] {
  const source = (
    rootPath: string,
    agents: AgentKind[],
    label: string,
    scope: SkillSource["scope"] = "global",
  ): SkillSource => ({ rootPath: resolve(rootPath), agents, label, scope });
  const roots: SkillSource[] = [
    source(
      join(home, ".agents", "skills"),
      ["codex", "claude", "opencode"],
      "共享技能目录 · 加载未验证",
    ),
    source(join(home, ".codex", "skills"), ["codex"], "Codex 本地技能目录"),
    source(
      join(home, ".claude", "skills"),
      ["claude", "opencode"],
      "Claude 兼容技能目录",
    ),
    source(
      join(home, ".config", "opencode", "skills"),
      ["opencode"],
      "OpenCode 技能目录",
    ),
    source(join(home, ".pi", "agent", "skills"), ["pi"], "Pi 技能候选目录"),
    source(join(home, ".hermes", "skills"), ["hermes"], "Hermes 技能候选目录"),
    source(
      join(home, ".openclaw", "workspace", "skills"),
      ["openclaw"],
      "OpenClaw 工作区技能候选目录",
    ),
    source(
      join(home, ".dsh", "skills"),
      ["deepseek-harness"],
      "DeepSeek Harness 技能候选目录",
    ),
  ];
  if (projectPath) {
    roots.push(
      source(
        join(projectPath, ".agents", "skills"),
        ["codex", "claude", "opencode"],
        "项目共享技能目录 · 加载未验证",
        "project",
      ),
      source(
        join(projectPath, ".codex", "skills"),
        ["codex"],
        "项目 Codex 技能候选目录",
        "project",
      ),
      source(
        join(projectPath, ".claude", "skills"),
        ["claude", "opencode"],
        "项目 Claude 兼容技能目录",
        "project",
      ),
      source(
        join(projectPath, ".opencode", "skills"),
        ["opencode"],
        "项目 OpenCode 技能目录",
        "project",
      ),
    );
  }
  return roots;
}

async function permittedRoots(roots: SkillSource[]): Promise<string[]> {
  const paths: string[] = [];
  const declared: string[] = [];
  // Normalize OS path aliases without granting authority to an arbitrary root symlink target.
  for (const source of roots) {
    try {
      declared.push(
        join(
          await realpath(dirname(source.rootPath)),
          basename(source.rootPath),
        ),
      );
    } catch {
      /* Missing parent means there is no root to traverse. */
    }
  }
  for (const source of roots) {
    try {
      const path = await realpath(source.rootPath);
      if (!(await stat(path)).isDirectory()) continue;
      if (!declared.some((root) => inside(root, path))) continue;
      if (dirname(path) === path || path === (await realpath(homedir())))
        continue;
      paths.push(path);
    } catch {
      /* Nonexistent default directories are normal. */
    }
  }
  return [...new Set(paths)];
}

async function readBounded(
  path: string,
  maximum: number,
): Promise<{ content: string; size: number }> {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const info = await file.stat();
    if (!info.isFile()) throw Error("技能路径不是普通文件");
    if (info.size > MAX_FILE_BYTES)
      throw Error("技能文件超过 2 MiB，未读取内容");
    const bytes = Buffer.alloc(Math.min(info.size, maximum));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return {
      content: bytes.subarray(0, offset).toString("utf8"),
      size: info.size,
    };
  } finally {
    await file.close();
  }
}

function metadata(
  path: string,
  content: string,
): Pick<SkillRecord, "name" | "description" | "valid" | "warnings"> {
  const fallback = basename(dirname(path));
  const match = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|\s*$)/.exec(
    content,
  );
  const warnings: string[] = [];
  if (!match)
    return {
      name: fallback,
      description: "",
      valid: false,
      warnings: ["缺少完整 YAML frontmatter，未识别为有效 Skill"],
    };
  let value: unknown;
  try {
    const document = parseDocument(match[1], { uniqueKeys: true });
    if (document.errors.length) throw Error("invalid");
    value = document.toJS({ maxAliasCount: 20 });
  } catch {
    return {
      name: fallback,
      description: "",
      valid: false,
      warnings: ["YAML 元信息格式无效"],
    };
  }
  const fields =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  const description =
    typeof fields.description === "string" ? fields.description.trim() : "";
  if (!name || name.length > 64) warnings.push("name 缺失或超过 64 字符");
  if (!description || description.length > 1024)
    warnings.push("description 缺失或超过 1024 字符");
  // Variants used by existing tools are still useful to inventory, but flagged rather than hidden.
  if (name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    warnings.push("名称不符合标准的小写连字符格式");
  return {
    name: (name || fallback).slice(0, 200),
    description: description.slice(0, 2048),
    valid: warnings.length === 0,
    warnings,
  };
}

export async function scanSkills(
  options: { home?: string; projectPath?: string; roots?: SkillSource[] } = {},
): Promise<SkillCatalog> {
  const roots = options.roots ?? skillRoots(options.home, options.projectPath);
  const allowed = await permittedRoots(roots);
  const skills = new Map<string, SkillRecord>();
  const warnings: string[] = [];
  let entries = 0;
  const contains = (path: string) => allowed.some((root) => inside(root, path));
  for (const source of roots) {
    const visited = new Set<string>();
    const walk = async (candidate: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || entries >= MAX_ENTRIES) return;
      let path: string;
      try {
        path = await realpath(candidate);
      } catch {
        return;
      }
      if (!contains(path)) {
        warnings.push(`已跳过技能目录之外的链接：${candidate}`);
        return;
      }
      try {
        const info = await stat(path);
        if (!info.isDirectory() || visited.has(path)) return;
        visited.add(path);
        const children = await readdir(path, { withFileTypes: true });
        for (const child of children) {
          if (++entries > MAX_ENTRIES) break;
          if (
            child.name === ".acd-trash" ||
            child.name === ".acd-skill-trash" ||
            child.name.startsWith(".acd-create-")
          )
            continue;
          const childPath = join(path, child.name);
          if (child.name === "SKILL.md") {
            let actual: string;
            try {
              actual = await realpath(childPath);
            } catch {
              continue;
            }
            if (basename(actual) !== "SKILL.md" || !contains(actual)) {
              warnings.push(`已跳过技能目录之外的文件链接：${childPath}`);
              continue;
            }
            const existing = skills.get(actual);
            if (existing) {
              if (
                !existing.sources.some(
                  (s) =>
                    s.rootPath === source.rootPath && s.scope === source.scope,
                )
              )
                existing.sources.push(source);
              continue;
            }
            let parsed: ReturnType<typeof metadata>;
            try {
              parsed = metadata(
                actual,
                (await readBounded(actual, MAX_METADATA_BYTES)).content,
              );
            } catch (error) {
              parsed = {
                name: basename(dirname(actual)),
                description: "",
                valid: false,
                warnings: [
                  error instanceof Error ? error.message : "技能文件无法读取",
                ],
              };
            }
            skills.set(actual, {
              id: createHash("sha256")
                .update(actual)
                .digest("hex")
                .slice(0, 24),
              path: actual,
              directory: dirname(actual),
              ...parsed,
              sources: [source],
            });
          } else if (child.isDirectory() || child.isSymbolicLink()) {
            // Skill support assets are not independent skill trees and may contain sensitive files.
            if (
              ![
                "scripts",
                "references",
                "assets",
                "node_modules",
                ".git",
              ].includes(child.name)
            )
              await walk(childPath, depth + 1);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          warnings.push(`技能目录无法读取：${source.rootPath}`);
      }
    };
    try {
      await access(source.rootPath);
      await walk(source.rootPath, 0);
    } catch {
      /* Missing standard directories are not actionable warnings. */
    }
  }
  if (entries >= MAX_ENTRIES)
    warnings.push("扫描已达到 10000 项上限，请缩小技能目录范围");
  const byName = new Map<string, SkillRecord[]>();
  for (const record of skills.values())
    byName.set(record.name, [...(byName.get(record.name) || []), record]);
  for (const same of byName.values())
    if (same.length > 1)
      for (const record of same)
        record.warnings.push("存在同名但不同路径的 Skill，请核对来源与版本");
  return {
    skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
    roots,
    warnings: [...new Set(warnings)],
    scannedAt: new Date().toISOString(),
    ...(options.projectPath
      ? { projectPath: resolve(options.projectPath) }
      : {}),
  };
}

/** Preview only an indexed record, with the same bounded roots checked again. */
export async function readSkill(
  record: SkillRecord,
  roots: SkillSource[],
): Promise<SkillDetail> {
  if (basename(record.path) !== "SKILL.md") throw Error("无效技能文件");
  const actual = await realpath(record.path);
  if (
    actual !== record.path ||
    !(await permittedRoots(roots)).some((root) => inside(root, actual))
  )
    throw Error("技能路径已变更或超出扫描范围，请重新扫描");
  const { content, size } = await readBounded(actual, MAX_PREVIEW_BYTES);
  return { skill: record, content, truncated: size > MAX_PREVIEW_BYTES };
}
