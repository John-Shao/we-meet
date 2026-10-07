import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "model_sample", Path(__file__).with_name("complete-work-k3s-model-sample.py")
)
sample = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sample)


class SupplementalModelSampleTests(unittest.TestCase):
    def setUp(self):
        self.initial = {
            "supplier_calls": 3,
            "supplier_call_ceiling": 5,
            "samples": [{}, {}, {}],
        }

    def test_uncertain_previous_admission_cannot_replay(self):
        with self.assertRaisesRegex(
            sample.h.AcceptanceError, "sample_already_started_do_not_replay"
        ):
            sample.require_new_sample(self.initial, 3, True)

    def test_unexpected_usage_or_authorization_refuses_new_model_call(self):
        for calls in (0, 2, 4, 5):
            with self.subTest(calls=calls):
                with self.assertRaisesRegex(
                    sample.h.AcceptanceError, "unexpected_supplier_usage"
                ):
                    sample.require_new_sample(self.initial, calls, False)
        self.initial["supplier_call_ceiling"] = 6
        with self.assertRaisesRegex(
            sample.h.AcceptanceError, "unexpected_authorization_ceiling"
        ):
            sample.require_new_sample(self.initial, 3, False)


if __name__ == "__main__":
    unittest.main()
