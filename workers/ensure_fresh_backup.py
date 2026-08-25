"""Create and validate a custom-format PostgreSQL dump for the current apply run."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse


MAX_BACKUP_AGE = timedelta(minutes=15)
MIN_BACKUP_BYTES = 1024


@dataclass(frozen=True)
class BackupArtifact:
    path: Path
    sha256: str
    size_bytes: int
    created_at: datetime
    runner: str


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _assert_fresh_file(path: Path, now: datetime | None = None) -> None:
    if not path.is_file() or path.stat().st_size < MIN_BACKUP_BYTES:
        raise RuntimeError(f"Backup invalido o vacio: {path}")
    current = now or datetime.now(timezone.utc)
    modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    if current - modified > MAX_BACKUP_AGE:
        raise RuntimeError("El backup no fue creado en esta ventana de apply.")


def _database_identity(database_url: str) -> tuple[str, str]:
    parsed = urlparse(database_url)
    database = unquote(parsed.path.lstrip("/"))
    user = unquote(parsed.username or "sports_admin")
    if not database:
        raise RuntimeError("DATABASE_URL no contiene nombre de base de datos.")
    return user, database


def _direct_dump(database_url: str, destination: Path, pg_dump: str) -> None:
    result = subprocess.run(
        [pg_dump, "--format=custom", "--file", str(destination), database_url],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"pg_dump fallo; apply bloqueado: {result.stderr.strip()}")


def _docker_dump(
    database_url: str,
    destination: Path,
    docker: str,
    compose_file: Path,
    service: str,
) -> None:
    user, database = _database_identity(database_url)
    command = [
        docker, "compose", "-f", str(compose_file), "exec", "-T", service,
        "pg_dump", "-U", user, "-d", database, "--format=custom",
    ]
    with destination.open("wb") as output:
        result = subprocess.run(command, stdout=output, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        message = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"pg_dump via Docker fallo; apply bloqueado: {message}")


def _validate_restore_list(
    destination: Path,
    pg_restore: str | None,
    docker: str | None,
    compose_file: Path,
    service: str,
) -> None:
    if pg_restore:
        result = subprocess.run(
            [pg_restore, "--list", str(destination)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=False,
        )
    elif docker:
        command = [docker, "compose", "-f", str(compose_file), "exec", "-T", service,
                   "pg_restore", "--list"]
        with destination.open("rb") as backup_input:
            result = subprocess.run(
                command,
                stdin=backup_input,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                check=False,
            )
    else:
        raise RuntimeError("pg_restore no disponible; no se puede validar el dump.")
    if result.returncode:
        message = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"pg_restore --list rechazo el dump: {message}")


def ensure_fresh_backup(
    database_url: str,
    backup_dir: Path | None = None,
    compose_file: Path | None = None,
    service: str = "db-postgres",
) -> BackupArtifact:
    root = backup_dir or Path(os.getenv("BACKUP_DIR", "./backups"))
    root.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    destination = root / f"pre_apply_{now.strftime('%Y%m%d_%H%M%S')}.dump"
    compose_path = (compose_file or Path("docker-compose.yml")).resolve()

    pg_dump = os.getenv("PG_DUMP_BIN") or shutil.which("pg_dump")
    pg_restore = os.getenv("PG_RESTORE_BIN") or shutil.which("pg_restore")
    docker = shutil.which("docker")
    if pg_dump:
        _direct_dump(database_url, destination, pg_dump)
        runner = "native"
    elif docker and compose_path.is_file():
        _docker_dump(database_url, destination, docker, compose_path, service)
        runner = "docker-compose"
    else:
        raise RuntimeError("pg_dump no disponible ni existe un fallback Docker Compose valido.")

    _assert_fresh_file(destination, now=datetime.now(timezone.utc))
    _validate_restore_list(destination, pg_restore, docker, compose_path, service)
    return BackupArtifact(
        path=destination.resolve(),
        sha256=_sha256(destination),
        size_bytes=destination.stat().st_size,
        created_at=datetime.fromtimestamp(destination.stat().st_mtime, timezone.utc),
        runner=runner,
    )
