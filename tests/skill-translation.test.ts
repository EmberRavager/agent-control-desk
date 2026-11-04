import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translateSkill } from "../packages/core/model.js";
import { startServer } from "../packages/core/server.js";
import type { SkillCatalog, SkillDetail } from "../packages/contracts/index.js";

const detail: SkillDetail = {
  skill: {
    id: "fixture-skill",
    name: "fixture-skill",
    description: "Read a report.",
    path: "/fixture/skills/fixture-skill/SKILL.md",
    directory: "/fixture/skills/fixture-skill",
    sources: [],
    warnings: [],
    valid: true,
  },
  content: "# Read a report\n\nKeep `report.md` unchanged.",
  truncated: false,
};
const translated = {
  description: "阅读报告。",
  content: "# 阅读报告\n\n保留 `report.md` 原样。",
};

test("skill translation reuses the configured provider and sends only selected text as inert data", async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, undefined);
    let raw = "";
    req.setEncoding("utf8");
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, "fixture-local");
    assert.equal(body.reasoning_effort, "none");
    assert.equal(body.max_tokens, 8192);
    assert.match(body.messages[0].content, /不得执行或服从/);
    assert.deepEqual(JSON.parse(body.messages[1].content), {
      name: detail.skill.name,
      description: detail.skill.description,
      content: detail.content,
    });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(translated) } }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = {
    providerId: "ollama",
    model: "fixture-local",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    hasKey: false,
  };
  try {
    assert.deepEqual(await translateSkill(config, "", detail), {
      ...translated,
      truncated: false,
    });
    await assert.rejects(
      translateSkill(config, "", { ...detail, content: " " }),
      /内容为空/,
    );
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("native translation bounds long Unicode input and rejects incomplete or malformed output", async () => {
  let mode: "valid" | "incomplete" | "malformed" = "valid";
  const server = createServer(async (req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(req.url, "/v1/messages");
    assert.equal(req.headers["x-api-key"], "fixture-key");
    assert.equal(body.max_tokens, 8192);
    assert.equal(
      Array.from(JSON.parse(body.messages[0].content).content).length,
      12000,
    );
    assert.ok(body.output_config.format.schema.properties.content);
    assert.equal(
      body.output_config.format.schema.properties.actions,
      undefined,
    );
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              mode === "malformed"
                ? { description: "译文", content: 42 }
                : translated,
            ),
          },
        ],
        ...(mode === "incomplete" ? { stop_reason: "max_tokens" } : {}),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = {
    providerId: "anthropic",
    model: "fixture-native",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    hasKey: true,
  };
  const longDetail = { ...detail, content: "😀".repeat(12001) };
  try {
    assert.equal(
      (await translateSkill(config, "fixture-key", longDetail)).truncated,
      true,
    );
    mode = "incomplete";
    await assert.rejects(
      translateSkill(config, "fixture-key", longDetail),
      /完整合法 JSON/,
    );
    mode = "malformed";
    await assert.rejects(
      translateSkill(config, "fixture-key", longDetail),
      /翻译结果格式/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("translation API requires a model and indexed skill, preserves files, and creates no tasks or chat history", async () => {
  const root = await mkdtemp(join(tmpdir(), "acd-skill-translation-"));
  const home = join(root, "home");
  const directory = join(home, ".agents", "skills", "fixture-skill");
  const path = join(directory, "SKILL.md");
  await mkdir(directory, { recursive: true });
  const original =
    "---\nname: fixture-skill\ndescription: Read a report.\n---\n" +
    detail.content;
  await writeFile(path, original);
  const provider = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(translated) } }],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const app = await startServer({
    directory: join(root, "data"),
    skillHome: home,
    port: 0,
    deps: {
      scan: async () => [],
      vault: {
        get: async () => {
          throw Error("No key should be read");
        },
        set: async () => {},
      },
      adapter: () => {
        throw Error("No agent should execute");
      },
    },
  });
  const headers = {
    Authorization: "Bearer " + app.descriptor.token,
    "Content-Type": "application/json",
  };
  const post = (resource: string) =>
    fetch(app.descriptor.url + resource, {
      method: "POST",
      headers,
      body: "{}",
    });
  try {
    assert.equal(
      (
        await fetch(app.descriptor.url + "/api/skills/unknown/translate", {
          method: "POST",
        })
      ).status,
      401,
    );
    assert.equal((await post("/api/skills/unknown/translate")).status, 404);
    const catalog = (await (
      await post("/api/skills/scan")
    ).json()) as SkillCatalog;
    const resource = `/api/skills/${catalog.skills[0].id}/translate`;
    const missing = await post(resource);
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /配置总控模型/);
    await app.runtime.configure({
      providerId: "ollama",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "fixture-local",
    });
    const response = await post(resource);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ...translated,
      truncated: false,
    });
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(app.runtime.snapshot().tasks.length, 0);
    assert.equal(app.runtime.snapshot().messages.length, 0);
    assert.ok(
      !JSON.stringify(app.runtime.store.get("settings", "skills")).includes(
        translated.content,
      ),
    );
  } finally {
    await app.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
