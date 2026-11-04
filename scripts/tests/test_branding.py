import importlib.util
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import unittest

spec = importlib.util.spec_from_file_location("branding", Path(__file__).parents[1] / "check-branding.py")
branding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(branding)


class BrandingTests(unittest.TestCase):
    def test_wrong_logo_and_display_name_are_detected(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for path in ["apps/desktop/package.json", "apps/web/public", "assets/cinderdeck/prod", "assets/prod"]:
                destination = root / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                source = branding.ROOT / path
                if source.is_dir():
                    shutil.copytree(source, destination)
                else:
                    shutil.copy(source, destination)
            self.assertEqual(branding.branding_errors(root), [])
            (root / "apps/desktop/package.json").write_text('{"productName":"T3 Code"}')
            (root / "apps/web/public/favicon.ico").write_bytes(b"wrong icon")
            self.assertEqual(len(branding.branding_errors(root)), 2)
