import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { route } from "../packages/core/model.js";
import {
  routingCases,
  routingFixture,
  checkRoutingCase,
} from "./routing-cases.js";

// Explicit opt-in only. Synthetic context; this runner never starts an agent.
const { values } = parseArgs({
  options: {
    model: { type: "string" },
    repeat: { type: "string", default: "1" },
  },
});
if (!values.model)
  throw Error(
    "用法：npm run eval:routing -- --model <已安装的 Ollama 模型> [--repeat 1..3]",
  );
const repeat = Number(values.repeat);
if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 3)
  throw Error("repeat 必须为 1 至 3");
const results = [];
for (let round = 1; round <= repeat; round++)
  for (const item of routingCases) {
    const { snapshot, cwd } = routingFixture(item),
      start = Date.now();
    try {
      const decision = await route(
        {
          providerId: "ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: values.model,
          hasKey: false,
        },
        "",
        snapshot,
        item.text,
        cwd,
        item.targetTaskId,
      );
      const errors = checkRoutingCase(item, decision, cwd);
      results.push({
        round,
        name: item.name,
        passed: !errors.length,
        errors,
        decision,
        elapsedMs: Date.now() - start,
      });
      console.log(
        `${errors.length ? "FAIL" : "PASS"} ${round} ${item.name}${errors.length ? ": " + errors.join("；") : ""}`,
      );
    } catch (error) {
      results.push({
        round,
        name: item.name,
        passed: false,
        errors: [error instanceof Error ? error.message : "请求失败"],
        elapsedMs: Date.now() - start,
      });
      console.log(`FAIL ${round} ${item.name}: 请求失败`);
    }
  }
const output = join(tmpdir(), `acd-routing-eval-${Date.now()}.json`);
writeFileSync(
  output,
  JSON.stringify(
    { model: values.model, createdAt: new Date().toISOString(), results },
    null,
    2,
  ),
  { mode: 0o600 },
);
const passed = results.filter((result) => result.passed).length;
console.log(
  `${passed}/${results.length} passed; no agents executed; ${output}`,
);
if (passed !== results.length) process.exitCode = 1;
