import type {
  ModelCatalog,
  ModelConnection,
  ModelOption,
} from "../contracts/providers.js";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 2000;
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw Error("模型列表为空，可手动填写模型 ID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw Error("模型列表过大，请手动填写模型 ID");
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Error("服务未返回有效模型列表，可继续手动填写模型 ID");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function fetchModelCatalog(
  connection: ModelConnection,
  key?: string | null,
): Promise<ModelCatalog> {
  const native = connection.protocol === "anthropic-messages";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (native) {
    headers["anthropic-version"] = "2023-06-01";
    if (key) headers["x-api-key"] = key;
  } else if (key) headers.Authorization = "Bearer " + key;
  const models = new Map<string, ModelOption>();
  const cursors = new Set<string>();
  const signal = AbortSignal.timeout(12_000);
  let after = "",
    hasMore = false;
  for (let page = 0; page < 10; page++) {
    const url = new URL(connection.baseUrl + "/models");
    if (native) {
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after_id", after);
    }
    if (connection.providerId === "siliconflow")
      url.searchParams.set("sub_type", "chat");
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal,
      });
    } catch {
      throw Error(
        signal.aborted
          ? "获取模型列表超时，可重试或手动填写"
          : "无法连接模型列表接口，请检查地址和网络；也可手动填写模型 ID",
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403)
        throw Error("模型列表认证失败，请检查此服务的 API Key 与访问权限");
      if (response.status === 404 || response.status === 405)
        throw Error("此地址未提供模型列表接口，请手动填写模型 ID");
      if (response.status === 429)
        throw Error("模型列表请求过于频繁，请稍后重试");
      throw Error(
        "获取模型列表失败（HTTP " + response.status + "），可手动填写模型 ID",
      );
    }
    let body: unknown;
    try {
      body = await boundedJson(response);
    } catch (e) {
      if (signal.aborted) throw Error("获取模型列表超时，可重试或手动填写");
      throw e;
    }
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { data?: unknown }).data)
    )
      throw Error("此接口没有返回标准模型列表，请手动填写模型 ID");
    const data = body as {
      data: unknown[];
      has_more?: boolean;
      last_id?: unknown;
    };
    for (const row of data.data) {
      if (!row || typeof row !== "object") continue;
      const entry = row as {
        id?: unknown;
        name?: unknown;
        display_name?: unknown;
        output_modalities?: unknown;
        architecture?: { output_modalities?: unknown };
      };
      if (
        typeof entry.id !== "string" ||
        !entry.id.trim() ||
        entry.id.length > 200
      )
        continue;
      const modalities =
        entry.output_modalities || entry.architecture?.output_modalities;
      if (Array.isArray(modalities) && !modalities.includes("text")) continue;
      const label =
        typeof entry.display_name === "string"
          ? entry.display_name
          : typeof entry.name === "string"
            ? entry.name
            : entry.id;
      models.set(entry.id, { id: entry.id, label: label.slice(0, 200) });
      if (models.size >= MAX_MODELS) break;
    }
    hasMore = data.has_more === true || models.size >= MAX_MODELS;
    if (!native || !hasMore || models.size >= MAX_MODELS) break;
    if (
      typeof data.last_id !== "string" ||
      !data.last_id ||
      cursors.has(data.last_id)
    )
      throw Error("模型列表分页信息无效，请手动填写模型 ID");
    after = data.last_id;
    cursors.add(after);
  }
  return {
    models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
    fetchedAt: new Date().toISOString(),
    hasMore,
  };
}
