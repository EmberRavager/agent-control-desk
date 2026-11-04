import test from "node:test";
import assert from "node:assert/strict";
import {
  modelProviders,
  resolveModelSettings,
  validateBaseUrl,
} from "../packages/contracts/providers.js";

test("provider defaults resolve without limiting editable model names", () => {
  for (const provider of modelProviders.filter(
    (entry) => entry.id !== "custom",
  )) {
    assert.deepEqual(
      resolveModelSettings({
        providerId: provider.id,
        model: " private-model-v2 ",
      }),
      {
        providerId: provider.id,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        model: "private-model-v2",
      },
    );
  }
  assert.equal(
    resolveModelSettings({ providerId: "anthropic", model: "fixture" })
      .protocol,
    "anthropic-messages",
  );
});

test("advanced base URL overrides and legacy custom configs remain supported", () => {
  assert.deepEqual(
    resolveModelSettings({
      providerId: "dashscope",
      baseUrl:
        " https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/ ",
      model: "custom-model",
    }),
    {
      providerId: "dashscope",
      protocol: "openai-chat",
      baseUrl:
        "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      model: "custom-model",
    },
  );
  assert.deepEqual(
    resolveModelSettings({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local",
    }),
    {
      providerId: "custom",
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local",
    },
  );
  assert.equal(
    resolveModelSettings({
      providerId: "custom",
      protocol: "anthropic-messages",
      baseUrl: "https://proxy.example/v1",
      model: "custom-claude",
    }).protocol,
    "anthropic-messages",
  );
});

test("provider resolver rejects incomplete or mismatched settings", () => {
  for (const input of [
    { providerId: "unknown", model: "m" },
    { providerId: "custom", model: "m" },
    { providerId: "openai", model: " " },
    { providerId: "openai", model: "x".repeat(201) },
    { providerId: "anthropic", model: "m", protocol: "openai-chat" as const },
    {
      providerId: "openai",
      model: "m",
      baseUrl: "https://user:fake@example.com/v1",
    },
    {
      providerId: "openai",
      model: "m",
      baseUrl: "https://example.com/v1?key=fake",
    },
    { providerId: "openai", model: "m", baseUrl: "http://example.com/v1" },
  ])
    assert.throws(() => resolveModelSettings(input));
  assert.throws(
    () => validateBaseUrl("not-a-url-with-fake-secret"),
    (error: Error) => !error.message.includes("fake-secret"),
  );
  assert.throws(() => validateBaseUrl("https://example.com/v1#key=fake"));
  assert.equal(
    validateBaseUrl("http://[::1]:1234/v1/"),
    "http://[::1]:1234/v1",
  );
});
