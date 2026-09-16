import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const moduleSource = await readFile(new URL("../js/slot_ignore.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
const {
  collectAutoIgnoredNodeIds,
  enabledOutputNodes,
  getGraphLink,
  isOutputNode,
  isVirtualGetter,
  updateBypassModes,
} = await import(moduleUrl);

function makeNode(id, type = "Test") {
  return { id, type, mode: 0, outputs: [{ links: [] }] };
}

function makeGraph(useMap) {
  const source = makeNode("loader", "XWReferenceLoader");
  source.outputs = Array.from({ length: 9 }, () => ({ links: [] }));
  const branch1 = makeNode("branch1");
  const branch2 = makeNode("branch2");
  const branch3 = makeNode("branch3");
  const shared = makeNode("shared");
  const save = makeNode("save");
  const nodes = [source, branch1, branch2, branch3, shared, save];
  const records = [];

  function connect(id, from, outputIndex, to) {
    while (from.outputs.length <= outputIndex) from.outputs.push({ links: [] });
    from.outputs[outputIndex].links.push(id);
    records.push([id, { id, origin_id: from.id, target_id: to.id }]);
  }
  connect(1, source, 0, branch1);
  connect(2, source, 1, branch2);
  connect(3, source, 2, branch3);
  connect(4, branch1, 0, shared);
  connect(5, branch2, 0, shared);
  connect(6, branch3, 0, shared);
  connect(7, shared, 0, save);

  const links = useMap ? new Map(records) : Object.fromEntries(records);
  const graph = {
    _nodes: nodes,
    links,
    getNodeById(id) {
      return nodes.find((item) => String(item.id) === String(id));
    },
  };
  return { graph, nodes, source, branch3, shared, save };
}

for (const useMap of [false, true]) {
  const label = useMap ? "Map" : "Object";
  const { graph, nodes, source, branch3, shared, save } = makeGraph(useMap);
  assert.equal(getGraphLink(graph, 3)?.target_id, "branch3", `${label} 连线读取失败`);

  const ignoredForTwo = collectAutoIgnoredNodeIds(graph, source, [1, 2], 9);
  assert(ignoredForTwo.has("branch3"), `${label} 未忽略第三图片分支`);
  assert(ignoredForTwo.has("shared"), `${label} 未忽略缺图汇合边界`);
  assert(!ignoredForTwo.has("save"), `${label} 错误忽略共享保存节点`);

  const owned = new Map();
  updateBypassModes(nodes, owned, ignoredForTwo, 4);
  assert.equal(branch3.mode, 4, `${label} 未设置 bypass`);
  assert.equal(shared.mode, 4, `${label} 汇合边界未设置 bypass`);
  assert.equal(save.mode, 0, `${label} 保存节点被误设 bypass`);

  const ignoredForThree = collectAutoIgnoredNodeIds(graph, source, [1, 2, 3], 9);
  updateBypassModes(nodes, owned, ignoredForThree, 4);
  assert.equal(branch3.mode, 0, `${label} 图片恢复后未还原分支`);
  assert.equal(shared.mode, 0, `${label} 图片恢复后未还原汇合节点`);
}

console.log("slot_ignore: Object/Map compatibility OK");

{
  const source = makeNode("loader", "XWReferenceLoader");
  source.outputs = Array.from({ length: 9 }, () => ({ links: [] }));
  const branch = makeNode("branch");
  const saveByMetadata = makeNode("save-meta", "ThirdPartySaver");
  saveByMetadata.constructor = { nodeData: { output_node: true } };
  const preview = makeNode("preview", "PreviewImage");
  const nodes = [source, branch, saveByMetadata, preview];
  source.outputs[2].links.push(1);
  branch.outputs[0].links.push(2);
  const graph = {
    _nodes: nodes,
    links: {
      1: { id: 1, origin_id: source.id, target_id: branch.id },
      2: { id: 2, origin_id: branch.id, target_id: saveByMetadata.id },
    },
    getNodeById(id) {
      return nodes.find((item) => String(item.id) === String(id));
    },
  };
  const ignored = collectAutoIgnoredNodeIds(graph, source, [1, 2], 9);
  assert(ignored.has("branch"), "未忽略缺失的第三图片分支");
  assert(ignored.has("save-meta"), "未忽略只属于缺图分支的输出节点");
  assert(isOutputNode(saveByMetadata), "未识别 output_node 元数据");
  assert(isOutputNode(preview), "未识别兼容名单中的预览输出节点");
  assert.deepEqual(enabledOutputNodes(nodes).map((node) => node.id), ["save-meta", "preview"]);
  preview.mode = 4;
  assert.deepEqual(enabledOutputNodes(nodes).map((node) => node.id), ["save-meta"]);
}

{
  const source = makeNode("loader", "XWReferenceLoader");
  source.outputs = Array.from({ length: 9 }, () => ({ links: [] }));
  const getter = makeNode("get3", "GetNode");
  const save = makeNode("save", "SaveImage");
  source.outputs[2].links.push(10);
  getter.outputs[0].links.push(11);
  const nodes = [source, getter, save];
  const graph = {
    _nodes: nodes,
    links: {
      10: { id: 10, origin_id: source.id, target_id: getter.id },
      11: { id: 11, origin_id: getter.id, target_id: save.id },
    },
    getNodeById(id) {
      return nodes.find((item) => String(item.id) === String(id));
    },
  };
  const ignored = collectAutoIgnoredNodeIds(graph, source, [1, 2], 9);
  assert(isVirtualGetter(getter), "未识别 Use Everywhere GetNode");
  assert(!ignored.has("get3"), "错误 bypass GetNode，可能切断公共生成链");
  assert(!ignored.has("save"), "错误 bypass GetNode 下游的输出节点");
}

console.log("slot_ignore: unused output bypass and virtual getter protection OK");

// 通用数量递减：n 张图 -> n-1 张图，n 为 1..9 的整数。
// 每一步只新增关闭刚减少及其后的空槽位分支，不依赖 3->2 的特例。
{
  const source = makeNode("loader", "XWReferenceLoader");
  source.outputs = Array.from({ length: 9 }, () => ({ links: [] }));
  const branches = Array.from({ length: 9 }, (_, index) => makeNode(`slot${index + 1}`));
  const save = makeNode("save-all", "SaveImage");
  const nodes = [source, ...branches, save];
  const links = {};
  for (let index = 0; index < 9; index++) {
    const linkId = index + 100;
    source.outputs[index].links.push(linkId);
    links[linkId] = {
      id: linkId,
      origin_id: source.id,
      target_id: branches[index].id,
    };
  }
  const graph = {
    _nodes: nodes,
    links,
    getNodeById(id) {
      return nodes.find((item) => String(item.id) === String(id));
    },
  };
  const owned = new Map();

  for (let n = 9; n >= 1; n--) {
    const nextCount = n - 1;
    const used = Array.from({ length: nextCount }, (_, index) => index + 1);
    const ignored = collectAutoIgnoredNodeIds(graph, source, used, 9);
    updateBypassModes(nodes, owned, ignored, 4);

    for (let slot = 1; slot <= 9; slot++) {
      const expectedMode = slot <= nextCount ? 0 : 4;
      assert.equal(
        branches[slot - 1].mode,
        expectedMode,
        `${n}->${nextCount} 时槽位 ${slot} 的 bypass 状态错误`
      );
    }
    assert.equal(save.mode, 0, `${n}->${nextCount} 时错误关闭输出节点`);
  }
}

console.log("slot_ignore: generic n -> n-1 transitions (9..1) OK");
