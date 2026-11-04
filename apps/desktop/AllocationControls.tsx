import React from "react";
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
  const candidates = props.agents.filter(assignable);
  const unavailable =
    props.targetAgentId &&
    !candidates.some((agent) => agent.id === props.targetAgentId);
  return (
    <div className="allocation-controls">
      <label className="allocation-agent">
        <span className="small">执行者</span>
        <select
          aria-label="新任务执行者"
          value={props.locked ? "" : props.targetAgentId}
          disabled={props.locked}
          onChange={(event) => props.onAgentChange(event.target.value)}
        >
          <option value="">
            {props.locked ? "沿用原任务执行者" : "自动分配"}
          </option>
          {unavailable && (
            <option value={props.targetAgentId}>
              {props.agents.find((agent) => agent.id === props.targetAgentId)
                ?.name || props.targetAgentId}{" "}
              · 已不可用
            </option>
          )}
          {candidates.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <details className="allocation-requirements">
        <summary>
          必需能力
          {props.requiredCapabilities.length
            ? ` · ${props.requiredCapabilities.length}`
            : ""}
        </summary>
        <fieldset disabled={props.locked}>
          <legend>仅用于本条消息立即创建的新任务</legend>
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
                {capabilityLabels[capability]}
              </label>
            ),
          )}
          <p className="field-help">
            授权交互表示执行端能转交确认请求；实际操作仍遵循原生权限。
          </p>
        </fieldset>
      </details>
      {props.locked && (
        <span className="small">
          沿用原任务执行者，分配选项仅用于立即新任务。
        </span>
      )}
      {!props.locked && unavailable && (
        <span className="form-error" role="status">
          所选执行者已不可用，请重新选择。
        </span>
      )}
    </div>
  );
}
export function AllocationReason({
  allocation,
}: {
  allocation: AllocationDecision;
}) {
  return (
    <section className="detail-section">
      <h3>分配依据</h3>
      <p>{allocation.reason}</p>
      {allocation.requiredCapabilities.length > 0 && (
        <p className="small">
          必需能力：
          {allocation.requiredCapabilities
            .map((capability) => capabilityLabels[capability])
            .join("、")}
        </p>
      )}
    </section>
  );
}
