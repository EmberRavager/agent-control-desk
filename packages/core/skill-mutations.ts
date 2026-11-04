import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from "node:path";
import { stringify } from "yaml";
import type {
  CreateSkillInput,
  SkillRecord,
  SkillSource,
  SkillTrashEntry,
} from "../contracts/index.js";
import { readSkill } from "./skills.js";

const TRASH = ".acd-skill-trash";
const trashBase = (root: string) => join(dirname(root), TRASH);
const trashIndex = (root: string) =>
  join(
    trashBase(root),
    createHash("sha256").update(root).digest("hex").slice(0, 24),
  );
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const locks = new Map<string, Promise<void>>();
const inside = (root: string, path: string) => {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
const osAlias = (path: string) =>
  process.platform === "darwin"
    ? path
        .replace(/^\/var(?=\/|$)/, "/private/var")
        .replace(/^\/tmp(?=\/|$)/, "/private/tmp")
    : path;
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
async function locked<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => (release = r));
  locks.set(path, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (locks.get(path) === current) locks.delete(path);
  }
}

/** Do not grant write authority to a root redirected through an unrelated symlink. */
async function checkAncestors(path: string, roots: SkillSource[]) {
  const allowed = roots.map((r) => osAlias(resolve(r.rootPath)));
  const absolute = resolve(path),
    base = parse(absolute).root;
  let cursor = base;
  for (const part of absolute
    .slice(base.length)
    .split(/[\\/]/)
    .filter(Boolean)) {
    cursor = join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
      throw e;
    }
    if (!info.isSymbolicLink()) continue;
    const actual = await realpath(cursor);
    const systemAlias =
      process.platform === "darwin" &&
      ((cursor === "/tmp" && actual === "/private/tmp") ||
        (cursor === "/var" && actual === "/private/var"));
    if (!systemAlias && !allowed.some((root) => inside(root, actual)))
      throw Error("技能目录包含越界链接，未修改文件");
  }
}
async function canonicalRoot(
  requested: string,
  roots: SkillSource[],
  create = false,
): Promise<string> {
  const declared = roots.find(
    (r) => resolve(r.rootPath) === resolve(requested),
  );
  if (!declared) throw Error("只能修改当前技能目录中的文件");
  await checkAncestors(declared.rootPath, roots);
  if (create) await mkdir(declared.rootPath, { recursive: true, mode: 0o700 });
  const root = await realpath(declared.rootPath);
  if (dirname(root) === root) throw Error("不能将文件系统根目录用作技能目录");
  if (!(await lstat(root)).isDirectory()) throw Error("技能根路径不是目录");
  await checkAncestors(declared.rootPath, roots);
  return root;
}
async function availableRoots(roots: SkillSource[]): Promise<string[]> {
  const found: string[] = [];
  for (const source of roots)
    try {
      const root = await canonicalRoot(source.rootPath, roots);
      if (!found.includes(root)) found.push(root);
    } catch {
      /* Missing or unsafe roots are never writable. */
    }
  return found;
}
async function durableJson(path: string, value: unknown) {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
}
async function trashDirectory(root: string) {
  for (const target of [trashBase(root), trashIndex(root)]) {
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const info = await lstat(target);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(target)) !== target
    )
      throw Error("技能回收区路径无效，未修改文件");
  }
  return trashIndex(root);
}

export async function createSkill(
  input: CreateSkillInput,
  roots: SkillSource[],
): Promise<void> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name) || input.name.length > 64)
    throw Error("名称须为 1–64 位小写字母、数字和单连字符");
  const description = input.description.trim();
  if (!description || description.length > 1024)
    throw Error("用途说明须为 1–1024 个字符");
  if (
    !input.content.trim() ||
    Buffer.byteLength(input.content, "utf8") > 48 * 1024
  )
    throw Error("技能内容不能为空，且不能超过 48 KiB");
  const root = await canonicalRoot(input.rootPath, roots, true),
    target = join(root, input.name);
  await locked(target, async () => {
    await checkAncestors(root, roots);
    if (await exists(target)) throw Error("同名目录已存在，不会覆盖原文件");
    await mkdir(target, { mode: 0o700 });
    let file;
    try {
      file = await open(
        join(target, "SKILL.md"),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW || 0),
        0o600,
      );
      await file.writeFile(
        "---\n" +
          stringify({ name: input.name, description }) +
          "---\n\n" +
          input.content.trim() +
          "\n",
      );
      await file.sync();
    } catch (e) {
      if (file) {
        await file.close();
        file = undefined;
        await unlink(join(target, "SKILL.md")).catch(() => {});
      }
      await rmdir(target).catch(() => {});
      throw e;
    } finally {
      await file?.close();
    }
  });
}

export async function trashSkill(
  record: SkillRecord,
  roots: SkillSource[],
  allSkills: SkillRecord[],
): Promise<SkillTrashEntry> {
  await readSkill(record, roots);
  const original = await realpath(record.directory);
  if (dirname(record.path) !== original)
    throw Error("技能目录已变更，请重新扫描");
  const root = (await availableRoots(roots))
    .filter((root) => inside(root, original))
    .sort((a, b) => b.length - a.length)[0];
  if (
    !root ||
    original === root ||
    relative(root, original)
      .split(/[\\/]/)
      .some((p) => p === TRASH || p === ".acd-trash")
  )
    throw Error("不能删除技能根目录或回收区");
  if (
    allSkills.some((s) => s.id !== record.id && inside(original, s.directory))
  )
    throw Error("该目录包含其他技能，请分别处理");
  return locked(original, async () => {
    await readSkill(record, roots);
    await checkAncestors(original, roots);
    const id = randomUUID(),
      parent = await trashDirectory(root),
      bucket = join(parent, id);
    await mkdir(bucket, { mode: 0o700 });
    const entry: SkillTrashEntry = {
      id,
      name: record.name,
      rootPath: root,
      originalDirectory: original,
      createdAt: new Date().toISOString(),
    };
    await durableJson(join(bucket, "entry.json"), entry);
    // Same root means the normal case is a same-filesystem atomic move; EXDEV fails safely.
    await rename(original, join(bucket, "skill"));
    return entry;
  });
}

async function loadEntry(
  root: string,
  id: string,
): Promise<SkillTrashEntry | null> {
  if (!UUID.test(id)) return null;
  const parent = trashIndex(root),
    bucket = join(parent, id);
  try {
    for (const path of [trashBase(root), parent, bucket]) {
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(path)) !== path
      )
        return null;
    }
    const file = await open(
      join(bucket, "entry.json"),
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    let entry: SkillTrashEntry;
    try {
      if ((await file.stat()).size > 16 * 1024) return null;
      entry = JSON.parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
    if (
      entry.id !== id ||
      entry.rootPath !== root ||
      typeof entry.name !== "string" ||
      entry.name.length > 200 ||
      typeof entry.createdAt !== "string" ||
      typeof entry.originalDirectory !== "string" ||
      !isAbsolute(entry.originalDirectory) ||
      resolve(entry.originalDirectory) !== entry.originalDirectory ||
      entry.originalDirectory === root ||
      !inside(root, entry.originalDirectory) ||
      relative(root, entry.originalDirectory)
        .split(/[\\/]/)
        .some(
          (p) =>
            p === TRASH || p === ".acd-trash" || p.startsWith(".acd-create-"),
        )
    )
      return null;
    const skill = join(bucket, "skill"),
      info = await lstat(skill);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(skill)) !== skill
    )
      return null;
    const definition = join(skill, "SKILL.md"),
      definitionInfo = await lstat(definition);
    if (!definitionInfo.isFile() || definitionInfo.isSymbolicLink())
      return null;
    return entry;
  } catch {
    return null;
  }
}
export async function listSkillTrash(
  roots: SkillSource[],
): Promise<SkillTrashEntry[]> {
  const entries: SkillTrashEntry[] = [];
  for (const root of await availableRoots(roots)) {
    const parent = trashIndex(root);
    try {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const children = await readdir(parent);
      for (const id of children.slice(0, 1000)) {
        const entry = await loadEntry(root, id);
        if (entry) entries.push(entry);
      }
    } catch {
      /* No trash is a normal empty state. */
    }
  }
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function restoreSkill(
  id: string,
  roots: SkillSource[],
): Promise<void> {
  if (!UUID.test(id)) throw Error("无效回收记录");
  const entry = (await listSkillTrash(roots)).find((e) => e.id === id);
  if (!entry) throw Error("回收记录不存在或已恢复");
  await locked(entry.originalDirectory, async () => {
    const checked = await loadEntry(entry.rootPath, id);
    if (!checked) throw Error("回收记录已变更");
    await checkAncestors(dirname(entry.originalDirectory), roots);
    const parent = await realpath(dirname(entry.originalDirectory));
    if (!inside(entry.rootPath, parent))
      throw Error("原目录超出技能范围，未恢复");
    if (await exists(entry.originalDirectory))
      throw Error("原位置已存在文件或目录，不能覆盖恢复");
    const bucket = join(trashIndex(entry.rootPath), id);
    await rename(join(bucket, "skill"), entry.originalDirectory);
    // Only application-owned metadata and an empty bucket are removed, never user assets.
    await unlink(join(bucket, "entry.json"));
    await rmdir(bucket);
  });
}
