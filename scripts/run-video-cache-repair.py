#!/usr/bin/env python3
"""Host launcher: pass DB credentials privately to a one-shot Prisma job.

No SQL, provider HTTP, generated tasks, or Portal/new-api restarts. Credentials
are read into memory, mounted from a root-only temporary file, and then removed.
The worker image is pinned in the root-owned configuration, never user input.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import uuid

DOCKER = ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock"]
RUNTIME = Path("/run/llmroute-video-cache-repair")


def terminate(_signal, _frame):
    raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/llmroute/video-cache-repair.json")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, terminate)
    os.umask(0o077)
    config_path = Path(args.config).resolve(strict=True)
    config = json.loads(config_path.read_text())
    for key in ("database_container", "docker_network", "database_hostname"):
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}", config[key]):
            raise ValueError("invalid host configuration")
    if not re.fullmatch(r"llmroute-video-cache-repair:release-[a-f0-9]{8,40}", config["repair_image"]):
        raise ValueError("a versioned repair image is required")
    state = Path(config["job"]["state_directory"])
    if state != Path("/var/lib/llmroute-video-cache-repair"):
        raise ValueError("unexpected state directory")
    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    state.mkdir(mode=0o700, exist_ok=True)
    descriptor = os.open(state / "job.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "a"):
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        inspection = subprocess.run(
            DOCKER + ["inspect", "--format", "{{json .Config.Env}}", config["database_container"]],
            capture_output=True, text=True, check=True, timeout=5,
        )
        environment = dict(value.split("=", 1) for value in json.loads(inspection.stdout))
        credentials = {
            "host": config["database_hostname"], "port": 5432,
            "user": environment["POSTGRES_USER"], "password": environment["POSTGRES_PASSWORD"],
            "database": environment["POSTGRES_DB"],
        }
        handle, name = tempfile.mkstemp(prefix="database-", suffix=".json", dir=RUNTIME)
        job_name = "llmroute-video-cache-repair-job-" + uuid.uuid4().hex[:12]
        try:
            with os.fdopen(handle, "w") as secret:
                json.dump(credentials, secret)
            command = DOCKER + [
                "run", "--rm", "--name", job_name, "--network", config["docker_network"],
                "--read-only", "--user", "0:0", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                "--pids-limit=64", "--memory=512m", "--cpus=0.5", "--tmpfs", "/tmp:rw,nosuid,noexec,size=16m",
                "--mount", "type=bind,source=%s,target=/run/video-cache-repair-database.json,readonly" % name,
                "--mount", "type=bind,source=%s,target=/run/video-cache-repair-config.json,readonly" % config_path,
                "--mount", "type=bind,source=%s,target=%s" % (state, state),
                config["repair_image"],
            ]
            if args.apply:
                command.append("--apply")
            result = subprocess.run(command, capture_output=True, text=True, timeout=38, check=False)
            if result.returncode:
                for line in result.stderr.splitlines():
                    try:
                        detail = json.loads(line)
                        if detail.get("error") == "video_cache_source_repair_failed":
                            safe = {"error": detail["error"]}
                            for key in ("kind", "code"):
                                value = detail.get(key)
                                if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_]{1,80}", value):
                                    safe[key] = value
                            print(json.dumps(safe), file=sys.stderr)
                    except (ValueError, AttributeError):
                        pass
                raise RuntimeError("Prisma job failed")
            summary = json.loads(result.stdout)
            if not args.apply or summary.get("applied") or summary.get("raced"):
                print(json.dumps(summary, separators=(",", ":")))
        finally:
            try:
                subprocess.run(DOCKER + ["rm", "-f", job_name], capture_output=True, timeout=5, check=False)
            finally:
                Path(name).unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Neither Docker/Prisma errors nor connection credentials reach logs.
        print(json.dumps({"error": "video_cache_job_failed", "kind": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
