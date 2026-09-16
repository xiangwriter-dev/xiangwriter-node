# -*- coding: utf-8 -*-
"""XWComicDirector V3 版本 —— 适配新版 ComfyUI（comfy_api.latest / V3 API）。

与 V1 版本共用 py/agent.py 的全部逻辑；
仅在 ComfyUI 支持 V3 API 时由 __init__.py 自动启用，否则使用 V1 节点。
"""
import json
from typing_extensions import override

from comfy_api.latest import ComfyExtension, io

from . import agent as xw_agent
from .common import MAX_SLOTS, load_reference_outputs
from .modular_v3 import XWAgentPlannerV3, XWReferenceLoaderV3, XWSeriesSourceV3

CATEGORY = "xiangwriter-node/漫剧"
NODE_ID = "XWComicDirector"


def _folder_signature(root, idx, seg_mode=False, seg_idx=1):
    return xw_agent.source_signature(root, idx, seg_mode, seg_idx)


def _run_director(root_dir, episode_index, segment_mode, segment_index,
                  script_file, image_pattern, max_images, plan):
    """共享执行逻辑：返回 (out_images, batch, script, episode_name, segment_name,
    agent_prompt, plan_out, duration_seconds, previews)。"""
    source = xw_agent.scan_source({
        "root_dir": root_dir, "episode_index": episode_index,
        "segment_mode": segment_mode, "segment_index": segment_index,
        "script_file": script_file, "image_pattern": image_pattern,
    })
    if not source.get("ok"):
        raise ValueError(source.get("message") or "剧集素材读取失败")
    out_images, batch, summary, previews, valid_plan = load_reference_outputs(
        source, plan, max_images)
    script = source.get("script", "")
    episode_name = source.get("episode_name", "")
    segment_name = source.get("segment_name", "")
    agent_prompt = str(valid_plan.get("prompt") or script or "")
    duration_seconds = float(summary.get("duration_seconds", 0.0))
    plan_out = json.dumps(summary, ensure_ascii=False)
    return out_images, batch, script, episode_name, segment_name, agent_prompt, plan_out, duration_seconds, previews


class XWComicDirectorV3(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        inputs = [
            io.String.Input("root_dir", display_name="系列根目录", default="",
                            placeholder="系列根目录，内含 第一集/第二集/…，如 D:/漫剧/目录1"),
            io.Int.Input("episode_index", display_name="集序号", default=1, min=1, max=9999),
            io.Boolean.Input("segment_mode", display_name="启用分段模式", default=False),
            io.Int.Input("segment_index", display_name="段序号", default=1, min=1, max=9999),
            io.String.Input("script_file", display_name="剧本文件名", default="剧本.txt"),
            io.String.Input("image_pattern", display_name="图片匹配规则", default="*.png"),
            io.Int.Input("max_images", display_name="最大参考图数", default=MAX_SLOTS, min=1, max=MAX_SLOTS),
            io.String.Input("plan", display_name="Agent 规划", default="", multiline=True),
            # LLM(agent) 配置
            io.String.Input("llm_api_base", display_name="LLM 接口地址", default=""),
            io.String.Input("llm_api_key", display_name="LLM 密钥", default="", extra_dict={"password": True}),
            io.String.Input("llm_model", display_name="LLM 模型", default=""),
            io.Boolean.Input("llm_vision", display_name="启用多模态看图", default=True),
            io.String.Input("llm_system_prompt", display_name="Agent 系统提示词", default="", multiline=True),
            # 剧本注入目标
            io.String.Input("prompt_target", display_name="提示词目标节点", default=""),
            io.String.Input("prompt_widget", display_name="提示词输入口名称", default="text"),
        ]
        outputs = [
            io.Image.Output("image_%d" % i, display_name="参考图 %d" % i)
            for i in range(1, MAX_SLOTS + 1)
        ]
        outputs += [
            io.Image.Output("images_batch", display_name="参考图批次"),
            io.String.Output("script", display_name="剧本文本"),
            io.String.Output("episode_name", display_name="集名称"),
            io.String.Output("agent_prompt", display_name="Agent 提示词"),
            io.String.Output("plan_out", display_name="加载结果"),
            io.String.Output("segment_name", display_name="段名称"),
            io.Float.Output("duration_seconds", display_name="场景时长(秒)"),
        ]
        return io.Schema(
            node_id=NODE_ID,
            display_name="xiangwriter-node",
            category=CATEGORY,
            search_aliases=["漫剧导演", "XiangWriter", "漫剧", "ComicDirector"],
            description="AI 漫剧批量生成：读取剧本与参考图，agent 规划槽位，输出 image_1..image_9",
            inputs=inputs,
            outputs=outputs,
        )

    @classmethod
    def fingerprint_inputs(cls, root_dir, episode_index, segment_mode=False,
                           segment_index=1, script_file="剧本.txt",
                           image_pattern="*.png", max_images=MAX_SLOTS, plan="",
                           llm_api_base="", llm_api_key="", llm_model="",
                           llm_vision=True, llm_system_prompt="",
                           prompt_target="", prompt_widget="text"):
        return _folder_signature(root_dir, episode_index, segment_mode, segment_index)

    @classmethod
    def execute(cls, root_dir, episode_index, segment_mode=False, segment_index=1,
                script_file="剧本.txt", image_pattern="*.png",
                max_images=MAX_SLOTS, plan="", llm_api_base="", llm_api_key="",
                llm_model="", llm_vision=True, llm_system_prompt="",
                prompt_target="", prompt_widget="text"):
        out_images, batch, script, episode_name, segment_name, agent_prompt, plan_out, duration_seconds, previews = _run_director(
            root_dir, episode_index, segment_mode, segment_index,
            script_file, image_pattern, max_images, plan)
        ui_obj = None
        try:
            from comfy_api.latest import ui
            ui_obj = ui.PreviewImage(previews, cls=cls)
        except Exception:
            ui_obj = None
        values = out_images + [
            batch, script, episode_name, agent_prompt, plan_out, segment_name, duration_seconds]
        return io.NodeOutput(*values, ui=ui_obj)


class XWExtension(ComfyExtension):
    @override
    async def get_node_list(self):
        return [XWComicDirectorV3, XWSeriesSourceV3, XWAgentPlannerV3, XWReferenceLoaderV3]
