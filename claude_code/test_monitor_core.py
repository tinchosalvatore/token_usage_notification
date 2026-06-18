"""
Tests de monitor_core. Corren sin browser, daemon ni dependencias:
    python3 -m unittest discover -s claude_code -p 'test_*.py'
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import monitor_core as mc  # noqa: E402


class ExtractUsage(unittest.TestCase):
    def test_assistant_format(self):
        rec = {"type": "assistant", "message": {"usage": {"input_tokens": 10}}}
        self.assertEqual(mc.extract_usage(rec), {"input_tokens": 10})

    def test_root_format(self):
        rec = {"usage": {"input_tokens": 5}}
        self.assertEqual(mc.extract_usage(rec), {"input_tokens": 5})

    def test_no_usage(self):
        self.assertIsNone(mc.extract_usage({"type": "user"}))
        self.assertIsNone(mc.extract_usage({"type": "assistant", "message": {}}))


class ContextTokens(unittest.TestCase):
    def test_sum_three_fields(self):
        usage = {
            "input_tokens": 100,
            "cache_creation_input_tokens": 200,
            "cache_read_input_tokens": 300,
        }
        self.assertEqual(mc.context_tokens(usage), 600)

    def test_missing_fields_zero(self):
        self.assertEqual(mc.context_tokens({"input_tokens": 50}), 50)
        self.assertEqual(mc.context_tokens({}), 0)


class ModelLimit(unittest.TestCase):
    def test_1m_suffix(self):
        self.assertEqual(mc.model_limit("claude-sonnet-4-6[1m]"), 1_000_000)

    def test_default_when_unknown(self):
        self.assertEqual(mc.model_limit("claude-opus-4-8"), mc.DEFAULT_LIMIT)

    def test_custom_default(self):
        self.assertEqual(mc.model_limit("", default=123), 123)


class ExtractModel(unittest.TestCase):
    def test_message_model(self):
        rec = {"message": {"model": "claude-opus-4-8"}}
        self.assertEqual(mc.extract_model(rec), "claude-opus-4-8")

    def test_missing(self):
        self.assertEqual(mc.extract_model({}), "")


class Thresholds(unittest.TestCase):
    def test_due_crossing(self):
        fired = set()
        due = mc.due_thresholds(0.85, fired)
        labels = {t["label"] for t in due}
        self.assertEqual(labels, {"50%", "80%"})

    def test_due_skips_already_fired(self):
        fired = {0.50, 0.80}
        due = mc.due_thresholds(0.85, fired)
        self.assertEqual([t["label"] for t in due], [])

    def test_rearm_on_drop(self):
        # cruzó 95% → todo disparado
        fired = {0.50, 0.80, 0.95}
        # auto-compact: el ratio cae a 0.40
        mc.rearm(0.40, fired)
        self.assertEqual(fired, set())          # todo re-armado

    def test_rearm_partial(self):
        fired = {0.50, 0.80, 0.95}
        mc.rearm(0.70, fired)                    # baja a 70%
        self.assertEqual(fired, {0.50})          # solo 50% sigue disparado

    def test_compact_cycle_renotifies(self):
        # Escenario real: pico 95% → compact a 30% → vuelve a 95%
        fired = set()
        # pico
        for t in mc.due_thresholds(0.96, fired):
            fired.add(t["pct"])
        self.assertEqual(fired, {0.50, 0.80, 0.95})
        # compact
        mc.rearm(0.30, fired)
        self.assertEqual(fired, set())
        # vuelve a subir → 95% debe volver a estar pendiente
        labels = {t["label"] for t in mc.due_thresholds(0.96, fired)}
        self.assertIn("95%", labels)


class Fmt(unittest.TestCase):
    def test_thousands(self):
        self.assertEqual(mc.fmt(200000), "200.000")
        self.assertEqual(mc.fmt(0), "0")


class ProcessLine(unittest.TestCase):
    def test_updates_session_state(self):
        s = mc.Session(path="/tmp/x.jsonl")
        line = ('{"type":"assistant","message":{"model":"claude-opus-4-8",'
                '"usage":{"input_tokens":1000,"output_tokens":50}}}')
        info = mc.process_line(line, s)
        self.assertEqual(s.ctx, 1000)
        self.assertEqual(s.out_total, 50)
        self.assertEqual(s.turn, 1)
        self.assertAlmostEqual(info["ratio"], 1000 / mc.DEFAULT_LIMIT)

    def test_ctx_not_summed_across_turns(self):
        s = mc.Session(path="/tmp/x.jsonl")
        mc.process_line('{"usage":{"input_tokens":1000}}', s)
        mc.process_line('{"usage":{"input_tokens":2000}}', s)
        self.assertEqual(s.ctx, 2000)           # último, no 3000

    def test_ignores_garbage(self):
        s = mc.Session(path="/tmp/x.jsonl")
        self.assertIsNone(mc.process_line("not json", s))
        self.assertIsNone(mc.process_line("", s))
        self.assertEqual(s.turn, 0)


if __name__ == "__main__":
    unittest.main()
