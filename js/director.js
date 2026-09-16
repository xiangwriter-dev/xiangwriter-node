// XiangWriter 漫剧导演：前端扩展
// 功能：分析本集(agent) / 运行本集 / 逐集连播 / 停止连播 / 忽略节点 / 剧本注入提示词节点
import { app } from "../../scripts/app.js";
import {
  collectAutoIgnoredNodeIds,
  enabledOutputNodes,
  getGraphLink,
  isOutputNode,
  isVirtualGetter,
  normalizeUsedSlots,
  updateBypassModes,
} from "./slot_ignore.js";
import {
  AUTO_STATE_VERSION,
  compactAutoPlan,
  eventDetail,
  findQueuedPromptId,
  historyOutcome,
  isTransientExecutionError,
  promptIdFromQueueResult,
} from "./auto_advance.js";

const NODE_CLASS = "XWComicDirector";
const XW_NODE_CLASSES = new Set([
  NODE_CLASS,
  "XWSeriesSource",
  "XWAgentPlanner",
  "XWReferenceLoader",
]);

const INPUT_LABELS = {
  root_dir: "系列根目录",
  episode_index: "集序号",
  segment_mode: "启用分段模式",
  segment_index: "段序号",
  script_file: "剧本文件名",
  image_pattern: "图片匹配规则",
  max_images: "最大参考图数",
  plan: "规划结果",
  source_json: "素材数据",
  llm_api_base: "LLM 接口地址",
  llm_api_key: "LLM 密钥",
  llm_model: "LLM 模型",
  llm_vision: "启用多模态看图",
  llm_system_prompt: "Agent 系统提示词",
  workflow_nodes_json: "工作流节点清单",
  plan_override: "预设规划",
  prompt_target: "提示词目标节点",
  prompt_widget: "提示词输入口名称",
};

const OUTPUT_LABELS = {
  images_batch: "参考图批次",
  script: "剧本文本",
  episode_name: "集名称",
  segment_name: "段名称",
  unit_name: "当前单位名称",
  episode_count: "总集数",
  segment_count: "当前集段数",
  source_json: "素材数据",
  status: "状态",
  plan: "规划结果",
  prompt: "生成提示词",
  ignored_json: "忽略节点列表",
  llm_used: "已使用 LLM",
  load_info: "加载信息",
  agent_prompt: "Agent 提示词",
  plan_out: "加载结果",
  duration_seconds: "场景时长(秒)",
};
for (let i = 1; i <= 9; i++) OUTPUT_LABELS["image_" + i] = "参考图 " + i;

const AUTO_STORAGE_PREFIX = "xiangwriter.autoAdvance.v2:";
const AUTO_POLL_MS = 30000;
const AUTO_STALL_WARNING_MS = 90 * 60 * 1000;
const AUTO_TRANSIENT_RETRIES = 2;
const AUTO_RETRY_DELAY_MS = 15000;

let autoState = null;

function getWidget(node, name) {
  const ws = node.widgets || [];
  for (let i = 0; i < ws.length; i++) if (ws[i].name === name) return ws[i];
  return null;
}

function nodeClass(node) {
  return String((node && (node.comfyClass || node.type)) || "");
}

function connectedNodes(sourceNode, targetClass, inputName = "source_json") {
  const graph = app.graph;
  const all = (graph && graph._nodes) || [];
  const candidates = all.filter((n) => nodeClass(n) === targetClass);
  const direct = candidates.filter((n) => {
    const input = (n.inputs || []).find((item) => item.name === inputName);
    const link = input && input.link != null ? getGraphLink(graph, input.link) : null;
    return link && String(link.origin_id) === String(sourceNode.id);
  });
  // 旧工作流可能没有保存完整的连线元数据；只有一个候选时可安全兜底。
  return direct.length ? direct : candidates.length === 1 ? candidates : [];
}

function plannerFor(node) {
  if (nodeClass(node) === NODE_CLASS) return null;
  return connectedNodes(node, "XWAgentPlanner")[0] || null;
}

function imageSourcesFor(node) {
  if (nodeClass(node) === NODE_CLASS) return [node];
  return connectedNodes(node, "XWReferenceLoader");
}

function planWidgetFor(node) {
  if (nodeClass(node) === NODE_CLASS) return getWidget(node, "plan");
  const planner = plannerFor(node);
  return planner ? getWidget(planner, "plan_override") : null;
}

function applyChineseLabels(node) {
  for (const widget of node.widgets || []) {
    if (INPUT_LABELS[widget.name]) widget.label = INPUT_LABELS[widget.name];
  }
  for (const input of node.inputs || []) {
    if (INPUT_LABELS[input.name]) input.localized_name = INPUT_LABELS[input.name];
  }
  for (const output of node.outputs || []) {
    if (OUTPUT_LABELS[output.name]) output.localized_name = OUTPUT_LABELS[output.name];
  }
}

function notify(msg) {
  try {
    if (app.ui && app.ui.dialog && app.ui.dialog.show) app.ui.dialog.show(msg);
    else alert(msg);
  } catch (e) {
    console.warn("[xiangwriter]", msg, e);
  }
}

function rootDirFor(node) {
  return String((getWidget(node, "root_dir") || {}).value || "").trim();
}

function autoStorageKey(node) {
  const raw = [nodeClass(node), String(node.id), rootDirFor(node)].join("|");
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return AUTO_STORAGE_PREFIX + (hash >>> 0).toString(16);
}

function readPlanWidget(node) {
  try {
    const widget = planWidgetFor(node);
    const parsed = JSON.parse(String((widget && widget.value) || ""));
    return parsed && parsed.ok ? parsed : null;
  } catch (_) {
    return null;
  }
}

function saveAutoState() {
  if (!autoState || !autoState.node) return;
  const payload = {
    version: AUTO_STATE_VERSION,
    active: true,
    nodeId: String(autoState.node.id),
    nodeClass: nodeClass(autoState.node),
    rootDir: rootDirFor(autoState.node),
    lastPlan: compactAutoPlan(autoState.lastPlan),
    promptId: String(autoState.promptId || ""),
    queuedAt: Number(autoState.queuedAt || Date.now()),
    retryCount: Number(autoState.retryCount || 0),
    stallWarned: !!autoState.stallWarned,
    updatedAt: Date.now(),
  };
  const key = autoStorageKey(autoState.node);
  autoState.storageKey = key;
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (error) {
    console.warn("[xiangwriter] 无法保存连播恢复状态", error);
  }
}

function clearPersistedState(node, knownKey = "") {
  try {
    if (knownKey) localStorage.removeItem(knownKey);
    if (!node) return;
    const nodeId = String(node.id);
    const rootDir = rootDirFor(node);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(AUTO_STORAGE_PREFIX)) continue;
      try {
        const saved = JSON.parse(localStorage.getItem(key) || "null");
        if (saved && String(saved.nodeId) === nodeId && String(saved.rootDir || "") === rootDir) {
          localStorage.removeItem(key);
        }
      } catch (_) {
        localStorage.removeItem(key);
      }
    }
  } catch (error) {
    console.warn("[xiangwriter] 无法清理连播恢复状态", error);
  }
}

function loadPersistedState(node) {
  try {
    const saved = JSON.parse(localStorage.getItem(autoStorageKey(node)) || "null");
    if (!saved || saved.version !== AUTO_STATE_VERSION || !saved.active) return null;
    if (String(saved.nodeId) !== String(node.id)) return null;
    if (String(saved.rootDir || "") !== rootDirFor(node)) return null;
    return saved;
  } catch (error) {
    console.warn("[xiangwriter] 无法读取连播恢复状态", error);
    return null;
  }
}

async function fetchApiJson(path) {
  const response = app.api && typeof app.api.fetchApi === "function"
    ? await app.api.fetchApi(path, { cache: "no-store" })
    : await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(path + " 返回 HTTP " + response.status);
  return await response.json();
}

function collectNodeTitles() {
  const nodes = (app.graph && app.graph._nodes) || [];
  return nodes.map((n) => n.title || n.type || String(n.id));
}

function readCfg(node) {
  const planner = plannerFor(node);
  const g = (n, d) => {
    const w = getWidget(node, n);
    if (w) return w.value;
    const pw = planner && getWidget(planner, n === "plan" ? "plan_override" : n);
    return pw ? pw.value : d;
  };
  return {
    root_dir: String(g("root_dir", "")),
    episode_index: Number(g("episode_index", 1)),
    segment_mode: !!g("segment_mode", false),
    segment_index: Number(g("segment_index", 1)),
    script_file: String(g("script_file", "剧本.txt")),
    image_pattern: String(g("image_pattern", "*.png")),
    max_images: Number(g("max_images", 9)),
    plan: String(g("plan", "")),
    nodes: collectNodeTitles(),
    llm: {
      api_base: String(g("llm_api_base", "")),
      api_key: String(g("llm_api_key", "")),
      model: String(g("llm_model", "")),
      vision: !!g("llm_vision", true),
      system_prompt: String(g("llm_system_prompt", "")),
    },
  };
}

async function doAnalyze(node) {
  const cfg = readCfg(node);
  let resp = null;
  try {
    resp = await fetch("/xiangwriter/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
  } catch (e) {
    notify("无法连接 ComfyUI 后端（/xiangwriter/analyze）：" + e.message);
    return null;
  }
  if (!resp.ok) {
    notify("analyze 请求失败：" + resp.status);
    return null;
  }
  let plan = null;
  try {
    plan = await resp.json();
  } catch (e) {
    notify("analyze 响应解析失败");
    return null;
  }
  if (!plan || !plan.ok) {
    notify("分析失败：" + ((plan && plan.message) || "未知错误"));
    return null;
  }
  // 存紧凑 plan 到 widget（去掉大段剧本原文，避免工作流文件过大）
  const w = planWidgetFor(node);
  if (w) {
    const compact = Object.assign({}, plan);
    delete compact.script;
    w.value = JSON.stringify(compact, null, 2);
    if (app.graph) app.graph.setDirtyCanvas(true, true);
  }
  return plan;
}

// 合并 LLM 指定节点与“未使用图片槽位”自动追踪结果，并恢复上一段不再需要忽略的节点。
function applyIgnore(node, ignored, autoIgnoredIds = new Set()) {
  const set = new Set((ignored || []).map(String));
  const autoIds = new Set([...autoIgnoredIds].map(String));
  // 记录原始 mode；这样插件不会把用户原本手工 bypass 的节点错误恢复为 always。
  if (!(node._xwIgnored instanceof Map)) node._xwIgnored = new Map();
  const all = (app.graph && app.graph._nodes) || [];
  const desiredIds = new Set([...autoIgnoredIds].map(String));
  for (let i = 0; i < all.length; i++) {
    const n = all[i];
    if (n === node) continue;
    if (XW_NODE_CLASSES.has(nodeClass(n))) continue;
    const key = String(n.title || n.type || n.id);
    const want = set.has(key) || set.has(String(n.id));
    if (want) desiredIds.add(String(n.id));
  }
  desiredIds.delete(String(node.id));
  // LLM 不能关闭输出节点；但自动槽位追踪可以关闭只属于缺图分支的输出节点，
  // 避免 PreviewImage 收到 None。Use Everywhere GetNode 始终保持启用。
  for (const protectedNode of all.filter((n) => isOutputNode(n) || isVirtualGetter(n))) {
    const id = String(protectedNode.id);
    if (isVirtualGetter(protectedNode) || !autoIds.has(id)) desiredIds.delete(id);
  }
  updateBypassModes(all.filter((n) => n !== node), node._xwIgnored, desiredIds, 4);
  if (app.graph) app.graph.setDirtyCanvas(true, true);
  return desiredIds;
}

function usedSlotsFromPlan(plan) {
  return normalizeUsedSlots(((plan && plan.slots) || []).map((item) => item && item.slot), 9);
}

function applyPlanIgnore(node, plan) {
  const usedSlots = usedSlotsFromPlan(plan);
  const autoIgnored = new Set();
  for (const source of imageSourcesFor(node)) {
    for (const id of collectAutoIgnoredNodeIds(app.graph, source, usedSlots, 9)) {
      autoIgnored.add(String(id));
    }
  }
  const desired = applyIgnore(node, (plan && plan.ignored) || [], autoIgnored);
  node._xwLastAutoIgnored = autoIgnored;
  node._xwLastUsedSlots = usedSlots;
  return { autoIgnored: autoIgnored, desired: desired };
}

async function ensureRunnableOutput(node) {
  const all = (app.graph && app.graph._nodes) || [];

  // 清理旧版插件可能遗留的“本插件拥有的输出节点 bypass”。
  if (node._xwIgnored instanceof Map) {
    for (const output of all.filter(isOutputNode)) {
      const id = String(output.id);
      if (!node._xwIgnored.has(id)) continue;
      output.mode = node._xwIgnored.get(id);
      node._xwIgnored.delete(id);
    }
  }

  const enabled = enabledOutputNodes(all);
  if (!enabled.length) {
    notify(
      "无法运行：当前工作流没有启用的输出节点。请至少启用一个“保存图像 / 预览图像 / 视频合成”节点后再运行。"
    );
    return [];
  }

  // 检查 graphToPrompt 的真实结果，而不只看画布 mode。Use Everywhere 等扩展
  // 会在转换阶段重写虚拟连线；画布上输出节点亮着，不代表提交内容一定含输出。
  let built = null;
  try {
    built = await app.graphToPrompt(app.rootGraph || app.graph);
  } catch (error) {
    console.error("[xiangwriter] graphToPrompt 预检失败", error);
    notify("工作流转换失败：" + (error && error.message ? error.message : String(error)));
    return [];
  }
  const prompt = (built && built.output) || {};
  const enabledById = new Map(enabled.map((output) => [String(output.id), output]));
  const enabledTypes = new Map(enabled.map((output) => [nodeClass(output), output]));
  const serialized = [];
  for (const [id, data] of Object.entries(prompt)) {
    const byId = enabledById.get(String(id));
    const byType = enabledTypes.get(String((data && data.class_type) || ""));
    const output = byId || byType;
    if (output && !serialized.includes(output)) serialized.push(output);
  }
  if (serialized.length) return serialized;

  console.warn(
    "[xiangwriter] graphToPrompt 未生成输出节点",
    "画布输出:", enabled.map((output) => ({ id: output.id, type: nodeClass(output), mode: output.mode })),
    "API Prompt 节点:", Object.keys(prompt)
  );
  notify(
    "工作流转换后没有可执行输出。已停止连播；请检查 Use Everywhere 的 Set/Get 虚拟端口是否被手动关闭。"
  );
  return [];
}

function planMatchesWidgets(node, plan) {
  if (!plan || !plan.ok) return false;
  const episode = Number((getWidget(node, "episode_index") || {}).value || 1);
  const segmentMode = !!((getWidget(node, "segment_mode") || {}).value || false);
  const segment = Number((getWidget(node, "segment_index") || {}).value || 1);
  const expectedEpisode = plan.episode_count
    ? Math.max(1, Math.min(episode, Number(plan.episode_count)))
    : episode;
  const expectedSegment = plan.segment_count
    ? Math.max(1, Math.min(segment, Number(plan.segment_count)))
    : segment;
  if (plan.episode_index_actual != null && Number(plan.episode_index_actual) !== expectedEpisode) return false;
  if (plan.segment_mode != null && !!plan.segment_mode !== segmentMode) return false;
  if (segmentMode && plan.segment_index_actual != null && Number(plan.segment_index_actual) !== expectedSegment) return false;
  return true;
}

function installBeforeQueueIgnore(node) {
  // 一体节点监听 plan；拆分节点监听稳定存在的根目录控件，并在排队时动态读取规划器。
  const widget = nodeClass(node) === NODE_CLASS
    ? getWidget(node, "plan")
    : getWidget(node, "root_dir");
  if (!widget || widget._xwBeforeQueueInstalled) return;
  widget._xwBeforeQueueInstalled = true;
  const previous = widget.beforeQueued;
  widget.beforeQueued = function () {
    if (typeof previous === "function") previous.apply(this, arguments);
    let plan = null;
    try {
      const planWidget = planWidgetFor(node);
      plan = JSON.parse(String((planWidget && planWidget.value) || ""));
    } catch (_) {
      plan = null;
    }
    if (planMatchesWidgets(node, plan)) applyPlanIgnore(node, plan);
    else applyIgnore(node, [], new Set());
  };
}

// 剧本/提示词注入到工作流中的提示词节点（prompt_target.prompt_widget）
function injectPrompt(node, text) {
  const targetTitle = String((getWidget(node, "prompt_target") || {}).value || "").trim();
  const widgetName = String((getWidget(node, "prompt_widget") || {}).value || "text").trim();
  if (!targetTitle) return false;
  const all = (app.graph && app.graph._nodes) || [];
  const target = all.find((n) => (n.title || n.type) === targetTitle);
  if (!target) return false;
  const w = (target.widgets || []).find((x) => x.name === widgetName);
  if (!w) return false;
  w.value = text;
  if (app.graph) app.graph.setDirtyCanvas(true, true);
  return true;
}

async function queueRun(node, plan) {
  const text = plan.prompt || plan.script || "";
  const injected = injectPrompt(node, text);
  const target = String((getWidget(node, "prompt_target") || {}).value || "").trim();
  if (target && !injected) {
    notify("未找到提示词目标节点或参数，将继续使用工作流原有提示词：" + target);
  }
  const ignoredState = applyPlanIgnore(node, plan);
  console.info(
    "[xiangwriter] 使用槽位:", [...usedSlotsFromPlan(plan)],
    "自动忽略节点:", [...ignoredState.autoIgnored]
  );
  const outputs = await ensureRunnableOutput(node);
  if (!outputs.length) return false;
  console.info(
    "[xiangwriter] 已启用输出节点:",
    outputs.map((output) => String(output.title || output.type || output.id))
  );
  try {
    // ComfyUI 0.32.0：第三个参数是部分执行节点 ID 数组；完整运行时必须省略。
    const queuedAt = Date.now();
    const result = await app.queuePrompt(0, 1);
    let promptId = promptIdFromQueueResult(result);
    if (!promptId) {
      try {
        const queue = await fetchApiJson("/queue");
        promptId = findQueuedPromptId(queue, node.id, plan.unit_name);
      } catch (error) {
        console.warn("[xiangwriter] 入队成功，但暂时无法解析 prompt_id", error);
      }
    }
    return { promptId: promptId, queuedAt: queuedAt };
  } catch (e) {
    notify("入队失败：" + (e && e.message ? e.message : String(e)));
    return null;
  }
}

async function attachToQueuedUnit(node) {
  const plan = readPlanWidget(node);
  if (!plan || !plan.unit_name) return false;
  try {
    const queue = await fetchApiJson("/queue");
    const promptId = findQueuedPromptId(queue, node.id, plan.unit_name);
    if (!promptId) return false;
    let queuedAt = Date.now();
    for (const key of ["queue_running", "queue_pending"]) {
      const item = ((queue && queue[key]) || []).find((entry) => {
        return Array.isArray(entry) && String(entry[1] || "") === String(promptId);
      });
      if (item && item[3] && Number(item[3].create_time)) queuedAt = Number(item[3].create_time);
    }
    startAutoAdvance(node, plan, { promptId: promptId, queuedAt: queuedAt, announce: false });
    scheduleReconcile(250);
    notify("已接管正在运行的「" + plan.unit_name + "」，完成后将继续连播，不会重复入队。");
    return true;
  } catch (error) {
    console.warn("[xiangwriter] 检查现有队列失败，将按正常流程入队", error);
    return false;
  }
}

async function runEpisode(node, loopAll) {
  stopAutoAdvance();
  if (loopAll && await attachToQueuedUnit(node)) return true;
  const plan = await doAnalyze(node);
  if (!plan) return null;
  if (loopAll) startAutoAdvance(node, plan, { announce: false });
  const queued = await queueRun(node, plan);
  if (!queued) {
    if (loopAll) stopAutoAdvance();
    notify("入队失败：请检查工作流是否有输出节点（Save Image / Preview）");
    return null;
  }
  if (loopAll && autoState) {
    autoState.promptId = queued.promptId;
    autoState.queuedAt = queued.queuedAt;
    autoState.retryCount = 0;
    saveAutoState();
    scheduleReconcile(queued.promptId ? AUTO_POLL_MS : 1000);
    notify("已开始逐集连播，刷新或断线后会自动恢复；点击「⏸ 停止连播」可中断");
  }
  return true;
}

function addAutoListeners(state) {
  state.successHandler = (event) => {
    const detail = eventDetail(event);
    if (!autoState || !autoState.promptId) return;
    if (String(detail.prompt_id || "") !== String(autoState.promptId)) return;
    completeCurrentPrompt(detail);
  };
  state.errorHandler = (event) => {
    const detail = eventDetail(event);
    if (!autoState || !autoState.promptId) return;
    if (String(detail.prompt_id || "") !== String(autoState.promptId)) return;
    failCurrentPrompt(detail);
  };
  state.reconnectedHandler = () => scheduleReconcile(250);
  state.visibilityHandler = () => {
    if (!document.hidden) scheduleReconcile(250);
  };
  app.api.addEventListener("execution_success", state.successHandler);
  app.api.addEventListener("execution_error", state.errorHandler);
  app.api.addEventListener("reconnected", state.reconnectedHandler);
  document.addEventListener("visibilitychange", state.visibilityHandler);
}

function startAutoAdvance(node, firstPlan, options = {}) {
  stopAutoAdvance();
  autoState = {
    node: node,
    lastPlan: firstPlan,
    promptId: String(options.promptId || ""),
    queuedAt: Number(options.queuedAt || Date.now()),
    retryCount: Number(options.retryCount || 0),
    stallWarned: !!options.stallWarned,
    busy: false,
    successHandler: null,
    errorHandler: null,
    reconnectedHandler: null,
    visibilityHandler: null,
    reconcileTimer: null,
    retryTimer: null,
    storageKey: "",
  };
  addAutoListeners(autoState);
  saveAutoState();
  scheduleReconcile(AUTO_POLL_MS);
  if (options.announce !== false) {
    notify("已恢复逐集连播，将从「" + (firstPlan.unit_name || "当前单位") + "」继续");
  }
}

function scheduleReconcile(delay = AUTO_POLL_MS) {
  if (!autoState) return;
  if (autoState.reconcileTimer) clearTimeout(autoState.reconcileTimer);
  autoState.reconcileTimer = setTimeout(() => {
    if (!autoState) return;
    autoState.reconcileTimer = null;
    reconcileAutoState().catch((error) => {
      console.warn("[xiangwriter] 连播状态对账失败", error);
      scheduleReconcile(AUTO_POLL_MS);
    });
  }, Math.max(0, delay));
}

async function completeCurrentPrompt() {
  if (!autoState || autoState.busy) return;
  autoState.busy = true;
  autoState.promptId = "";
  autoState.retryCount = 0;
  saveAutoState();
  try {
    await advanceOnce();
  } catch (error) {
    console.error("[xiangwriter] 连播推进失败", error);
    stopAutoAdvance();
    notify("连播已停止：推进下一段/集失败：" + (error && error.message ? error.message : String(error)));
    return;
  }
  if (autoState) {
    autoState.busy = false;
    scheduleReconcile(AUTO_POLL_MS);
  }
}

function executionErrorText(detail) {
  const node = [detail && detail.node_id, detail && detail.node_type].filter(Boolean).join("/");
  const message = String((detail && detail.exception_message) || "未知执行错误").trim().split(/\r?\n/)[0];
  return (node ? "节点 " + node + "：" : "") + message;
}

async function retryCurrentPrompt(detail) {
  if (!autoState) return;
  const state = autoState;
  state.retryCount += 1;
  state.promptId = "";
  state.busy = true;
  saveAutoState();
  notify(
    "当前单位遇到临时接口错误，" + Math.round(AUTO_RETRY_DELAY_MS / 1000) + " 秒后自动重试（" +
    state.retryCount + "/" + AUTO_TRANSIENT_RETRIES + "）：" + executionErrorText(detail)
  );
  if (state.retryTimer) clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(async () => {
    if (!autoState || autoState !== state) return;
    state.retryTimer = null;
    const livePlan = readPlanWidget(state.node);
    if (livePlan && livePlan.unit_name === state.lastPlan.unit_name) state.lastPlan = livePlan;
    const queued = await queueRun(state.node, state.lastPlan);
    if (!autoState || autoState !== state) return;
    if (!queued) {
      stopAutoAdvance();
      notify("连播已停止：临时错误自动重试入队失败。");
      return;
    }
    state.promptId = queued.promptId;
    state.queuedAt = queued.queuedAt;
    state.stallWarned = false;
    state.busy = false;
    saveAutoState();
    scheduleReconcile(queued.promptId ? AUTO_POLL_MS : 1000);
  }, AUTO_RETRY_DELAY_MS);
}

function failCurrentPrompt(detail) {
  if (!autoState || autoState.busy) return;
  if (isTransientExecutionError(detail) && autoState.retryCount < AUTO_TRANSIENT_RETRIES) {
    retryCurrentPrompt(detail).catch((error) => {
      console.error("[xiangwriter] 自动重试失败", error);
      stopAutoAdvance();
    });
    return;
  }
  const text = executionErrorText(detail);
  stopAutoAdvance();
  notify("连播已停止：当前段/集执行失败。" + text);
}

async function reconcileAutoState() {
  if (!autoState || autoState.busy) {
    if (autoState) scheduleReconcile(AUTO_POLL_MS);
    return;
  }
  const state = autoState;
  let queue = null;
  try {
    queue = await fetchApiJson("/queue");
  } catch (error) {
    console.warn("[xiangwriter] 读取队列失败", error);
  }

  if (!state.promptId && queue) {
    state.promptId = findQueuedPromptId(queue, state.node.id, state.lastPlan.unit_name);
    if (state.promptId) saveAutoState();
  }
  if (!state.promptId) {
    scheduleReconcile(AUTO_POLL_MS);
    return;
  }

  const queuedIds = new Set();
  for (const key of ["queue_running", "queue_pending"]) {
    for (const item of (queue && queue[key]) || []) {
      if (Array.isArray(item) && item[1]) queuedIds.add(String(item[1]));
    }
  }
  if (queuedIds.has(String(state.promptId))) {
    if (!state.stallWarned && Date.now() - state.queuedAt >= AUTO_STALL_WARNING_MS) {
      state.stallWarned = true;
      saveAutoState();
      notify("连播监控：当前单位已运行超过 90 分钟，仍在队列中；插件会继续监控，不会误提交下一段。");
    }
    scheduleReconcile(AUTO_POLL_MS);
    return;
  }

  const history = await fetchApiJson("/history/" + encodeURIComponent(state.promptId));
  if (!autoState || autoState !== state) return;
  const outcome = historyOutcome(history, state.promptId);
  if (outcome.state === "success") {
    await completeCurrentPrompt(outcome.detail);
    return;
  }
  if (outcome.state === "error") {
    failCurrentPrompt(outcome.detail || {});
    return;
  }
  scheduleReconcile(AUTO_POLL_MS);
}

async function advanceOnce() {
  if (!autoState) return;
  const node = autoState.node;
  const epW = getWidget(node, "episode_index");
  const segW = getWidget(node, "segment_index");
  if (!epW) {
    stopAutoAdvance();
    return;
  }
  // 1) 使用刚执行时保存的规划，避免每个单位完成后重复调用一次 LLM。
  const cur = autoState.lastPlan;
  const segMode = !!cur.segment_mode;
  const segC = cur.segment_count || 0;
  const lastEp = cur.episode_index_actual >= cur.episode_count;
  const lastSeg = !segMode || cur.segment_index_actual >= segC;
  if (lastEp && lastSeg) {
    stopAutoAdvance();
    notify(
      "连播结束：已处理完「" + cur.unit_name + "」（共 " + cur.episode_count + " 集" +
      (segMode ? "，" + cur.segment_count + " 段" : "") + "）"
    );
    return;
  }
  // 2) 推进：分段模式下同集下一段；段跑完则下一集第 1 段
  if (segMode && segC > 1 && cur.segment_index_actual < segC) {
    if (segW) segW.value = cur.segment_index_actual + 1;
  } else {
    epW.value = cur.episode_index_actual + 1;
    if (segW) segW.value = 1;
  }
  // 3) 重新分析并运行
  const plan = await doAnalyze(node);
  if (!plan) {
    stopAutoAdvance();
    return;
  }
  if (plan.unit_name === cur.unit_name) {
    // 没有前进（analyze 把越界序号钳制回最后一单位）→ 全部跑完
    stopAutoAdvance();
    notify("连播结束：已处理完所有单位（" + plan.unit_name + "）");
    return;
  }
  autoState.lastPlan = plan;
  const queued = await queueRun(node, plan);
  if (!queued) {
    stopAutoAdvance();
    return;
  }
  if (!autoState) return;
  autoState.promptId = queued.promptId;
  autoState.queuedAt = queued.queuedAt;
  autoState.retryCount = 0;
  autoState.stallWarned = false;
  saveAutoState();
  scheduleReconcile(queued.promptId ? AUTO_POLL_MS : 1000);
}

function stopAutoAdvance(options = {}) {
  const state = autoState;
  if (!state) return;
  if (state.successHandler) app.api.removeEventListener("execution_success", state.successHandler);
  if (state.errorHandler) app.api.removeEventListener("execution_error", state.errorHandler);
  if (state.reconnectedHandler) app.api.removeEventListener("reconnected", state.reconnectedHandler);
  if (state.visibilityHandler) document.removeEventListener("visibilitychange", state.visibilityHandler);
  if (state.reconcileTimer) clearTimeout(state.reconcileTimer);
  if (state.retryTimer) clearTimeout(state.retryTimer);
  autoState = null;
  if (options.clearPersisted !== false) clearPersistedState(state.node, state.storageKey);
}

function restoreAutoAdvance(node) {
  if (autoState || node._xwAutoRestoreAttempted) return;
  if (!rootDirFor(node)) return;
  node._xwAutoRestoreAttempted = true;
  const saved = loadPersistedState(node);
  if (!saved) return;
  const widgetPlan = readPlanWidget(node);
  const savedPlan = saved.lastPlan || {};
  const plan = widgetPlan && (!savedPlan.unit_name || widgetPlan.unit_name === savedPlan.unit_name)
    ? Object.assign({}, widgetPlan, savedPlan)
    : savedPlan;
  if (!plan || !plan.unit_name) {
    clearPersistedState(node);
    return;
  }
  startAutoAdvance(node, plan, {
    promptId: saved.promptId,
    queuedAt: saved.queuedAt,
    retryCount: saved.retryCount,
    stallWarned: saved.stallWarned,
    announce: true,
  });
  scheduleReconcile(250);
}

app.registerExtension({
  name: "xiangwriter.director",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!XW_NODE_CLASSES.has(nodeData.name)) return;
    const isAutoControl = nodeData.name === NODE_CLASS || nodeData.name === "XWSeriesSource";
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      if (onConfigure) onConfigure.apply(this, arguments);
      if (isAutoControl) setTimeout(() => restoreAutoAdvance(this), 0);
    };
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      if (onNodeCreated) onNodeCreated.apply(this, arguments);
      applyChineseLabels(this);
      if (!isAutoControl) return;
      const that = this;
      installBeforeQueueIgnore(that);
      this.addWidget("button", "🔍 分析当前段/集（agent）", null, function () {
        doAnalyze(that).then(function (plan) {
          if (plan) notify("分析完成：" + plan.message);
        });
      });
      this.addWidget("button", "▶ 运行当前段/集", null, function () {
        runEpisode(that, false);
      });
      this.addWidget("button", "⏭ 连播剩余全部（段/集）", null, function () {
        runEpisode(that, true);
      });
      this.addWidget("button", "⏸ 停止连播", null, function () {
        stopAutoAdvance();
        clearPersistedState(that);
        notify("已停止连播");
      });
      setTimeout(() => restoreAutoAdvance(that), 250);
    };
  },
});
