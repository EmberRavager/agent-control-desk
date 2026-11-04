import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../packages/core/server.js";
import type { SkillCatalog, SkillDetail } from "../packages/contracts/index.js";
test("skill endpoints require authentication, preview indexed files only, and never persist bodies", async () => {
  const root = mkdtempSync(join(tmpdir(), "acd-skills-http-")),
    home = join(root, "home"),
    data = join(root, "data");
  const directory = join(home, ".agents", "skills", "fixture-report");
  mkdirSync(directory, { recursive: true });
  const marker = "PRIVATE_FIXTURE_BODY_ONLY";
  writeFileSync(
    join(directory, "SKILL.md"),
    "---\nname: fixture-report\ndescription: Writes a fixture report\n---\n" +
      marker,
  );
  const app = await startServer({
    directory: data,
    skillHome: home,
    port: 0,
    deps: {
      scan: async () => [],
      adapter: () => {
        throw Error("not allowed");
      },
      vault: { get: async () => null, set: async () => {} },
    },
  });
  const headers = {
    Authorization: "Bearer " + app.descriptor.token,
    "Content-Type": "application/json",
  };
  try {
    assert.equal((await fetch(app.descriptor.url + "/api/skills")).status, 401);
    assert.equal(
      (await fetch(app.descriptor.url + "/api/skills/not-indexed", { headers }))
        .status,
      404,
    );
    assert.equal(
      (
        await fetch(app.descriptor.url + "/api/skills/scan", {
          method: "POST",
          headers,
          body: JSON.stringify({ projectPath: "relative" }),
        })
      ).status,
      400,
    );
    const response = await fetch(app.descriptor.url + "/api/skills/scan", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(response.status, 200);
    const catalog = (await response.json()) as SkillCatalog;
    assert.equal(catalog.skills.length, 1);
    assert.equal(catalog.skills[0].name, "fixture-report");
    assert.ok(!JSON.stringify(catalog).includes(marker));
    const detail = (await fetch(
      app.descriptor.url + "/api/skills/" + catalog.skills[0].id,
      { headers },
    ).then((r) => r.json())) as SkillDetail;
    assert.ok(detail.content.includes(marker));
    const cached = await fetch(app.descriptor.url + "/api/skills", {
      headers,
    }).then((r) => r.json());
    assert.equal(cached.skills.length, 1);
    const state = await fetch(app.descriptor.url + "/api/state", {
      headers,
    }).then((r) => r.text());
    assert.ok(!state.includes(marker));
    const stored = app.runtime.store.get("settings", "skills");
    assert.ok(!JSON.stringify(stored).includes(marker));
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill creation, recoverable deletion and restoration share the authenticated catalog API", async () => {
  const root = mkdtempSync(join(tmpdir(), "acd-skill-crud-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const app = await startServer({
    directory: join(root, "data"),
    skillHome: home,
    port: 0,
    deps: {
      scan: async () => [],
      adapter: () => {
        throw Error("not used");
      },
      vault: { get: async () => null, set: async () => {} },
    },
  });
  const headers = {
    Authorization: "Bearer " + app.descriptor.token,
    "Content-Type": "application/json",
  };
  const request = (path: string, body: unknown = {}) =>
    fetch(app.descriptor.url + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  try {
    const rootPath = join(home, ".agents", "skills");
    const created = await request("/api/skills", {
      rootPath,
      name: "fresh-skill",
      description: "A local workflow",
      content: "# Workflow\nDo the specified work.",
    });
    assert.equal(created.status, 201);
    const catalog = (await created.json()) as SkillCatalog;
    const skill = catalog.skills.find((s) => s.name === "fresh-skill")!;
    assert.ok(skill);
    assert.equal(
      (
        await request("/api/skills", {
          rootPath,
          name: "fresh-skill",
          description: "Duplicate",
          content: "No overwrite",
        })
      ).status,
      400,
    );
    const removed = await request("/api/skills/" + skill.id + "/trash");
    assert.equal(removed.status, 200);
    const entry = await removed.json();
    const after = (await fetch(app.descriptor.url + "/api/skills", {
      headers,
    }).then((r) => r.json())) as SkillCatalog;
    assert.equal(after.skills.length, 0);
    const trash = await fetch(app.descriptor.url + "/api/skills/trash", {
      headers,
    }).then((r) => r.json());
    assert.equal(trash.length, 1);
    assert.equal(trash[0].id, entry.id);
    const restored = await request(
      "/api/skills/trash/" + entry.id + "/restore",
    );
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).skills[0].name, "fresh-skill");
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
