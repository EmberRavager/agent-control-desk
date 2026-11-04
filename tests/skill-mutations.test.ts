import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  realpath,
  readdir,
  rmdir,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  createSkill,
  trashSkill,
  listSkillTrash,
  restoreSkill,
} from "../packages/core/skill-mutations.js";
import { scanSkills } from "../packages/core/skills.js";
import type { SkillSource } from "../packages/contracts/index.js";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "acd-skill-write-"));
  const root = join(directory, "skills");
  const roots: SkillSource[] = [
    { rootPath: root, scope: "global", agents: ["codex"], label: "Fixture" },
  ];
  return { directory, root, roots };
}
const input = (rootPath: string, name = "fixture-skill") => ({
  rootPath,
  name,
  description: "Fixture use case",
  content: "# Fixture\n\nDo not execute any script.",
});

test("create writes standard metadata only in a declared root and never replaces a directory", async () => {
  const { directory, root, roots } = await setup();
  try {
    await createSkill(input(root), roots);
    const content = await readFile(
      join(root, "fixture-skill", "SKILL.md"),
      "utf8",
    );
    assert.match(content, /name: fixture-skill/);
    assert.match(content, /description: Fixture use case/);
    const catalog = await scanSkills({ roots });
    assert.equal(catalog.skills.length, 1);
    assert.equal(catalog.skills[0].valid, true);
    await assert.rejects(() => createSkill(input(root), roots), /已存在/);
    assert.equal(
      await readFile(join(root, "fixture-skill", "SKILL.md"), "utf8"),
      content,
    );
    await assert.rejects(
      () => createSkill(input(join(directory, "other")), roots),
      /只能修改/,
    );
    await assert.rejects(
      () => createSkill(input(root, "../escape"), roots),
      /名称/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent creates of the same name produce exactly one skill", async () => {
  const { directory, root, roots } = await setup();
  try {
    const result = await Promise.allSettled([
      createSkill(input(root), roots),
      createSkill(input(root), roots),
    ]);
    assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await scanSkills({ roots })).skills.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trash preserves the entire skill and supporting assets, hides it from scanning, then restores it", async () => {
  const { directory, root, roots } = await setup();
  try {
    await createSkill(input(root), roots);
    await mkdir(join(root, "fixture-skill", "scripts"));
    await writeFile(
      join(root, "fixture-skill", "scripts", "example.txt"),
      "fixture asset",
    );
    const before = await scanSkills({ roots });
    const record = before.skills[0];
    const entry = await trashSkill(record, roots, before.skills);
    assert.equal((await scanSkills({ roots })).skills.length, 0);
    const listing = await listSkillTrash(roots);
    assert.equal(listing.length, 1);
    assert.equal(listing[0].id, entry.id);
    assert.equal(
      await readFile(
        join(
          dirname(entry.rootPath),
          ".acd-skill-trash",
          createHash("sha256")
            .update(entry.rootPath)
            .digest("hex")
            .slice(0, 24),
          entry.id,
          "skill",
          "scripts",
          "example.txt",
        ),
        "utf8",
      ),
      "fixture asset",
    );
    await restoreSkill(entry.id, roots);
    assert.equal((await scanSkills({ roots })).skills.length, 1);
    assert.equal(
      await readFile(
        join(root, "fixture-skill", "scripts", "example.txt"),
        "utf8",
      ),
      "fixture asset",
    );
    assert.equal((await listSkillTrash(roots)).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore rejects even an empty replacement directory and can retry after it is removed", async () => {
  const { directory, root, roots } = await setup();
  try {
    await createSkill(input(root), roots);
    const catalog = await scanSkills({ roots });
    const entry = await trashSkill(catalog.skills[0], roots, catalog.skills);
    await mkdir(join(root, "fixture-skill"));
    await assert.rejects(() => restoreSkill(entry.id, roots), /不能覆盖/);
    assert.equal((await listSkillTrash(roots)).length, 1);
    await rmdir(join(root, "fixture-skill"));
    await restoreSkill(entry.id, roots);
    assert.equal((await scanSkills({ roots })).skills.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Skill at the root and a folder containing another indexed Skill cannot be trashed", async () => {
  const { directory, root, roots } = await setup();
  try {
    await mkdir(root);
    await writeFile(
      join(root, "SKILL.md"),
      "---\nname: root-skill\ndescription: root fixture\n---\nbody",
    );
    let catalog = await scanSkills({ roots });
    await assert.rejects(
      () => trashSkill(catalog.skills[0], roots, catalog.skills),
      /根目录/,
    );
    await rm(join(root, "SKILL.md"));
    await createSkill(input(root), roots);
    await mkdir(join(root, "fixture-skill", "nested"));
    await writeFile(
      join(root, "fixture-skill", "nested", "SKILL.md"),
      "---\nname: nested\ndescription: nested fixture\n---\nbody",
    );
    catalog = await scanSkills({ roots });
    const parent = catalog.skills.find((s) => s.name === "fixture-skill")!;
    await assert.rejects(
      () => trashSkill(parent, roots, catalog.skills),
      /其他技能/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "root and trash symlink escapes are refused without changing their targets",
  { skip: process.platform === "win32" },
  async () => {
    const { directory, root, roots } = await setup();
    const outside = join(directory, "outside");
    try {
      await mkdir(outside);
      await symlink(outside, root);
      await assert.rejects(() => createSkill(input(root), roots), /越界链接/);
      assert.deepEqual(await readdir(outside), []);
      await rm(root);
      await createSkill(input(root), roots);
      await symlink(outside, join(directory, ".acd-skill-trash"));
      const catalog = await scanSkills({ roots });
      await assert.rejects(
        () => trashSkill(catalog.skills[0], roots, catalog.skills),
        /回收区/,
      );
      assert.deepEqual(await readdir(outside), []);
      assert.equal((await listSkillTrash(roots)).length, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a redirected ancestor and a replaced skill symlink are not followed for writes",
  { skip: process.platform === "win32" },
  async () => {
    const { directory, root, roots } = await setup();
    try {
      await createSkill(input(root), roots);
      const catalog = await scanSkills({ roots });
      const folder = join(root, "fixture-skill");
      const moved = join(directory, "moved");
      const { rename } = await import("node:fs/promises");
      await rename(folder, moved);
      await symlink(moved, folder);
      await assert.rejects(
        () => trashSkill(catalog.skills[0], roots, catalog.skills),
        /变更|范围/,
      );
      assert.match(
        await readFile(join(moved, "SKILL.md"), "utf8"),
        /fixture-skill/,
      );
      const redirected = join(directory, "redirected");
      await symlink(directory, redirected);
      const unsafeRoot = join(redirected, "new-skills");
      const unsafeRoots: SkillSource[] = [
        { rootPath: unsafeRoot, scope: "global", agents: [], label: "bad" },
      ];
      await assert.rejects(
        () => createSkill(input(unsafeRoot), unsafeRoots),
        /越界链接/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("tampered recovery metadata cannot restore outside the skill root", async () => {
  const { directory, root, roots } = await setup();
  try {
    await createSkill(input(root), roots);
    const catalog = await scanSkills({ roots });
    const entry = await trashSkill(catalog.skills[0], roots, catalog.skills);
    const bucket = join(
      dirname(entry.rootPath),
      ".acd-skill-trash",
      createHash("sha256").update(entry.rootPath).digest("hex").slice(0, 24),
      entry.id,
    );
    await writeFile(
      join(bucket, "entry.json"),
      JSON.stringify({
        ...entry,
        originalDirectory: join(directory, "outside"),
      }),
    );
    assert.deepEqual(await listSkillTrash(roots), []);
    await assert.rejects(() => restoreSkill(entry.id, roots), /不存在/);
    assert.match(
      await readFile(join(bucket, "skill", "SKILL.md"), "utf8"),
      /fixture-skill/,
    );
    await assert.rejects(() => restoreSkill("../escape", roots), /无效/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
