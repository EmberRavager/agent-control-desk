import React, { useMemo, useRef, useState } from "react";
import type { ModelOption } from "../../packages/contracts/providers.js";
interface Props {
  value: string;
  onChange: (value: string) => void;
  options: ModelOption[];
  disabled: boolean;
  source: "remote" | "suggestions";
}
/** Native listbox provides keyboard selection; arbitrary IDs remain editable. */
export default function ModelPicker({
  value,
  onChange,
  options,
  disabled,
  source,
}: Props) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return options.filter((m) =>
      (m.id + " " + m.label).toLocaleLowerCase().includes(term),
    );
  }, [options, query]);
  return (
    <div className="model-picker">
      <div className="model-picker-value">
        <input
          id="model-id"
          ref={field}
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="选择模型，或填写完整模型 ID"
          autoComplete="off"
          aria-describedby="model-help"
        />
        <button
          type="button"
          className="button"
          disabled={disabled}
          aria-expanded={open}
          aria-controls="model-selection"
          onClick={() => setOpen(!open)}
        >
          选择模型
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={open ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} />
          </svg>
        </button>
      </div>
      {open && (
        <div className="model-selection" id="model-selection">
          <div className="model-selection-head">
            <span>
              {source === "remote" ? "服务返回的模型" : "参考型号"} ·{" "}
              {options.length}
            </span>
            <button
              type="button"
              aria-label="收起模型列表"
              className="icon"
              onClick={() => {
                setOpen(false);
                field.current?.focus();
              }}
            >
              ×
            </button>
          </div>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型名称或 ID"
            aria-label="搜索模型"
            autoFocus
          />
          {filtered.length ? (
            <select
              size={Math.min(6, Math.max(3, filtered.length))}
              aria-label="可选模型"
              value={filtered.some((m) => m.id === value) ? value : ""}
              onChange={(e) => {
                onChange(e.target.value);
                setOpen(false);
                setQuery("");
                field.current?.focus();
              }}
            >
              <option value="" disabled hidden>
                选择模型
              </option>
              {filtered.map((m) => (
                <option key={m.id} value={m.id} title={m.id}>
                  {m.label === m.id ? m.id : m.label + " · " + m.id}
                </option>
              ))}
            </select>
          ) : (
            <p className="model-picker-empty">
              {options.length
                ? "没有匹配项，可以直接填写模型 ID。"
                : "暂无列表。先获取模型列表，或直接填写模型 ID。"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
