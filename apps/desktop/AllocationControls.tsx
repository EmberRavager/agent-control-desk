import { useI18n } from "./i18n.js";
import React, { useId } from "react";
import type {
  AgentCapability,
  AgentConnection,
  AllocationDecision,
} from "../../packages/contracts/index.js";

export const capabilityLabels: Record<AgentCapability, string> = {
  steer: "执行中追加",
  resume: "会话续接",
  approval: "授权交互",
  input: "文字输入",
};
export const assignable = (agent: AgentConnection) =>
  agent.selected && agent.available && agent.supported !== false;

interface Props {
  agents: AgentConnection[];
  targetAgentId: string;
  requiredCapabilities: AgentCapability[];
  locked: boolean;
  onAgentChange: (id: string) => void;
  onCapabilitiesChange: (values: AgentCapability[]) => void;
}
export function AllocationControls(props: Props) {
  const { t } = useI18n();
  const panelId = useId();
  if (props.locked) return null;
  const candidates = props.agents.filter(assignable);
  const selected = props.agents.find(
    (agent) => agent.id === props.targetAgentId,
  );
  const unavailable = Boolean(
    props.targetAgentId && (!selected || !assignable(selected)),
  );
  const overrides = [
    unavailable ? t("执行者不可用") : selected?.name,
    props.requiredCapabilities.length
      ? t("{count} 项能力", { count: props.requiredCapabilities.length })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const label = overrides
    ? t("本次发送选项：{options}", { options: overrides })
    : t("本次发送选项");
  return (
    <>
      <button
        type="button"
        className="button allocation-trigger"
        popoverTarget={panelId}
        aria-label={label}
        title={label}
        data-unavailable={unavailable || undefined}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M3 7h4m5 0h9M3 17h10m5 0h3" />
          <circle cx="9.5" cy="7" r="2.5" />
          <circle cx="15.5" cy="17" r="2.5" />
        </svg>
        {overrides && <span>{overrides}</span>}
      </button>
      <div
        id={panelId}
        popover="auto"
        className="allocation-panel"
        aria-label={t("本次发送选项")}
        role="group"
      >
        <label className="allocation-agent">
          <span>{t("执行者")}</span>
          <select
            aria-label={t("新任务执行者")}
            value={props.targetAgentId}
            onChange={(event) => props.onAgentChange(event.target.value)}
          >
            <option value="">{t("自动分配")}</option>
            {unavailable && (
              <option value={props.targetAgentId}>
                {selected?.name || props.targetAgentId} {t("· 已不可用")}
              </option>
            )}
            {candidates.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>{t("必需能力")}</legend>
          {(Object.keys(capabilityLabels) as AgentCapability[]).map(
            (capability) => (
              <label key={capability}>
                <input
                  type="checkbox"
                  checked={props.requiredCapabilities.includes(capability)}
                  onChange={(event) =>
                    props.onCapabilitiesChange(
                      event.target.checked
                        ? [...props.requiredCapabilities, capability]
                        : props.requiredCapabilities.filter(
                            (value) => value !== capability,
                          ),
                    )
                  }
                />
                {t(capabilityLabels[capability])}
              </label>
            ),
          )}
        </fieldset>
      </div>
    </>
  );
}
export function AllocationReason({
  allocation,
}: {
  allocation: AllocationDecision;
}) {
  const { t, locale } = useI18n();
  return (
    <section className="detail-section">
      <h3>{t("分配依据")}</h3>
      <p>{allocation.reason}</p>
      {allocation.requiredCapabilities.length > 0 && (
        <p className="small">
          {t("必需能力：")}
          {allocation.requiredCapabilities
            .map((capability) => t(capabilityLabels[capability]))
            .join(locale === "en" ? ", " : "、")}
        </p>
      )}
    </section>
  );
}
