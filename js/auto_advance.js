// XiangWriter 连播状态机的纯函数辅助模块。
// 保持无浏览器依赖，便于用 Node.js 单元测试队列/历史兼容逻辑。

export const AUTO_STATE_VERSION = 2;

export function eventDetail(event) {
  if (!event) return {};
  return event.detail && typeof event.detail === "object" ? event.detail : event;
}

export function promptIdFromQueueResult(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const found = promptIdFromQueueResult(value[i]);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    const direct = value.prompt_id || value.promptId || value.id;
    if (typeof direct === "string" && direct) return direct;
    for (const key of ["result", "results", "response", "responses", "data"]) {
      const found = promptIdFromQueueResult(value[key]);
      if (found) return found;
    }
  }
  return "";
}

function planUnitFromPromptNode(promptNode) {
  if (!promptNode || !promptNode.inputs) return "";
  const raw = promptNode.inputs.plan;
  if (raw && typeof raw === "object") return String(raw.unit_name || "");
  if (typeof raw !== "string" || !raw.trim()) return "";
  try {
    return String(JSON.parse(raw).unit_name || "");
  } catch (_) {
    return "";
  }
}

export function findQueuedPromptId(queuePayload, nodeId, unitName) {
  const candidates = [];
  for (const key of ["queue_running", "queue_pending"]) {
    for (const item of (queuePayload && queuePayload[key]) || []) {
      if (!Array.isArray(item) || !item[1] || !item[2]) continue;
      const prompt = item[2];
      const direct = prompt[String(nodeId)];
      const director = direct || Object.values(prompt).find((entry) => {
        return entry && (entry.class_type === "XWComicDirector" || entry.class_type === "XWSeriesSource");
      });
      if (!director) continue;
      const queuedUnit = planUnitFromPromptNode(director);
      if (unitName && queuedUnit && queuedUnit !== String(unitName)) continue;
      candidates.push({ number: Number(item[0]) || 0, promptId: String(item[1]) });
    }
  }
  candidates.sort((a, b) => b.number - a.number);
  return candidates.length ? candidates[0].promptId : "";
}

export function historyOutcome(historyPayload, promptId) {
  const entry = historyPayload && historyPayload[String(promptId)];
  if (!entry) return { state: "missing", detail: null };
  const status = entry.status || {};
  const messages = Array.isArray(status.messages) ? status.messages : [];
  let success = null;
  let error = null;
  for (const message of messages) {
    if (!Array.isArray(message)) continue;
    if (message[0] === "execution_success") success = message[1] || {};
    if (message[0] === "execution_error") error = message[1] || {};
  }
  if (error || status.status_str === "error") return { state: "error", detail: error || status };
  if (success || status.completed || status.status_str === "success") {
    return { state: "success", detail: success || status };
  }
  return { state: "pending", detail: status };
}

export function isTransientExecutionError(detail) {
  const nodeType = String((detail && detail.node_type) || "");
  const message = String((detail && detail.exception_message) || "");
  if (nodeType === "TD_MiniMax_H3_Prompt") {
    return /拒绝|连接|超时|timeout|timed out|空内容|empty|temporar|429|50[0-9]/i.test(message);
  }
  return /connection reset|connection refused|temporar(?:y|ily)|timed?\s*out|http\s*50[0-9]/i.test(message);
}

export function compactAutoPlan(plan) {
  const fields = [
    "ok", "episode_name", "episode_index_actual", "episode_count",
    "segment_mode", "segment_name", "segment_index_actual", "segment_count", "unit_name",
  ];
  const compact = {};
  for (const field of fields) {
    if (plan && plan[field] !== undefined) compact[field] = plan[field];
  }
  return compact;
}
