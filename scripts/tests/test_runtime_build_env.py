import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class RuntimeDependenciesTests(unittest.TestCase):
    def test_pinned_manager_is_reused_and_install_is_noninteractive(self):
        self.check_install("11.10.0", "pnpm", ["install", "--frozen-lockfile"])

    def test_mismatched_manager_uses_the_pinned_npm_fallback(self):
        self.check_install("10.7.1", "npm", ["exec", "--yes", "--package=pnpm@11.10.0", "--", "pnpm", "install", "--frozen-lockfile"])

    def check_install(self, installed_version, expected_manager, expected_arguments):
        script = Path(__file__).resolve().parents[1] / "runtime-build-env.sh"
        with tempfile.TemporaryDirectory(prefix="cinderdeck-runtime-env-") as directory:
            root = Path(directory)
            binary = root / "bin"
            binary.mkdir()
            (binary / "node").symlink_to(shutil.which("node"))
            (root / "package.json").write_text(json.dumps({"packageManager": "pnpm@11.10.0"}))
            for manager in ["npm", "pnpm"]:
                path = binary / manager
                path.write_text(
                    "#!/bin/sh\n"
                    f'if [ "$1" = --version ]; then echo {installed_version}; exit; fi\n'
                    f'printf "%s\\n" {manager} "$CI" "$VP_GIT_HOOKS" "$@" > "$TASK_INSTALL_RECORD"\n'
                )
                path.chmod(0o755)
            record = root / "invocation"
            environment = dict(os.environ, TASK_ENV_SCRIPT=str(script), RUNTIME_SOURCE=str(root),
                               NODE_BINARY=str(binary / "node"), TASK_INSTALL_RECORD=str(record))
            subprocess.run(["/bin/bash", "-c", 'source "$TASK_ENV_SCRIPT"; install_runtime_dependencies'],
                           env=environment, check=True, capture_output=True, text=True)
            self.assertEqual(record.read_text().splitlines(), [expected_manager, "true", "0", *expected_arguments])


if __name__ == "__main__":
    unittest.main()
