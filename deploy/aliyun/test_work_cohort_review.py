"""Production Pi wiring must preserve unrelated workloads and avoid model keys."""

import copy
import importlib.util
import unittest
from pathlib import Path

import test_work_account_cohort as fixture

c = fixture.c

spec = importlib.util.spec_from_file_location(
    "dual_review", Path(__file__).with_name("configure-work-cohort-review.py")
)
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class ReviewWiringTests(unittest.TestCase):
    def test_preserves_image_secret_resources_and_original_spec(self):
        for kind in ("Deployment", "CronJob"):
            item = fixture.CohortTests().resource(kind)
            original = copy.deepcopy(item)
            result = review.with_review(item)
            self.assertEqual(item, original)
            old = c.load_runtime().pod_spec(item)["containers"][0]
            new = c.load_runtime().pod_spec(result)["containers"][0]
            self.assertEqual(new["image"], old["image"])
            self.assertEqual(new["resources"], old["resources"])
            self.assertEqual(new["env"][: len(old["env"])], old["env"])
            entries = {e["name"]: e for e in new["env"]}
            self.assertEqual(
                entries["WORK_REVIEW_CA_PEM"]["valueFrom"]["secretKeyRef"],
                {"name": "meet-work-review-client-ca", "key": "ca.crt"},
            )
            self.assertNotIn("DASHSCOPE_API_KEY", entries)
            self.assertNotIn("DEEPSEEK_API_KEY", entries)
            self.assertEqual(review.with_review(result)["spec"], result["spec"])

    def test_duplicate_env_and_unreviewed_sidecar_fail_before_patch(self):
        item = fixture.CohortTests().resource()
        pod = c.load_runtime().pod_spec(item)
        pod["containers"][0]["env"].append(
            copy.deepcopy(pod["containers"][0]["env"][0])
        )
        with self.assertRaisesRegex(RuntimeError, "duplicate_env"):
            review.with_review(item)
        item = fixture.CohortTests().resource()
        c.load_runtime().pod_spec(item)["containers"].append({"name": "unknown"})
        with self.assertRaisesRegex(RuntimeError, "unexpected_sidecar"):
            review.with_review(item)

    def test_pi_verification_requires_an_explicit_boolean(self):
        for malformed in ("True", 1, None):
            with (
                self.subTest(value=malformed),
                self.assertRaisesRegex(RuntimeError, "invalid_review_verification"),
            ):
                c.verify(None, review_enabled=malformed)


if __name__ == "__main__":
    unittest.main()
