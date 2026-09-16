# -*- coding: utf-8 -*-
"""XiangWriter 无头批量运行器（纯 API 模式，不需要浏览器，兼容 ComfyUI 0.3.0+）。

用法：
  python run_series.py --workflow 工作流API.json --root "D:/漫剧/目录1" ^
      [--start 1] [--end 3] [--llm-base http://127.0.0.1:11434/v1] ^
      [--llm-key sk-xxx] [--llm-model qwen-vl-max] [--no-vision] ^
      [--server http://127.0.0.1:8188] [--out results]

其中 工作流API.json 是 ComfyUI 导出的 API 格式工作流，可使用 XWComicDirector，
也可使用 XWSeriesSource + XWReferenceLoader 模块组合。
逐集流程：agent 分析 -> 更新导演节点参数 -> 切除未用槽位链路(等效忽略) -> 排队 -> 轮询结果 -> 下一集。
"""
import argparse
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from py import agent as xw_agent  # noqa: E402

DIRECTOR_CLASS = "XWComicDirector"
SOURCE_CLASS = "XWSeriesSource"
PLANNER_CLASS = "XWAgentPlanner"
LOADER_CLASS = "XWReferenceLoader"
IMAGE_OUTPUTS = 9  # image_1..image_9 的输出索引为 0..8


def http_json(url, data=None, timeout=30):
    if data is not None:
        req = urllib.request.Request(
            url, data=json.dumps(data).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST")
    else:
        req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def find_director(workflow):
    for nid, node in workflow.items():
        if node.get("class_type") == DIRECTOR_CLASS:
            return nid, node
    return None, None


def find_class(workflow, class_type):
    for nid, node in workflow.items():
        if node.get("class_type") == class_type:
            return nid, node
    return None, None


def find_xw_nodes(workflow):
    """优先使用兼容一体节点，否则识别 Source + Planner + Loader 模块组合。"""
    director_id, director = find_director(workflow)
    source_id, source = find_class(workflow, SOURCE_CLASS)
    planner_id, planner = find_class(workflow, PLANNER_CLASS)
    loader_id, loader = find_class(workflow, LOADER_CLASS)
    if director is not None:
        return {
            "mode": "director", "source_id": director_id, "source": director,
            "planner_id": None, "planner": None,
            "loader_id": director_id, "loader": director,
        }
    if source is not None and loader is not None:
        return {
            "mode": "modular", "source_id": source_id, "source": source,
            "planner_id": planner_id, "planner": planner,
            "loader_id": loader_id, "loader": loader,
        }
    return None


def cut_unused_slots(workflow, dir_id, used_slots, log):
    """把未使用槽位的输出链路从工作流中切除；失去全部输入连接的节点级联移除（等效忽略）。"""
    doomed = set()
    for slot in range(1, IMAGE_OUTPUTS + 1):
        if slot in used_slots:
            continue
        for nid, node in list(workflow.items()):
            if nid == dir_id:
                continue
            for iname, ival in list(node.get("inputs", {}).items()):
                if (isinstance(ival, list) and len(ival) == 2
                        and ival[0] == dir_id and ival[1] == slot - 1):
                    del node["inputs"][iname]
                    doomed.add(nid)
    changed = True
    while changed:
        changed = False
        for nid in list(doomed):
            if nid not in workflow or nid == dir_id:
                doomed.discard(nid)
                continue
            log.append("忽略节点 %s (%s)" % (nid, workflow[nid].get("class_type")))
            del workflow[nid]
            doomed.discard(nid)
            changed = True
            for nid2, node2 in list(workflow.items()):
                if nid2 == dir_id:
                    continue
                for iname, ival in list(node2.get("inputs", {}).items()):
                    if isinstance(ival, list) and len(ival) == 2 and ival[0] == nid:
                        del node2["inputs"][iname]
                        has_links = any(
                            isinstance(v, list) and len(v) == 2 and v[0] in workflow
                            for v in node2.get("inputs", {}).values())
                        if not has_links:
                            doomed.add(nid2)
    return workflow


def poll(server, prompt_id, timeout=3600):
    url = "%s/history/%s" % (server, prompt_id)
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            h = http_json(url, timeout=10)
        except Exception:
            h = {}
        if prompt_id in h:
            st = h[prompt_id].get("status", {})
            if st.get("completed") or st.get("status_str") == "error":
                return h[prompt_id]
        time.sleep(3)
    raise TimeoutError("等待执行结果超时: %s" % prompt_id)


def main():
    ap = argparse.ArgumentParser(description="XiangWriter 无头批量运行器")
    ap.add_argument(
        "--workflow", required=True,
        help="API 格式工作流 JSON（含 XWComicDirector 或 Source+Loader 模块组合）")
    ap.add_argument("--root", required=True, help="系列根目录")
    ap.add_argument("--start", type=int, default=1)
    ap.add_argument("--end", type=int, default=0, help="0=全部")
    ap.add_argument("--segment-mode", action="store_true",
                    help="分段模式：每集下按 1-1/1-2... 子目录逐段生成（每段≈15秒视频）")
    ap.add_argument("--script-file", default="剧本.txt")
    ap.add_argument("--image-pattern", default="*.png")
    ap.add_argument("--max-images", type=int, default=9)
    ap.add_argument("--llm-base", default=os.environ.get("XW_LLM_BASE", ""))
    ap.add_argument("--llm-key", default=os.environ.get("XW_LLM_KEY", ""))
    ap.add_argument("--llm-model", default=os.environ.get("XW_LLM_MODEL", ""))
    ap.add_argument("--no-vision", action="store_true")
    ap.add_argument("--server", default="http://127.0.0.1:8188")
    ap.add_argument("--out", default="results", help="结果输出目录")
    args = ap.parse_args()

    with open(args.workflow, "r", encoding="utf-8") as f:
        workflow = json.load(f)
    xw_nodes = find_xw_nodes(workflow)
    if xw_nodes is None:
        print("错误：工作流需包含 XWComicDirector，或同时包含 XWSeriesSource + XWReferenceLoader")
        sys.exit(1)

    os.makedirs(args.out, exist_ok=True)
    ep_dirs = xw_agent.find_episode_dirs(args.root)
    total = len(ep_dirs)
    if total == 0:
        print("错误：%s 下没有集目录" % args.root)
        sys.exit(1)
    end = args.end if args.end > 0 else total

    for idx in range(args.start, end + 1):
        ep_dir = ep_dirs[max(0, min(idx - 1, len(ep_dirs) - 1))]
        ep_name = os.path.basename(ep_dir)

        # 确定本集内的单位：分段模式 -> 各段（1-1,1-2...）；否则整集一个单位
        units = []
        if args.segment_mode:
            segs = xw_agent.find_segment_dirs(ep_dir)
            units = [(s, i + 1) for i, s in enumerate(segs)] if segs else [(ep_dir, 1)]
        else:
            units = [(ep_dir, 1)]

        for unit_dir, seg_idx in units:
            cfg = {
                "root_dir": args.root,
                "episode_index": idx,
                "segment_mode": args.segment_mode,
                "segment_index": seg_idx,
                "script_file": args.script_file,
                "image_pattern": args.image_pattern,
                "max_images": args.max_images,
                "nodes": [],
                "llm": {
                    "api_base": args.llm_base,
                    "api_key": args.llm_key,
                    "model": args.llm_model,
                    "vision": not args.no_vision,
                    "system_prompt": "",
                },
            }
            plan = xw_agent.run_agent(cfg)
            unit_name = plan.get("unit_name") or ep_name
            print("=" * 60)
            print("[%d/%d] %s | %s" % (idx, total, unit_name, plan.get("message", "")))
            if not plan.get("ok"):
                print("  跳过（%s）" % plan.get("message"))
                continue

            wf = json.loads(json.dumps(workflow))  # 深拷贝模板
            source_node = wf[xw_nodes["source_id"]]
            source_node["inputs"]["root_dir"] = args.root
            source_node["inputs"]["episode_index"] = idx
            source_node["inputs"]["segment_mode"] = args.segment_mode
            source_node["inputs"]["segment_index"] = seg_idx
            source_node["inputs"]["script_file"] = args.script_file
            source_node["inputs"]["image_pattern"] = args.image_pattern
            compact_plan = json.dumps(
                {k: v for k, v in plan.items() if k not in ("script", "episode_dir")},
                ensure_ascii=False)
            if xw_nodes["mode"] == "director":
                source_node["inputs"]["max_images"] = args.max_images
                source_node["inputs"]["plan"] = compact_plan
            else:
                loader_node = wf[xw_nodes["loader_id"]]
                loader_node["inputs"]["max_images"] = args.max_images
                if xw_nodes["planner_id"] is not None:
                    planner_node = wf[xw_nodes["planner_id"]]
                    planner_node["inputs"]["max_images"] = args.max_images
                    planner_node["inputs"]["llm_api_base"] = args.llm_base
                    planner_node["inputs"]["llm_api_key"] = args.llm_key
                    planner_node["inputs"]["llm_model"] = args.llm_model
                    planner_node["inputs"]["llm_vision"] = not args.no_vision
                    planner_node["inputs"]["plan_override"] = compact_plan
                else:
                    loader_node["inputs"]["plan"] = compact_plan

            used_slots = {int(s["slot"]) for s in plan.get("slots", [])}
            log = []
            cut_unused_slots(wf, xw_nodes["loader_id"], used_slots, log)
            if log:
                print("  忽略节点：\n    " + "\n    ".join(log))
            else:
                print("  本单位无需要忽略的节点")

            try:
                r = http_json("%s/prompt" % args.server,
                              {"prompt": wf, "client_id": "xiangwriter-run-series"}, timeout=30)
            except Exception as e:
                print("  排队失败：%s（请确认 ComfyUI 已启动在 %s）" % (e, args.server))
                continue
            pid = r["prompt_id"]
            print("  已排队：%s" % pid)
            hist = poll(args.server, pid)
            safe_name = unit_name.replace("/", "_").replace("\\", "_")
            out_path = os.path.join(args.out, "%02d_%s_history.json" % (idx, safe_name))
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(hist, f, ensure_ascii=False, indent=2)
            st = hist.get("status", {})
            status = st.get("status_str") or ("completed" if st.get("completed") else "unknown")
            print("  完成：status=%s，历史已存 %s" % (status, out_path))

    print("=" * 60)
    print("全部完成，结果见 %s" % args.out)


if __name__ == "__main__":
    main()
