import React, { useEffect, useRef, useState, type FormEvent } from "react";
import type { ModelConfig } from "../../packages/contracts/index.js";
import {
  modelProviders,
  providerGroups,
  requiresModelKey,
  type ModelCatalog,
  type ModelConnection,
} from "../../packages/contracts/providers.js";
import ModelPicker from "./ModelPicker.js";
export type SettingsInput = ModelConnection & {
  model: string;
  apiKey?: string;
};
export type CatalogInput = ModelConnection & { apiKey?: string };
interface Props {
  config: ModelConfig | null;
  save: (input: SettingsInput) => Promise<void>;
  loadModels: (input: CatalogInput) => Promise<ModelCatalog>;
}
function sameOrigin(a: string, b: string) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
export default function ModelSettings({ config, save, loadModels }: Props) {
  const initial =
    modelProviders.find((p) => p.id === config?.providerId) ||
    modelProviders.find(
      (p) =>
        config?.baseUrl && p.baseUrl && sameOrigin(p.baseUrl, config.baseUrl),
    ) ||
    modelProviders.find((p) => p.id === (config ? "custom" : "deepseek")) ||
    modelProviders[0];
  const [providerId, setProviderId] = useState(initial.id),
    [baseUrl, setBaseUrl] = useState(config?.baseUrl || initial.baseUrl),
    [protocol, setProtocol] = useState<SettingsInput["protocol"]>(
      config?.protocol || initial.protocol,
    ),
    [model, setModel] = useState(config?.model || initial.models[0]?.id || ""),
    [key, setKey] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [catalog, setCatalog] = useState<ModelCatalog | null>(null),
    [catalogError, setCatalogError] = useState(""),
    [loadingModels, setLoadingModels] = useState(false);
  const keyField = useRef<HTMLInputElement>(null),
    generation = useRef(0),
    live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);
  const provider = modelProviders.find((p) => p.id === providerId)!;
  const retained = Boolean(
    config?.hasKey && sameOrigin(config.baseUrl, baseUrl),
  );
  const keyRequired = requiresModelKey({ providerId, baseUrl });
  const options = catalog?.models || provider.models;
  function invalidateCatalog() {
    generation.current++;
    setCatalog(null);
    setCatalogError("");
    setLoadingModels(false);
  }
  function changeProvider(id: string) {
    const next = modelProviders.find((p) => p.id === id)!;
    setProviderId(id);
    setBaseUrl(next.baseUrl);
    setProtocol(next.protocol);
    setModel(next.models[0]?.id || "");
    setKey("");
    setError("");
    setSaved(false);
    invalidateCatalog();
  }
  async function fetchModels() {
    if (keyRequired && !retained && !key.trim()) {
      setCatalogError("请先填写此服务的 API Key，再获取模型列表。");
      keyField.current?.focus();
      return;
    }
    const ticket = ++generation.current;
    setLoadingModels(true);
    setCatalogError("");
    try {
      const result = await loadModels({
        providerId,
        protocol,
        baseUrl,
        ...(key.trim() ? { apiKey: key.trim() } : {}),
      });
      if (live.current && ticket === generation.current) setCatalog(result);
    } catch (e) {
      if (live.current && ticket === generation.current)
        setCatalogError(
          e instanceof Error ? e.message : "获取失败，仍可手动填写模型 ID。",
        );
    } finally {
      if (live.current && ticket === generation.current)
        setLoadingModels(false);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await save({
        providerId,
        protocol,
        baseUrl,
        model: model.trim(),
        ...(key.trim() ? { apiKey: key.trim() } : {}),
      });
      if (live.current) {
        setKey("");
        setSaved(true);
      }
    } catch (e) {
      if (live.current)
        setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      if (live.current) setSaving(false);
    }
  }
  return (
    <form onSubmit={submit} className="model-settings">
      <div className="settings-role-note">
        <strong>执行 Agent 单独配置</strong>
        <p>
          这里的 Key 用于 ACD 总控。Codex、Claude Code 等执行 Agent
          需要在各自程序中登录和配置模型。
        </p>
      </div>
      <label className="setting-field" htmlFor="model-provider">
        <span>模型服务商</span>
        <select
          id="model-provider"
          value={providerId}
          onChange={(e) => changeProvider(e.target.value)}
          disabled={saving}
          aria-describedby="provider-help"
        >
          {providerGroups.map((group) => (
            <optgroup label={group} key={group}>
              {modelProviders
                .filter((p) => p.group === group)
                .map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <small id="provider-help" className="field-help">
          {provider.hint ||
            "使用此服务商控制台创建的 API Key；模型以服务返回的完整 ID 为准。"}
        </small>
      </label>
      <label className="setting-field" htmlFor="model-key">
        <span>
          API Key {retained && <em className="settings-field-badge">已保存</em>}
          {!keyRequired && <em className="settings-field-badge">本机可留空</em>}
        </span>
        <input
          id="model-key"
          ref={keyField}
          type="password"
          value={key}
          required={keyRequired && !retained}
          onChange={(e) => {
            setKey(e.target.value);
            setSaved(false);
            invalidateCatalog();
          }}
          placeholder={
            retained
              ? "留空保留已保存的 Key"
              : keyRequired
                ? "填写此服务商的 API Key"
                : "若本地服务启用了认证，请填写 Key"
          }
          autoComplete="off"
          spellCheck={false}
          disabled={saving}
          aria-describedby="key-help"
        />
        <small id="key-help" className="field-help">
          保存在系统凭证存储中，不显示已保存的原文。获取模型列表不会保存草稿
          Key。
        </small>
      </label>
      <div className="setting-field model-setting-field">
        <div className="model-setting-label">
          <label htmlFor="model-id">模型</label>
          <button
            type="button"
            className="button ghost"
            onClick={() => void fetchModels()}
            disabled={saving || loadingModels}
          >
            {loadingModels
              ? "正在获取…"
              : catalog
                ? "刷新模型列表"
                : "获取模型列表"}
          </button>
        </div>
        <ModelPicker
          key={providerId}
          value={model}
          onChange={(value) => {
            setModel(value);
            setSaved(false);
          }}
          options={options}
          disabled={saving}
          source={catalog ? "remote" : "suggestions"}
        />
        <small id="model-help" className="field-help">
          可搜索列表或直接填写完整模型
          ID，不受内置选项限制。总控模型需要能返回合法 JSON。
        </small>
        {catalog ? (
          <p className="model-catalog-status" role="status">
            已获取 {catalog.models.length} 个模型
            {catalog.hasMore ? "，列表未完整，可继续手动填写" : ""}
            。返回列表不等于已验证调用权限。
          </p>
        ) : (
          <p className="model-catalog-hint">
            {provider.models.length
              ? "内置参考型号可直接选择，获取服务列表可加载更多模型。"
              : "先获取服务中的模型，或填写你已部署的模型 ID。"}
          </p>
        )}
        {catalogError && (
          <p className="model-catalog-error" role="alert">
            {catalogError}
          </p>
        )}
      </div>
      <details
        className="model-advanced"
        open={provider.id === "custom" ? true : undefined}
      >
        <summary>
          高级设置 <span>接口地址与协议</span>
        </summary>
        <label className="setting-field" htmlFor="model-endpoint">
          <span>接口地址</span>
          <input
            id="model-endpoint"
            type="url"
            required
            value={baseUrl}
            onChange={(e) => {
              if (!sameOrigin(baseUrl, e.target.value)) setKey("");
              setBaseUrl(e.target.value);
              setSaved(false);
              invalidateCatalog();
            }}
            placeholder="https://api.example.com/v1"
            disabled={saving}
            aria-describedby="endpoint-help"
          />
          <small id="endpoint-help" className="field-help">
            填写基础地址，不包含 /chat/completions 或
            /messages。地区、工作空间和套餐需要对应的地址与 Key。
          </small>
        </label>
        {provider.id === "custom" ? (
          <label className="setting-field" htmlFor="model-protocol">
            <span>接口协议</span>
            <select
              id="model-protocol"
              value={protocol}
              onChange={(e) => {
                setProtocol(e.target.value as SettingsInput["protocol"]);
                setSaved(false);
                invalidateCatalog();
              }}
              disabled={saving}
            >
              <option value="openai-chat">OpenAI Chat Completions 兼容</option>
              <option value="anthropic-messages">
                Anthropic Messages 兼容
              </option>
            </select>
          </label>
        ) : (
          <p className="field-help">
            接口协议：
            {protocol === "anthropic-messages"
              ? "Anthropic Messages"
              : "OpenAI Chat Completions 兼容"}
          </p>
        )}
      </details>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="settings-saved" role="status">
          模型配置已保存，可以返回总控交代任务。
        </p>
      )}
      <div className="settings-form-actions">
        <p className="field-help">
          获取列表不生成内容；保存不会调用模型。模型是否适用于总控，以实际任务结果为准。
        </p>
        <button className="button primary" disabled={saving}>
          {saving ? "保存中…" : "保存模型配置"}
        </button>
      </div>
    </form>
  );
}
