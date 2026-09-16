# -*- coding: utf-8 -*-
import json
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from py import agent as xw_agent  # noqa: E402


class DurationOutputTests(unittest.TestCase):
    def test_extracts_scene_duration_from_heading(self):
        fields = xw_agent.scene_duration_fields(
            "场景 1 日内 立政殿 约 8秒\n人物：李祐、李世民、李承乾")

        self.assertEqual(fields["duration_seconds"], 8.0)
        self.assertIsInstance(fields["duration_seconds"], float)
        self.assertEqual(fields["duration_text"], "约 8秒")

    def test_converts_minutes_to_seconds(self):
        fields = xw_agent.scene_duration_fields("场景时长：1.5分钟")

        self.assertEqual(fields["duration_seconds"], 90.0)
        self.assertEqual(fields["duration_text"], "场景时长：1.5分钟")

    def test_missing_duration_returns_zero(self):
        fields = xw_agent.scene_duration_fields("场景 1 日内 立政殿\n人物：李祐")

        self.assertEqual(fields, {"duration_seconds": 0.0, "duration_text": ""})

    def test_preserves_fractional_seconds(self):
        fields = xw_agent.scene_duration_fields("场景 2 约8.5秒")

        self.assertEqual(fields["duration_seconds"], 8.5)

    def test_agent_duration_text_is_validated_against_script(self):
        source = {
            "ok": True,
            "script": "场景 1 日内 立政殿 约8秒",
            "images": [],
            "image_paths": [],
            "episode_name": "第一集",
            "episode_dir": "D:/series/第一集",
            "episode_index_actual": 1,
            "episode_count": 1,
            "segment_mode": False,
            "segment_name": "",
            "segment_index_actual": 1,
            "segment_count": 0,
            "unit_name": "第一集",
            "message": "ok",
        }
        response = json.dumps({
            "slots": [],
            "prompt": "prompt",
            "duration_seconds": 99,
            "duration_text": "约8秒",
            "ignored": [],
        }, ensure_ascii=False)
        with mock.patch.object(xw_agent, "llm_chat", return_value=response):
            plan = xw_agent.plan_source(
                source,
                llm={"api_base": "http://127.0.0.1:11434/v1", "model": "test"},
            )

        self.assertTrue(plan["llm_used"])
        self.assertEqual(plan["duration_seconds"], 8.0)
        self.assertEqual(plan["duration_text"], "约8秒")


if __name__ == "__main__":
    unittest.main()
