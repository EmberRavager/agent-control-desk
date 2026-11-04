import test from "node:test";
import assert from "node:assert/strict";
import {
  conversationMessages,
  latestNativeReports,
} from "../packages/contracts/completion.js";
import type { Message } from "../packages/contracts/index.js";
test("one latest native report is displayed while user messages, owned results and durable history remain intact", () => {
  const messages: Message[] = [
    { id: "u", role: "user", text: "要求", taskIds: [], createdAt: "1" },
    ...["old", "new"].map((id) => ({
      id,
      role: "assistant" as const,
      text: id,
      taskIds: [],
      createdAt: id,
      completion: {
        id,
        title: "任务",
        status: "ready" as const,
        nativeId: "native-a",
      },
    })),
    {
      id: "owned",
      role: "assistant",
      text: "独立任务",
      taskIds: ["task"],
      createdAt: "4",
      completion: { id: "owned", title: "独立", status: "ready" },
    },
  ];
  assert.deepEqual(
    conversationMessages(messages).map((m) => m.id),
    ["u", "new", "owned"],
  );
  assert.deepEqual(
    latestNativeReports(messages).map((m) => m.id),
    ["new"],
  );
  assert.equal(messages.length, 4);
});
