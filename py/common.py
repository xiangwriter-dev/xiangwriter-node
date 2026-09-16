# -*- coding: utf-8 -*-
"""XiangWriter 节点共用的 JSON、图片加载与预览逻辑。"""
import hashlib
import json
import os

import numpy as np
import torch
from PIL import Image

import folder_paths

from . import agent as xw_agent

MAX_SLOTS = 9


def source_to_json(source):
    return json.dumps(source, ensure_ascii=False)


def source_from_json(value):
    source = xw_agent.parse_json_object(value)
    if not source.get("ok"):
        raise ValueError(source.get("message") or "source_json 无效，请连接 XWSeriesSource")
    return source


def load_tensor(path):
    with Image.open(path) as img:
        arr = np.array(img.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _preview_name(source, slot, path):
    stamp = "%s|%s|%s" % (
        source.get("unit_name", "unit"), path, os.path.getmtime(path))
    digest = hashlib.sha1(stamp.encode("utf-8", "replace")).hexdigest()[:10]
    return "xw_%s_slot%d.png" % (digest, slot)


def save_preview(tensor, source, slot, path):
    subfolder = "xiangwriter"
    directory = os.path.join(folder_paths.get_temp_directory(), subfolder)
    os.makedirs(directory, exist_ok=True)
    filename = _preview_name(source, slot, path)
    arr = (tensor[0].detach().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    Image.fromarray(arr).save(os.path.join(directory, filename), format="PNG")
    return {"filename": filename, "subfolder": subfolder, "type": "temp"}


def load_reference_outputs(source, plan="", max_images=MAX_SLOTS):
    """返回九槽图片、可选 batch、执行摘要和预览列表。"""
    max_images = max(1, min(int(max_images or MAX_SLOTS), MAX_SLOTS))
    slot_to_path, valid_plan = xw_agent.resolve_slot_paths(source, plan, max_images)
    out_images = [None] * MAX_SLOTS
    loaded = []
    previews = []
    for slot, path in sorted(slot_to_path.items()):
        tensor = load_tensor(path)
        out_images[slot - 1] = tensor
        loaded.append(tensor)
        previews.append(save_preview(tensor, source, slot, path))

    batch = None
    if loaded:
        try:
            batch = torch.cat(loaded, dim=0)
        except (RuntimeError, ValueError):
            batch = None

    duration = xw_agent.scene_duration_fields(
        source.get("script", ""),
        valid_plan.get("duration_text"),
    )

    summary = {
        "ok": True,
        "episode_name": source.get("episode_name", ""),
        "episode_index": source.get("episode_index_actual", 1),
        "segment_mode": bool(source.get("segment_mode", False)),
        "segment_name": source.get("segment_name", ""),
        "segment_index": source.get("segment_index_actual", 1),
        "unit_name": source.get("unit_name", ""),
        "loaded_slots": sorted(slot_to_path),
        "used_images": [os.path.basename(p) for _, p in sorted(slot_to_path.items())],
        "ignored": valid_plan.get("ignored") or [],
        "plan_applied": bool(valid_plan),
        "total_images_in_dir": len(source.get("image_paths") or []),
        "batch_available": batch is not None,
        "duration_seconds": duration["duration_seconds"],
        "duration_text": duration["duration_text"],
    }
    return out_images, batch, summary, previews, valid_plan
