# -*- coding: utf-8 -*-
"""XiangWriter 节点包 —— AI 漫剧批量生成（适配 ComfyUI 0.30.0 及以上版本）。

自动适配机制：
- ComfyUI 支持 V3 API（存在 comfy_api.latest）时 → 通过模块级 comfy_entrypoint() 注册 V3 节点；
- 其它 0.30.0+ 版本 → 注册 V1 经典节点（NODE_CLASS_MAPPINGS）。
两种节点共用同一套 agent 逻辑（py/agent.py），前端扩展（js/director.js）两者通用。
"""
import os

# ---- 检测 V3 API 支持：优先 V3，回退 V1 ----
# 重要：V3 模式下绝不能定义 NODE_CLASS_MAPPINGS（哪怕是空 dict）——
# ComfyUI 加载器（nodes.py）只要检测到该属性就走 V1 分支并 return，
# V3 的 comfy_entrypoint 分支永远不会被调用，导致节点无法注册。
try:
    from comfy_api.latest import ComfyExtension  # noqa: F401
    _V3_OK = True
except Exception:
    _V3_OK = False

if _V3_OK:
    # V3 节点通过模块级 comfy_entrypoint() 注册
    from .py.director_v3 import XWExtension

    async def comfy_entrypoint():
        return XWExtension()

    __all__ = ["WEB_DIRECTORY"]
else:
    from .py.director import XWComicDirector
    from .py.modular import XWAgentPlanner, XWReferenceLoader, XWSeriesSource

    NODE_CLASS_MAPPINGS = {
        "XWComicDirector": XWComicDirector,
        "XWSeriesSource": XWSeriesSource,
        "XWAgentPlanner": XWAgentPlanner,
        "XWReferenceLoader": XWReferenceLoader,
    }
    NODE_DISPLAY_NAME_MAPPINGS = {
        "XWComicDirector": "想写·漫剧导演（兼容一体版）",
        "XWSeriesSource": "想写·剧集素材读取",
        "XWAgentPlanner": "想写·Agent 规划",
        "XWReferenceLoader": "想写·参考图槽位加载",
    }
    __all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

WEB_DIRECTORY = "./js"

# ---- 自定义 HTTP 路由：POST /xiangwriter/analyze（各版本通用）----
try:
    import asyncio

    from aiohttp import web

    # PromptServer 导入：兼容不同版本（server.py 为经典路径，comfy_server.py 为新版路径）
    try:
        from server import PromptServer
    except Exception:
        from comfy_server import PromptServer

    from .py import agent as xw_agent

    @PromptServer.instance.routes.post("/xiangwriter/analyze")
    async def xw_analyze(request):
        try:
            body = await request.json()
            plan = await asyncio.to_thread(xw_agent.run_agent, body)
            return web.json_response(plan)
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            return web.json_response({"ok": False, "message": "analyze 异常: %s" % e})

except Exception:
    pass
