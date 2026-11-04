export type ModelProtocol = "openai-chat" | "anthropic-messages";
export interface ModelOption {
  id: string;
  label: string;
}
export interface ModelCatalog {
  models: ModelOption[];
  fetchedAt: string;
  hasMore: boolean;
}
export interface ModelConnectionInput {
  providerId?: string;
  protocol?: ModelProtocol;
  baseUrl?: string;
}
export interface ModelConnection {
  providerId: string;
  protocol: ModelProtocol;
  baseUrl: string;
}
export const providerGroups = [
  "国内服务商",
  "国际服务商",
  "聚合平台",
  "本地与自定义",
] as const;
export interface ModelProvider {
  id: string;
  name: string;
  group: (typeof providerGroups)[number];
  baseUrl: string;
  protocol: ModelProtocol;
  models: ModelOption[];
  local?: boolean;
  hint?: string;
  jsonMode?: "prompt";
}
// Editable examples from official documentation. The remote catalog remains authoritative.
const choices = (...ids: string[]): ModelOption[] =>
  ids.map((id) => ({ id, label: id }));
export const modelProviders: ModelProvider[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    group: "国内服务商",
    baseUrl: "https://api.deepseek.com",
    protocol: "openai-chat",
    models: choices("deepseek-flash", "deepseek-v4-pro"),
  },
  {
    id: "dashscope",
    name: "阿里云百炼 · Qwen",
    group: "国内服务商",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "openai-chat",
    models: choices("qwen3.8-max", "qwen3.7-plus", "qwen3.8-flash"),
    hint: "默认中国区接口；不同地区或工作空间，请修改高级设置中的地址。",
  },
  {
    id: "moonshot",
    name: "Kimi · 月之暗面",
    group: "国内服务商",
    baseUrl: "https://api.moonshot.cn/v1",
    protocol: "openai-chat",
    models: choices(
      "kimi-k3.1-pro",
      "kimi-k3.1-pro-highspeed",
      "kimi-k3",
      "kimi-k2.7-code",
    ),
  },
  {
    id: "zhipu",
    name: "智谱 · GLM",
    group: "国内服务商",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai-chat",
    models: choices("glm-5.3", "glm-5.2"),
    hint: "默认标准 API。Coding Plan 等套餐请按服务商说明使用对应地址和 Key。",
  },
  {
    id: "minimax",
    name: "MiniMax",
    group: "国内服务商",
    baseUrl: "https://api.minimax.cn/v1",
    protocol: "openai-chat",
    models: choices("MiniMax-M3.1-Flash", "MiniMax-M3"),
    jsonMode: "prompt",
    hint: "默认中国区标准 API，使用 MiniMax 控制台创建的 Key。",
  },
  {
    id: "volcengine",
    name: "火山方舟 · 豆包",
    group: "国内服务商",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    protocol: "openai-chat",
    models: choices("doubao-seed-2-1-pro-260915"),
    hint: "支持填写 Model ID 或自己的 ep- 接入点 ID。Coding Plan 需使用对应套餐地址。",
  },
  {
    id: "openai",
    name: "OpenAI",
    group: "国际服务商",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai-chat",
    models: choices(
      "gpt-6.1-sol",
      "gpt-6-luna",
      "gpt-6.1-terra",
      "gpt-6-astra",
      "gpt-4.1-mini",
    ),
    hint: "使用 OpenAI API Key；ChatGPT 的订阅与 API 配置分别管理。",
  },
  {
    id: "anthropic",
    name: "Anthropic · Claude",
    group: "国际服务商",
    baseUrl: "https://api.anthropic.com/v1",
    protocol: "anthropic-messages",
    models: choices("claude-sonnet-5-5", "claude-haiku-5-5"),
  },
  {
    id: "gemini",
    name: "Google · Gemini",
    group: "国际服务商",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocol: "openai-chat",
    models: choices("gemini-3.8-flash"),
    hint: "使用 Google AI Studio 的 Gemini API Key 和 OpenAI 兼容接口。",
  },
  {
    id: "siliconflow",
    name: "硅基流动 · SiliconFlow",
    group: "聚合平台",
    baseUrl: "https://api.siliconflow.cn/v1",
    protocol: "openai-chat",
    models: choices(
      "deepseek-ai/DeepSeek-V4-Flash",
      "moonshotai/Kimi-K2.7-Code",
      "Pro/zai-org/GLM-5.1",
    ),
    hint: "模型 ID 包含供应商前缀；获取列表时仅查询对话模型。",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    group: "聚合平台",
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "openai-chat",
    models: [],
    hint: "使用 OpenRouter 的 Key，模型 ID 以服务返回的完整名称为准。",
  },
  {
    id: "ollama",
    name: "Ollama",
    group: "本地与自定义",
    baseUrl: "http://localhost:11434/v1",
    protocol: "openai-chat",
    models: [],
    local: true,
    hint: "先启动本机 Ollama，再获取已安装的模型。本机默认无需 API Key。",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    group: "本地与自定义",
    baseUrl: "http://localhost:1234/v1",
    protocol: "openai-chat",
    models: [],
    local: true,
    hint: "先在 LM Studio 启动本地服务；若已启用认证，仍需填写 Key。",
  },
  {
    id: "custom",
    name: "自定义兼容服务",
    group: "本地与自定义",
    baseUrl: "",
    protocol: "openai-chat",
    models: [],
    hint: "填写服务提供的基础地址、协议与完整模型 ID。支持中转和私有部署。",
  },
];
export function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw Error("请输入有效的模型接口地址");
  }
  if (url.username || url.password || url.search || url.hash)
    throw Error("模型地址不能包含凭证或查询参数");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw Error("模型地址需要 HTTPS，或本机 HTTP");
  return url.toString().replace(/\/+$/, "");
}
export function resolveModelConnection(
  input: ModelConnectionInput,
): ModelConnection {
  const providerId = input.providerId ?? "custom";
  const provider = modelProviders.find((entry) => entry.id === providerId);
  if (!provider) throw Error("请选择支持的模型服务商，或使用自定义接入");
  const protocol = input.protocol ?? provider.protocol;
  if (protocol !== "openai-chat" && protocol !== "anthropic-messages")
    throw Error("不支持的模型接口协议");
  if (providerId !== "custom" && protocol !== provider.protocol)
    throw Error("模型接口协议与所选服务商不匹配");
  return {
    providerId,
    protocol,
    baseUrl: validateBaseUrl(input.baseUrl?.trim() || provider.baseUrl),
  };
}
export function requiresModelKey(
  input: Pick<ModelConnection, "providerId" | "baseUrl">,
): boolean {
  try {
    return !(
      modelProviders.find((p) => p.id === input.providerId)?.local &&
      ["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(input.baseUrl).hostname,
      )
    );
  } catch {
    return true;
  }
}
export function resolveModelSettings(
  input: ModelConnectionInput & { model: string },
): ModelConnection & { model: string } {
  const connection = resolveModelConnection(input);
  const model = input.model.trim();
  if (!model || model.length > 200) throw Error("请填写有效的模型名称");
  return { ...connection, model };
}
