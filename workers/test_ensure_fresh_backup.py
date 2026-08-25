import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from ensure_fresh_backup import _assert_fresh_file, _database_identity, ensure_fresh_backup


class FreshBackupGateTest(unittest.TestCase):
    def test_database_identity_parses_uuid_safe_connection_details(self):
        user, database = _database_identity("postgres://sports_admin:secret@db:5432/sports_db")
        self.assertEqual((user, database), ("sports_admin", "sports_db"))

    def test_rejects_small_dump(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "small.dump"
            path.write_bytes(b"bad")
            with self.assertRaisesRegex(RuntimeError, "invalido"):
                _assert_fresh_file(path)

    def test_rejects_stale_dump(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stale.dump"
            path.write_bytes(b"x" * 2048)
            stale = datetime.now(timezone.utc) - timedelta(hours=1)
            os.utime(path, (stale.timestamp(), stale.timestamp()))
            with self.assertRaisesRegex(RuntimeError, "ventana"):
                _assert_fresh_file(path)

    def test_docker_fallback_creates_hash_and_requires_restore_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            compose = root / "docker-compose.yml"
            compose.write_text("services: {}", encoding="utf-8")

            def fake_dump(_url, destination, _docker, _compose, _service):
                destination.write_bytes(b"valid-custom-dump" * 128)

            with (
                patch("ensure_fresh_backup.shutil.which", side_effect=lambda name: "docker" if name == "docker" else None),
                patch("ensure_fresh_backup._docker_dump", side_effect=fake_dump),
                patch("ensure_fresh_backup._validate_restore_list") as validate,
            ):
                artifact = ensure_fresh_backup(
                    "postgres://sports_admin:secret@db:5432/sports_db",
                    backup_dir=root / "backups",
                    compose_file=compose,
                )

            self.assertEqual(artifact.runner, "docker-compose")
            self.assertEqual(len(artifact.sha256), 64)
            self.assertGreater(artifact.size_bytes, 1024)
            validate.assert_called_once()


if __name__ == "__main__":
    unittest.main()
