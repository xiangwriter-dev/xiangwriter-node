// XiangWriter 未使用图片槽位分支追踪（无 ComfyUI 依赖，便于单元测试）。

function nodeId(node) {
  return node == null || node.id == null ? "" : String(node.id);
}

const OUTPUT_NODE_FALLBACKS = new Set([
  "SaveImage",
  "PreviewImage",
  "VHS_VideoCombine",
  "ShowText|pysssss",
]);

function nodeClass(node) {
  return String((node && (node.comfyClass || node.type)) || "");
}

// ComfyUI 的后端节点定义以 output_node 标记输出节点；部分第三方节点或旧版
// 前端没有把该字段完整挂到实例上，因此为常用输出节点保留兼容名单。
export function isOutputNode(node) {
  const nodeData = (node && node.constructor && node.constructor.nodeData)
    || (node && node.nodeData)
    || {};
  return nodeData.output_node === true
    || nodeData.outputNode === true
    || OUTPUT_NODE_FALLBACKS.has(nodeClass(node));
}

export function isVirtualGetter(node) {
  return nodeClass(node) === "GetNode";
}

export function enabledOutputNodes(nodes) {
  return (nodes || []).filter((node) => {
    const mode = node && node.mode == null ? 0 : Number(node.mode);
    return isOutputNode(node) && mode === 0;
  });
}

function getNode(graph, id) {
  if (!graph || id == null) return null;
  if (typeof graph.getNodeById === "function") return graph.getNodeById(id);
  const nodes = graph._nodes || [];
  return nodes.find((node) => String(node.id) === String(id)) || null;
}

export function getGraphLink(graph, linkId) {
  if (!graph || linkId == null) return null;
  const links = graph.links || graph._links;
  if (!links) return null;

  // ComfyUI 0.30.0 的不同前端版本存在两种结构：
  // 旧版 LiteGraph 使用普通对象，新版 comfyui_frontend_package 使用 Map。
  if (typeof links.get === "function") {
    return links.get(linkId)
      || links.get(String(linkId))
      || (Number.isNaN(Number(linkId)) ? null : links.get(Number(linkId)))
      || null;
  }
  return links[linkId] || links[String(linkId)] || null;
}

function targetsFromOutput(graph, node, outputIndex) {
  const output = (node && node.outputs && node.outputs[outputIndex]) || null;
  const result = [];
  for (const linkId of (output && output.links) || []) {
    const link = getGraphLink(graph, linkId);
    const target = link ? getNode(graph, link.target_id) : null;
    if (target) result.push(target);
  }
  return result;
}

function targetsFromNode(graph, node) {
  const result = [];
  for (let index = 0; index < ((node && node.outputs) || []).length; index++) {
    result.push(...targetsFromOutput(graph, node, index));
  }
  return result;
}

function initialTargets(graph, sourceNode, slots) {
  const result = [];
  for (const slot of slots) {
    // slot 为人类编号 1..9；LiteGraph output index 为 0..8。
    result.push(...targetsFromOutput(graph, sourceNode, slot - 1));
  }
  return result;
}

function collectReachable(graph, sourceNode, slots) {
  const visited = new Set();
  const queue = initialTargets(graph, sourceNode, slots);
  while (queue.length) {
    const node = queue.shift();
    const id = nodeId(node);
    if (!id || visited.has(id) || node === sourceNode) continue;
    visited.add(id);
    queue.push(...targetsFromNode(graph, node));
  }
  return visited;
}

export function normalizeUsedSlots(values, slotCount = 9) {
  const used = new Set();
  for (const value of values || []) {
    const slot = Number(value);
    if (Number.isInteger(slot) && slot >= 1 && slot <= slotCount) used.add(slot);
  }
  return used;
}

export function collectAutoIgnoredNodeIds(graph, sourceNode, usedValues, slotCount = 9) {
  const usedSlots = normalizeUsedSlots(usedValues, slotCount);
  const unusedSlots = [];
  for (let slot = 1; slot <= slotCount; slot++) {
    if (!usedSlots.has(slot)) unusedSlots.push(slot);
  }

  // usedReachable 用作“汇合边界”。未使用分支到达一个同时属于有效图片链路的
  // 节点时，忽略该边界节点后停止继续向后，避免误伤 SaveImage 等共享输出。
  const usedReachable = collectReachable(graph, sourceNode, [...usedSlots]);
  const ignored = new Set();
  const visited = new Set();
  const queue = initialTargets(graph, sourceNode, unusedSlots);

  while (queue.length) {
    const node = queue.shift();
    const id = nodeId(node);
    if (!id || visited.has(id) || node === sourceNode) continue;
    visited.add(id);

    // 不允许自动忽略其它 XiangWriter 控制节点。
    const type = nodeClass(node);
    if (type.startsWith("XW")) continue;

    // Use Everywhere 的 GetNode 必须保持启用，让它的扩展在 graphToPrompt 阶段
    // 正确处理对应 SetNode 的缺失输入。直接 bypass GetNode 会切断公共生成链。
    if (isVirtualGetter(node)) continue;

    // 只由未使用槽位到达的输出节点也必须 bypass；否则 PreviewImage 会收到
    // None 并在 save_images 中崩溃。若该输出也能从有效槽位到达，则继续保护。
    if (isOutputNode(node)) {
      if (!usedReachable.has(id)) ignored.add(id);
      continue;
    }

    ignored.add(id);
    if (usedReachable.has(id)) continue;
    queue.push(...targetsFromNode(graph, node));
  }
  return ignored;
}

export function updateBypassModes(nodes, ownedModes, desiredIds, bypassMode = 4) {
  const desired = new Set([...desiredIds].map(String));
  for (const node of nodes || []) {
    const id = nodeId(node);
    if (!id) continue;
    if (desired.has(id)) {
      if (!ownedModes.has(id)) ownedModes.set(id, node.mode);
      node.mode = bypassMode;
    } else if (ownedModes.has(id)) {
      node.mode = ownedModes.get(id);
      ownedModes.delete(id);
    }
  }
}
