# -*- coding: utf-8 -*-
"""XiangWriter V3 可组合节点。"""
import json

from comfy_api.latest import io

from . import agent as xw_agent
from .common import MAX_SLOTS, load_reference_outputs, source_from_json, source_to_json
from .modular import _node_names, _plan_for_source

CATEGORY = "xiangwriter-node/漫剧/模块"


class XWSeriesSourceV3(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="XWSeriesSource",
            display_name="想写·剧集素材读取",
            category=CATEGORY,
            description="选择当前集/段，读取剧本与参考图清单",
            inputs=[
                io.String.Input("root_dir", display_name="系列根目录", default="", placeholder="系列根目录"),
                io.Int.Input("episode_index", display_name="集序号", default=1, min=1, max=9999),
                io.Boolean.Input("segment_mode", display_name="启用分段模式", default=False),
                io.Int.Input("segment_index", display_name="段序号", default=1, min=1, max=9999),
                io.String.Input("script_file", display_name="剧本文件名", default="剧本.txt"),
                io.String.Input("image_pattern", display_name="图片匹配规则", default="*.png", placeholder="*.png,*.jpg"),
            ],
            outputs=[
                io.String.Output("source_json", display_name="素材数据"),
                io.String.Output("script", display_name="剧本文本"),
                io.String.Output("episode_name", display_name="集名称"),
                io.String.Output("segment_name", display_name="段名称"),
                io.String.Output("unit_name", display_name="当前单位名称"),
                io.Int.Output("episode_count", display_name="总集数"),
                io.Int.Output("segment_count", display_name="当前集段数"),
                io.String.Output("status", display_name="读取状态"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, root_dir, episode_index, segment_mode=False,
                           segment_index=1, script_file="剧本.txt", image_pattern="*.png"):
        return xw_agent.source_signature(root_dir, episode_index, segment_mode, segment_index)

    @classmethod
    def execute(cls, root_dir, episode_index, segment_mode=False, segment_index=1,
                script_file="剧本.txt", image_pattern="*.png"):
        source = xw_agent.scan_source({
            "root_dir": root_dir, "episode_index": episode_index,
            "segment_mode": segment_mode, "segment_index": segment_index,
            "script_file": script_file, "image_pattern": image_pattern,
        })
        return io.NodeOutput(
            source_to_json(source), source.get("script", ""), source.get("episode_name", ""),
            source.get("segment_name", ""), source.get("unit_name", ""),
            int(source.get("episode_count", 0)), int(source.get("segment_count", 0)),
            source.get("message", ""),
        )


class XWAgentPlannerV3(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="XWAgentPlanner",
            display_name="想写·Agent 规划",
            category=CATEGORY,
            description="根据剧本和参考图生成选图、提示词与忽略节点规划",
            inputs=[
                io.String.Input("source_json", display_name="素材数据", force_input=True),
                io.Int.Input("max_images", display_name="最大参考图数", default=MAX_SLOTS, min=1, max=MAX_SLOTS),
                io.String.Input("llm_api_base", display_name="LLM 接口地址", default=""),
                io.String.Input("llm_api_key", display_name="LLM 密钥", default="", extra_dict={"password": True}),
                io.String.Input("llm_model", display_name="LLM 模型", default=""),
                io.Boolean.Input("llm_vision", display_name="启用多模态看图", default=True),
                io.String.Input("llm_system_prompt", display_name="Agent 系统提示词", default="", multiline=True),
                io.String.Input(
                    "workflow_nodes_json", display_name="工作流节点清单", default="", multiline=True,
                    placeholder="可选：节点标题 JSON 数组或每行一个标题"),
                io.String.Input(
                    "plan_override", display_name="预设规划", default="", multiline=True,
                    placeholder="可选：已分析好的 plan；上下文不匹配时自动忽略"),
            ],
            outputs=[
                io.String.Output("plan", display_name="规划结果"),
                io.String.Output("prompt", display_name="生成提示词"),
                io.String.Output("ignored_json", display_name="忽略节点列表"),
                io.String.Output("status", display_name="规划状态"),
                io.Boolean.Output("llm_used", display_name="已使用 LLM"),
            ],
        )

    @classmethod
    def execute(cls, source_json, max_images=MAX_SLOTS, llm_api_base="", llm_api_key="",
                llm_model="", llm_vision=True, llm_system_prompt="",
                workflow_nodes_json="", plan_override=""):
        source = source_from_json(source_json)
        plan = _plan_for_source(
            source, max_images,
            llm={
                "api_base": llm_api_base, "api_key": llm_api_key, "model": llm_model,
                "vision": llm_vision, "system_prompt": llm_system_prompt,
            },
            nodes=_node_names(workflow_nodes_json), override=plan_override,
        )
        compact = {k: v for k, v in plan.items() if k not in ("script", "episode_dir")}
        return io.NodeOutput(
            json.dumps(compact, ensure_ascii=False),
            str(plan.get("prompt") or source.get("script") or ""),
            json.dumps(plan.get("ignored") or [], ensure_ascii=False),
            str(plan.get("message") or ""), bool(plan.get("llm_used")),
        )


class XWReferenceLoaderV3(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        outputs = [
            io.Image.Output("image_%d" % i, display_name="参考图 %d" % i)
            for i in range(1, MAX_SLOTS + 1)
        ]
        outputs += [
            io.Image.Output("images_batch", display_name="参考图批次"),
            io.String.Output("load_info", display_name="加载信息"),
        ]
        return io.Schema(
            node_id="XWReferenceLoader",
            display_name="想写·参考图槽位加载",
            category=CATEGORY,
            description="按照 plan 把参考图加载到 image_1..image_9",
            inputs=[
                io.String.Input("source_json", display_name="素材数据", force_input=True),
                io.Int.Input("max_images", display_name="最大参考图数", default=MAX_SLOTS, min=1, max=MAX_SLOTS),
                io.String.Input("plan", display_name="规划结果", optional=True, force_input=True),
            ],
            outputs=outputs,
        )

    @classmethod
    def execute(cls, source_json, max_images=MAX_SLOTS, plan=""):
        source = source_from_json(source_json)
        out_images, batch, summary, previews, _ = load_reference_outputs(source, plan, max_images)
        try:
            from comfy_api.latest import ui
            ui_obj = ui.PreviewImage(previews, cls=cls)
        except Exception:
            ui_obj = None
        values = out_images + [batch, json.dumps(summary, ensure_ascii=False)]
        return io.NodeOutput(*values, ui=ui_obj)
