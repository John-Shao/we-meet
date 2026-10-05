"""Render the HTTP AI pool and verify routing, isolation and image inheritance."""

import importlib.util
import pathlib
import re
import unittest

from test_meeting_ai_chart import ROOT, render


class AIPoolTest(unittest.TestCase):
    def test_disabled_by_default(self):
        self.assertFalse(any(row["metadata"]["name"].endswith("-ai") for row in render()))

    def test_pool_inherits_backend_image_and_secrets_without_overriding_api(self):
        rows = render("aiBackend.enabled=true", "backend.image.tag=fixture-commit",
                      "aiBackend.image.tag=must-not-be-used", "backend.envVars.SCOPE=shared",
                      "backend.envVars.TEST_SECRET.secretKeyRef.name=fixture-secrets",
                      "backend.envVars.TEST_SECRET.secretKeyRef.key=key")
        deployments = {r["metadata"]["name"]: r for r in rows if r["kind"] == "Deployment"}
        backend, ai = deployments["meet-backend"], deployments["meet-backend-ai"]
        normal, isolated = [r["spec"]["template"]["spec"]["containers"][0] for r in (backend, ai)]
        self.assertEqual(normal["image"], isolated["image"])
        self.assertTrue(isolated["image"].endswith(":fixture-commit"))
        self.assertNotEqual(backend["spec"]["selector"], ai["spec"]["selector"])
        env = {item["name"]: item for item in isolated["env"]}
        self.assertEqual("shared", env["SCOPE"]["value"])
        self.assertEqual("fixture-secrets", env["TEST_SECRET"]["valueFrom"]["secretKeyRef"]["name"])
        self.assertEqual("2", env["AI_MAX_CONCURRENT_REQUESTS"]["value"])
        self.assertIn("--threads=4", isolated["command"])
        self.assertIn("--workers=2", isolated["command"])
        self.assertIn("meet.ai_wsgi:application", isolated["command"])
        self.assertNotIn("AI_MAX_CONCURRENT_REQUESTS", {item["name"] for item in normal["env"]})
        self.assertNotIn("meet.ai_wsgi:application", normal.get("command", []))
        service = next(r for r in rows if r["kind"] == "Service" and r["metadata"]["name"] == "meet-backend-ai")
        self.assertEqual(ai["spec"]["selector"]["matchLabels"], service["spec"]["selector"])
        self.assertEqual("1Gi", isolated["resources"]["limits"]["memory"])

    def test_routes_match_wsgi_allowlist_and_keep_ordinary_api_separate(self):
        rows = render("aiBackend.enabled=true", "ingress.enabled=true",
                      "ingress.host=meet.example.invalid", "ingress.hosts[0]=alias.example.invalid",
                      "ingress.tls.enabled=true", "ingress.tls.secretName=existing-tls")
        ingress = next(r for r in rows if r["kind"] == "Ingress" and r["metadata"]["name"] == "meet-ai")
        annotations = ingress["metadata"]["annotations"]
        self.assertEqual("off", annotations["nginx.ingress.kubernetes.io/proxy-buffering"])
        self.assertEqual("off", annotations["nginx.ingress.kubernetes.io/proxy-next-upstream"])
        self.assertEqual("existing-tls", ingress["spec"]["tls"][0]["secretName"])
        self.assertEqual(2, len(ingress["spec"]["rules"]))
        paths = ingress["spec"]["rules"][0]["http"]["paths"]
        spec = importlib.util.spec_from_file_location("admission", ROOT / "src/backend/meet/ai_admission.py")
        admission = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(admission)
        self.assertEqual(set(admission.AI_PATHS), {p["path"].removesuffix("$") for p in paths})
        cases = {
            "/api/v1.0/users/me/ai/ask/": True,
            "/api/v1.0/users/me/ai/ask-stream/": True,
            "/api/v1.0/rooms/room-id/ask-ai-stream/": True,
            "/api/v1.0/search/ask/": True,
            "/api/v1.0/meeting-records/record-id/questions/question-id/": True,
            "/api/v1.0/assistant-summary/": True,
            "/api/v1.0/users/me/": False,
            "/api/v1.0/rooms/room-id/": False,
            "/api/v1.0/meeting-records/record-id/transcripts/": False,
            "/api/v1.0/users/me/ai/ask-stream/other/": False,
        }
        for url, expected in cases.items():
            self.assertEqual(expected, any(re.fullmatch(p["path"], url) for p in paths), url)
        self.assertTrue(all(p["backend"]["service"]["name"] == "meet-backend-ai" for p in paths))


if __name__ == "__main__":
    unittest.main()
