import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../js/auto_advance.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const {
  compactAutoPlan,
  eventDetail,
  findQueuedPromptId,
  historyOutcome,
  isTransientExecutionError,
  promptIdFromQueueResult,
} = await import(moduleUrl);

assert.equal(promptIdFromQueueResult({ prompt_id: "p1" }), "p1");
assert.equal(promptIdFromQueueResult([{ response: { prompt_id: "p2" } }]), "p2");
assert.equal(eventDetail({ detail: { prompt_id: "p3" } }).prompt_id, "p3");

const plan = JSON.stringify({ unit_name: "第7集/7-1" });
const queue = {
  queue_running: [[27, "current", {
    427: { class_type: "XWComicDirector", inputs: { plan } },
  }]],
  queue_pending: [[26, "other", {
    900: { class_type: "XWComicDirector", inputs: { plan: JSON.stringify({ unit_name: "其它" }) } },
  }]],
};
assert.equal(findQueuedPromptId(queue, 427, "第7集/7-1"), "current");
assert.equal(findQueuedPromptId(queue, 427, "不存在"), "");

assert.equal(historyOutcome({}, "p").state, "missing");
assert.equal(historyOutcome({ p: { status: { completed: true, status_str: "success", messages: [] } } }, "p").state, "success");
const errorDetail = {
  prompt_id: "p",
  node_id: "336",
  node_type: "TD_MiniMax_H3_Prompt",
  exception_message: "接口返回了空内容。",
};
assert.deepEqual(
  historyOutcome({ p: { status: { status_str: "error", messages: [["execution_error", errorDetail]] } } }, "p"),
  { state: "error", detail: errorDetail }
);
assert.equal(isTransientExecutionError(errorDetail), true);
assert.equal(isTransientExecutionError({ node_type: "Sampler", exception_message: "out of memory" }), false);

const compact = compactAutoPlan({
  ok: true,
  unit_name: "第7集/7-1",
  episode_index_actual: 7,
  prompt: "很长的提示词",
  script: "很长的剧本",
});
assert.equal(compact.unit_name, "第7集/7-1");
assert.equal("prompt" in compact, false);
assert.equal("script" in compact, false);

console.log("auto_advance: prompt filtering, recovery and retry classification OK");
