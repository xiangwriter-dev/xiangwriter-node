# -*- coding: utf-8 -*-
"""XiangWriter V1 可组合节点：素材读取、Agent 规划、参考图加载。"""
import json

from . import agent as xw_agent
from .common import MAX_SLOTS, load_reference_outputs, source_from_json, source_to_json

CATEGORY = "xiangwriter-node/漫剧"


def _node_names(value):
    if not value or not str(value).strip():
        return []
    try:
        parsed = json.loads(str(value))
        if isinstance(parsed, list):
            return [str(x) for x in parsed]
    except Exception:
        pass
    return [line.strip() for line in str(value).splitlines() if line.strip()]


def _plan_for_source(source, max_images, llm, nodes, override=""):
    override_obj = xw_agent.parse_json_object(override)
    if override_obj and xw_agent.plan_matches_source(override_obj, source):
        _, accepted = xw_agent.resolve_slot_paths(source, override_obj, max_images)
        if accepted:
            accepted["ok"] = True
            accepted.setdefault("llm_used", False)
            accepted.setdefault("prompt", source.get("script", ""))
            accepted.setdefault("ignored", [])
            accepted["message"] = "使用已提供的规划"
            return accepted
    return xw_agent.plan_source(source, llm=llm, nodes=nodes, max_images=max_images)


class XWSeriesSource:
    """只负责选择当前集/段并读取剧本与参考图清单。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "root_dir": ("STRING", {"display_name": "系列根目录", "default": "", "placeholder": "系列根目录"}),
            "episode_index": ("INT", {"display_name": "集序号", "default": 1, "min": 1, "max": 9999}),
            "segment_mode": ("BOOLEAN", {"display_name": "启用分段模式", "default": False}),
            "segment_index": ("INT", {"display_name": "段序号", "default": 1, "min": 1, "max": 9999}),
            "script_file": ("STRING", {"display_name": "剧本文件名", "default": "剧本.txt"}),
            "image_pattern": ("STRING", {"display_name": "图片匹配规则", "default": "*.png", "placeholder": "*.png,*.jpg"}),
        }}

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "STRING", "INT", "INT", "STRING")
    RETURN_NAMES = (
        "素材数据", "剧本文本", "集名称", "段名称", "当前单位名称",
        "总集数", "当前集段数", "读取状态",
    )
    FUNCTION = "execute"
    CATEGORY = CATEGORY + "/模块"

    @classmethod
    def IS_CHANGED(cls, root_dir, episode_index, segment_mode, segment_index, **kwargs):
        return xw_agent.source_signature(root_dir, episode_index, segment_mode, segment_index)

    def execute(self, root_dir, episode_index, segment_mode, segment_index,
                script_file="剧本.txt", image_pattern="*.png"):
        source = xw_agent.scan_source({
            "root_dir": root_dir,
            "episode_index": episode_index,
            "segment_mode": segment_mode,
            "segment_index": segment_index,
            "script_file": script_file,
            "image_pattern": image_pattern,
        })
        return (
            source_to_json(source), source.get("script", ""), source.get("episode_name", ""),
            source.get("segment_name", ""), source.get("unit_name", ""),
            int(source.get("episode_count", 0)), int(source.get("segment_count", 0)),
            source.get("message", ""),
        )


class XWAgentPlanner:
    """只负责依据 source_json 生成选图、提示词和忽略节点规划。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source_json": ("STRING", {"display_name": "素材数据", "forceInput": True}),
                "max_images": ("INT", {"display_name": "最大参考图数", "default": MAX_SLOTS, "min": 1, "max": MAX_SLOTS}),
                "llm_api_base": ("STRING", {"display_name": "LLM 接口地址", "default": ""}),
                "llm_api_key": ("STRING", {"display_name": "LLM 密钥", "default": "", "password": True}),
                "llm_model": ("STRING", {"display_name": "LLM 模型", "default": ""}),
                "llm_vision": ("BOOLEAN", {"display_name": "启用多模态看图", "default": True}),
                "llm_system_prompt": ("STRING", {"display_name": "Agent 系统提示词", "default": "", "multiline": True}),
                "workflow_nodes_json": ("STRING", {
                    "display_name": "工作流节点清单",
                    "default": "", "multiline": True,
                    "placeholder": "可选：节点标题 JSON 数组或每行一个标题",
                }),
                "plan_override": ("STRING", {
                    "display_name": "预设规划",
                    "default": "", "multiline": True,
                    "placeholder": "可选：已分析好的 plan；上下文不匹配时自动忽略",
                }),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "BOOLEAN")
    RETURN_NAMES = ("规划结果", "生成提示词", "忽略节点列表", "规划状态", "已使用 LLM")
    FUNCTION = "execute"
    CATEGORY = CATEGORY + "/模块"

    def execute(self, source_json, max_images=MAX_SLOTS, llm_api_base="", llm_api_key="",
                llm_model="", llm_vision=True, llm_system_prompt="",
                workflow_nodes_json="", plan_override=""):
        source = source_from_json(source_json)
        plan = _plan_for_source(
            source, max_images,
            llm={
                "api_base": llm_api_base, "api_key": llm_api_key, "model": llm_model,
                "vision": llm_vision, "system_prompt": llm_system_prompt,
            },
            nodes=_node_names(workflow_nodes_json),
            override=plan_override,
        )
        compact = {k: v for k, v in plan.items() if k not in ("script", "episode_dir")}
        return (
            json.dumps(compact, ensure_ascii=False),
            str(plan.get("prompt") or source.get("script") or ""),
            json.dumps(plan.get("ignored") or [], ensure_ascii=False),
            str(plan.get("message") or ""),
            bool(plan.get("llm_used")),
        )


class XWReferenceLoader:
    """只负责按照 plan 将 source_json 中的参考图装入九个 IMAGE 槽位。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source_json": ("STRING", {"display_name": "素材数据", "forceInput": True}),
                "max_images": ("INT", {"display_name": "最大参考图数", "default": MAX_SLOTS, "min": 1, "max": MAX_SLOTS}),
            },
            "optional": {
                "plan": ("STRING", {"display_name": "规划结果", "forceInput": True}),
            },
        }

    RETURN_TYPES = tuple(["IMAGE"] * MAX_SLOTS) + ("IMAGE", "STRING")
    RETURN_NAMES = tuple("参考图 %d" % i for i in range(1, MAX_SLOTS + 1)) + ("参考图批次", "加载信息")
    FUNCTION = "execute"
    CATEGORY = CATEGORY + "/模块"

    def execute(self, source_json, max_images=MAX_SLOTS, plan=""):
        source = source_from_json(source_json)
        out_images, batch, summary, previews, _ = load_reference_outputs(source, plan, max_images)
        results = tuple(out_images) + (batch, json.dumps(summary, ensure_ascii=False))
        ui = {
            "images": previews,
            "text": ["%s：加载 %d 张参考图" % (
                source.get("unit_name", ""), len(summary.get("loaded_slots", [])))],
        }
        return {"ui": ui, "result": results}
