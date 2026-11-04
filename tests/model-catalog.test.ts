import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchModelCatalog } from "../packages/core/model-catalog.js";
import { startServer } from "../packages/core/server.js";
import { Runtime } from "../packages/core/runtime.js";
import { Store } from "../packages/core/store.js";
import { requiresModelKey } from "../packages/contracts/providers.js";
async function fixture(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
const respond = (res: ServerResponse, value: unknown) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value));
};
test("model discovery is a GET, projects metadata, deduplicates IDs and filters explicit non-text outputs", async () => {
  const api = await fixture((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/v1/models?sub_type=chat");
    assert.equal(req.headers.authorization, "Bearer fixture-catalog-key");
    respond(res, {
      data: [
        { id: "z-model", name: "Zed", private: "fixture-private-metadata" },
        { id: "a-model", display_name: "Alpha" },
        { id: "a-model", display_name: "Alpha" },
        { id: "image-model", output_modalities: ["image"] },
        { id: "image-only", architecture: { output_modalities: ["image"] } },
        { id: 17 },
        { id: "" },
      ],
    });
  });
  try {
    const catalog = await fetchModelCatalog(
      { providerId: "siliconflow", protocol: "openai-chat", baseUrl: api.url },
      "fixture-catalog-key",
    );
    assert.deepEqual(catalog.models, [
      { id: "a-model", label: "Alpha" },
      { id: "z-model", label: "Zed" },
    ]);
    assert.ok(catalog.fetchedAt);
    assert.equal(catalog.hasMore, false);
    assert.doesNotMatch(
      JSON.stringify(catalog),
      /fixture-private-metadata|fixture-catalog-key/,
    );
  } finally {
    await api.close();
  }
});
test("Anthropic model discovery uses native headers and follows bounded cursor pagination", async () => {
  let calls = 0;
  const api = await fixture((req, res) => {
    calls++;
    assert.equal(req.headers["x-api-key"], "fixture-native-key");
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    assert.equal(req.headers.authorization, undefined);
    const url = new URL(req.url!, api.url);
    assert.equal(url.searchParams.get("limit"), "100");
    if (calls === 1)
      respond(res, {
        data: [{ id: "claude-a", display_name: "Claude A" }],
        has_more: true,
        last_id: "claude-a",
      });
    else {
      assert.equal(url.searchParams.get("after_id"), "claude-a");
      respond(res, {
        data: [{ id: "claude-b", display_name: "Claude B" }],
        has_more: false,
      });
    }
  });
  try {
    const result = await fetchModelCatalog(
      {
        providerId: "anthropic",
        protocol: "anthropic-messages",
        baseUrl: api.url,
      },
      "fixture-native-key",
    );
    assert.equal(calls, 2);
    assert.equal(result.models.length, 2);
    assert.equal(result.hasMore, false);
  } finally {
    await api.close();
  }
});
test("catalog failures are actionable and never echo provider response bodies", async () => {
  let status = 401,
    body: unknown = { error: "fixture-sensitive-diagnostic" };
  const api = await fixture((_req, res) => {
    res.statusCode = status;
    respond(res, body);
  });
  const connection = {
    providerId: "custom",
    protocol: "openai-chat" as const,
    baseUrl: api.url,
  };
  try {
    for (const [code, pattern] of [
      [401, /认证/],
      [403, /认证/],
      [404, /手动/],
      [429, /频繁/],
      [500, /HTTP 500/],
    ] as const) {
      status = code;
      await assert.rejects(
        fetchModelCatalog(connection, "fixture-sensitive-key"),
        (e: Error) => {
          assert.match(e.message, pattern);
          assert.doesNotMatch(e.message, /fixture-sensitive/);
          return true;
        },
      );
    }
    status = 200;
    body = { secret: "fixture-sensitive-key" };
    await assert.rejects(fetchModelCatalog(connection), /标准模型列表/);
    body = { data: [], has_more: true, last_id: "loop" };
    await assert.rejects(
      fetchModelCatalog({ ...connection, protocol: "anthropic-messages" }),
      /分页/,
    );
  } finally {
    await api.close();
  }
});
test("catalog fetch refuses redirects and enforces response-size limits", async () => {
  let forwarded = 0;
  const target = await fixture((_req, res) => {
    forwarded++;
    respond(res, { data: [] });
  });
  let redirect = true;
  const api = await fixture((_req, res) => {
    if (redirect) {
      res.writeHead(302, { Location: target.url + "/models" });
      res.end();
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(" ".repeat(4 * 1024 * 1024 + 1));
    }
  });
  const connection = {
    providerId: "custom",
    protocol: "openai-chat" as const,
    baseUrl: api.url,
  };
  try {
    await assert.rejects(
      fetchModelCatalog(connection, "fixture-redirect-key"),
      /无法连接/,
    );
    assert.equal(forwarded, 0);
    redirect = false;
    await assert.rejects(fetchModelCatalog(connection), /过大/);
  } finally {
    await api.close();
    await target.close();
  }
});
test("authenticated catalog requests use draft or same-origin saved keys without saving configuration", async () => {
  let requests = 0;
  const api = await fixture((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, "Bearer fixture-draft-key");
    respond(res, { data: [{ id: "fixture-chat" }] });
  });
  const directory = mkdtempSync(join(tmpdir(), "acd-catalog-api-"));
  const keys = new Map<string, string>();
  let writes = 0;
  const app = await startServer({
    directory,
    port: 0,
    deps: {
      scan: async () => [],
      adapter: () => {
        throw Error("must not execute");
      },
      vault: {
        get: async (url) => keys.get(new URL(url!).origin) || null,
        set: async (key, url) => {
          writes++;
          keys.set(new URL(url!).origin, key);
        },
      },
    },
  });
  const headers = {
    Authorization: "Bearer " + app.descriptor.token,
    "Content-Type": "application/json",
  };
  const request = (path: string, body: unknown) =>
    fetch(app.descriptor.url + path, {
      method: path === "/api/model" ? "PUT" : "POST",
      headers,
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (
        await fetch(app.descriptor.url + "/api/model/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    const draft = await request("/api/model/models", {
      baseUrl: api.url,
      apiKey: "fixture-draft-key",
    });
    assert.equal(draft.status, 200);
    assert.equal((await draft.json()).models[0].id, "fixture-chat");
    assert.equal(writes, 0);
    assert.equal(app.runtime.snapshot().model, null);
    assert.equal(
      (
        await request("/api/model", {
          baseUrl: api.url,
          model: "fixture-chat",
          apiKey: "fixture-draft-key",
        })
      ).status,
      200,
    );
    const before = app.runtime.snapshot().model;
    assert.equal(
      (await request("/api/model/models", { baseUrl: api.url })).status,
      200,
    );
    assert.equal(writes, 1);
    assert.deepEqual(app.runtime.snapshot().model, before);
    assert.equal(
      (await request("/api/model/models", { baseUrl: "http://127.0.0.1:1/v1" }))
        .status,
      400,
    );
    assert.equal(requests, 2);
    assert.doesNotMatch(
      JSON.stringify(app.runtime.snapshot()),
      /fixture-draft-key/,
    );
  } finally {
    await app.close();
    await api.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("local no-key configuration and routing work without consulting the system vault", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acd-local-model-"));
  const store = new Store(directory);
  let routed!: () => void;
  const routedPromise = new Promise<void>((resolve) => {
    routed = resolve;
  });
  const runtime = new Runtime(store, {
    scan: async () => [],
    adapter: () => {
      throw Error("must not execute");
    },
    vault: {
      get: async () => {
        throw Error("must not access credentials");
      },
      set: async () => {
        throw Error("must not access credentials");
      },
    },
    route: async (_config, key) => {
      assert.equal(key, "");
      routed();
      return { reply: "Local fixture is ready", actions: [] };
    },
  });
  try {
    await runtime.configure({
      providerId: "ollama",
      model: "locally-installed-model",
    });
    assert.equal(runtime.snapshot().model?.hasKey, false);
    runtime.receive("status", directory);
    await Promise.race([
      routedPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("route timeout")), 1000),
      ),
    ]);
    assert.equal(
      requiresModelKey({
        providerId: "ollama",
        baseUrl: "https://remote.example/v1",
      }),
      true,
    );
    assert.equal(
      requiresModelKey({
        providerId: "custom",
        baseUrl: "http://localhost:1234/v1",
      }),
      true,
    );
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
