"""Regression for vcvars environment casing on hosted Windows runners."""
import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "remote_input_build", Path(__file__).resolve().parents[1] / "scripts/build-remote-input.py"
)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ToolchainEnvironmentTests(unittest.TestCase):
    def test_vcvars_path_replaces_inherited_path(self):
        env = builder.setup_environment(
            {"PATH": "C:/Windows/System32", "Temp": "C:/Temp"},
            "Path=C:/VS/bin/Hostx64/x64;C:/Windows/System32\r\nINCLUDE=C:/VS/include\r\n",
        )
        self.assertEqual(env["PATH"], "C:/VS/bin/Hostx64/x64;C:/Windows/System32")
        self.assertNotIn("Path", env)
        self.assertEqual(env["TEMP"], "C:/Temp")
        self.assertEqual(env["INCLUDE"], "C:/VS/include")

    def test_drive_pseudo_variables_are_ignored_and_values_preserved(self):
        env = builder.setup_environment(
            {"Path": "C:/Old"}, "=C:=C:/work\nPATH=C:/New\nEMPTY=\nVALUE=one=two\n"
        )
        self.assertEqual(env["PATH"], "C:/New")
        self.assertEqual(env["EMPTY"], "")
        self.assertEqual(env["VALUE"], "one=two")
        self.assertNotIn("", env)


if __name__ == "__main__":
    unittest.main()
