# -*- coding: utf-8 -*-
"""XWComicDirector：漫剧导演节点。

- 按 root_dir + episode_index 定位集目录，读取剧本与参考图；
- 按 plan（agent 规划 JSON）把参考图分配到 image_1..image_9 输出槽位；
- script / agent_prompt 文本输出、场景时长秒数输出，images_batch 批量输出；
- 参考图预览直接显示在节点上（等同 LoadImage 的预览体验）。
"""
import json

from . import agent as xw_agent
from .common import MAX_SLOTS, load_reference_outputs

CATEGORY = "xiangwriter-node/漫剧"


class XWComicDirector:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "root_dir": ("STRING", {
                    "display_name": "系列根目录",
                    "default": "",
                    "placeholder": "系列根目录，内含 第一集/第二集/… 子目录，如 D:/漫剧/目录1",
                }),
                "episode_index": ("INT", {"display_name": "集序号", "default": 1, "min": 1, "max": 9999, "step": 1}),
                "segment_mode": ("BOOLEAN", {
                    "display_name": "启用分段模式",
                    "default": False,
                    "label_on": "分段模式（集下有 1-1/1-2... 子目录，每段≈15秒视频）",
                    "label_off": "整集模式",
                }),
                "segment_index": ("INT", {"display_name": "段序号", "default": 1, "min": 1, "max": 9999, "step": 1}),
                "script_file": ("STRING", {"display_name": "剧本文件名", "default": "剧本.txt"}),
                "image_pattern": ("STRING", {
                    "display_name": "图片匹配规则",
                    "default": "*.png",
                    "placeholder": "参考图通配符，如 *.png 或 *.png,*.jpg",
                }),
                "max_images": ("INT", {"display_name": "最大参考图数", "default": MAX_SLOTS, "min": 1, "max": MAX_SLOTS}),
                "plan": ("STRING", {
                    "display_name": "Agent 规划",
                    "default": "",
                    "multiline": True,
                    "placeholder": "agent 规划 JSON（点击节点上的按钮自动生成，也可手动编辑）",
                }),
                # ---- LLM(agent) 配置 ----
                "llm_api_base": ("STRING", {
                    "display_name": "LLM 接口地址",
                    "default": "",
                    "placeholder": "OpenAI 兼容地址，如 https://api.openai.com/v1 或 http://127.0.0.1:11434/v1",
                }),
                "llm_api_key": ("STRING", {"display_name": "LLM 密钥", "default": "", "password": True}),
                "llm_model": ("STRING", {
                    "display_name": "LLM 模型",
                    "default": "",
                    "placeholder": "如 gpt-4o / qwen-vl-max / deepseek-chat（留空则按文件名顺序加载）",
                }),
                "llm_vision": ("BOOLEAN", {
                    "display_name": "启用多模态看图",
                    "default": True,
                    "label_on": "看图（多模态）",
                    "label_off": "只看文件名",
                }),
                "llm_system_prompt": ("STRING", {
                    "display_name": "Agent 系统提示词",
                    "default": "",
                    "multiline": True,
                    "placeholder": "自定义 agent 系统提示词（留空用内置模板）",
                }),
                # ---- 剧本注入目标 ----
                "prompt_target": ("STRING", {
                    "display_name": "提示词目标节点",
                    "default": "",
                    "placeholder": "工作流里提示词节点的标题，如 CLIP Text Encode (Prompt)",
                }),
                "prompt_widget": ("STRING", {"display_name": "提示词输入口名称", "default": "text"}),
            },
            "optional": {},
        }

    RETURN_TYPES = tuple(["IMAGE"] * MAX_SLOTS) + ("IMAGE",) + ("STRING",) * 5 + ("FLOAT",)
    RETURN_NAMES = (tuple("参考图 %d" % i for i in range(1, MAX_SLOTS + 1))
                    + ("参考图批次", "剧本文本", "集名称", "Agent 提示词", "加载结果", "段名称", "场景时长(秒)"))
    FUNCTION = "execute"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return xw_agent.source_signature(
            kwargs.get("root_dir", ""), kwargs.get("episode_index", 1),
            kwargs.get("segment_mode", False), kwargs.get("segment_index", 1))

    def execute(self, root_dir, episode_index, segment_mode, segment_index,
                script_file, image_pattern, max_images, plan="",
                llm_api_base="", llm_api_key="", llm_model="",
                llm_vision=True, llm_system_prompt="",
                prompt_target="", prompt_widget="text", **kwargs):
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
        ui = {
            "images": previews,
            "text": ["%s：加载 %d 张参考图（目录共 %d 张）" % (
                source.get("unit_name", ""), len(summary.get("loaded_slots", [])),
                summary.get("total_images_in_dir", 0))],
        }
        results = tuple(out_images) + (
            batch, script, episode_name, agent_prompt, plan_out, segment_name, duration_seconds)
        return {"ui": ui, "result": results}
