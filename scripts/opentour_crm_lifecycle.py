#!/usr/bin/env python3
"""Bounded lifecycle exercise for OpenTour's existing local CRM Compose project.

This adapter intentionally targets only ``opentour-crm-local``. It does not
read CRM credentials or mutate Contacts. For ``exercise``, the operator must
first verify the task-owned synthetic Contact through OpenTour's authorized
CRM path, then verify that exact Contact again after the service operation.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Sequence


PROJECT = "opentour-crm-local"
COMPOSE_FILE = "/Users/garry/Documents/git/opentour/local/crm/compose.yaml"
SERVICES = ("app", "daemon", "db")
CONTAINER_NAMES = {service: f"{PROJECT}-{service}-1" for service in SERVICES}
DB_HEALTH_TIMEOUT_SECONDS = 100
APP_HEALTH_TIMEOUT_SECONDS = 220
POLL_INTERVAL_SECONDS = 5


class LifecycleError(Exception):
    """Safe-to-report lifecycle error without command output or credentials."""

    def __init__(self, code: str, detail: str | None = None):
        super().__init__(code)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class ServiceState:
    service: str
    name: str
    container_id: str
    state: str
    health: str

    def public(self) -> dict[str, str]:
        return {
            "container": self.name,
            "containerId": self.container_id,
            "state": self.state,
            "health": self.health,
        }


def _decode_ps(output: str) -> list[dict[str, object]]:
    """Decode Compose's newline-delimited JSON output (or one JSON array)."""
    stripped = output.strip()
    if not stripped:
        return []
    try:
        if stripped.startswith("["):
            value = json.loads(stripped)
            if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
                raise LifecycleError("invalid_compose_status")
            return value
        rows = []
        for line in stripped.splitlines():
            value = json.loads(line)
            if not isinstance(value, dict):
                raise LifecycleError("invalid_compose_status")
            rows.append(value)
    except json.JSONDecodeError:
        raise LifecycleError("invalid_compose_status") from None
    return rows


def _project_label(labels: object) -> str | None:
    if isinstance(labels, dict):
        value = labels.get("com.docker.compose.project")
        return str(value) if value is not None else None
    if isinstance(labels, str):
        prefix = "com.docker.compose.project="
        for label in labels.split(","):
            if label.startswith(prefix):
                return label[len(prefix):]
    return None


class OpenTourCRMLifecycle:
    def __init__(
        self,
        command_runner: Callable[[Sequence[str], int], str] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ):
        self._command_runner = command_runner or self._run_command
        self._sleep = sleep
        self._monotonic = monotonic

    @staticmethod
    def _run_command(command: Sequence[str], timeout: int) -> str:
        try:
            result = subprocess.run(
                list(command),
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            raise LifecycleError("docker_command_timeout", command[1] if len(command) > 1 else None) from None
        except OSError:
            raise LifecycleError("docker_unavailable") from None
        if result.returncode != 0:
            # Docker stdout/stderr may contain labels, mounts, or private paths.
            operation = command[1] if len(command) > 1 else "unknown"
            raise LifecycleError("docker_command_failed", operation)
        return result.stdout

    @staticmethod
    def _compose(*arguments: str) -> list[str]:
        return [
            "docker", "compose", "--project-name", PROJECT,
            "-f", COMPOSE_FILE, *arguments,
        ]

    def _run(self, command: Sequence[str], timeout: int = 30) -> str:
        try:
            return self._command_runner(command, timeout)
        except LifecycleError:
            raise
        except Exception:
            raise LifecycleError("command_runner_failed") from None

    def _states(self) -> dict[str, ServiceState]:
        output = self._run(self._compose("ps", "--all", "--format", "json"))
        rows = _decode_ps(output)
        expected_names = set(CONTAINER_NAMES.values())
        services: dict[str, ServiceState] = {}
        for row in rows:
            service = row.get("Service")
            name = row.get("Name") or row.get("Names")
            if isinstance(name, str) and name.startswith("/"):
                name = name[1:]
            project = row.get("Project")
            label_project = _project_label(row.get("Labels"))
            container_id = row.get("ID")
            if (
                service not in SERVICES
                or not isinstance(name, str)
                or name != CONTAINER_NAMES.get(str(service))
                or project != PROJECT
                or label_project != PROJECT
                or not isinstance(container_id, str)
                or not container_id
                or service in services
            ):
                raise LifecycleError("target_identity_mismatch")
            services[str(service)] = ServiceState(
                service=str(service),
                name=name,
                container_id=container_id,
                state=str(row.get("State", "unknown")).lower(),
                health=str(row.get("Health", "none")).lower(),
            )
        if set(services) != set(SERVICES) or {state.name for state in services.values()} != expected_names:
            raise LifecycleError("target_service_set_mismatch")

        # Include stopped and orphaned containers carrying this exact project
        # label; an old duplicate must not be hidden by Compose's service view.
        names_output = self._run([
            "docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={PROJECT}",
            "--format", "{{.Names}}",
        ])
        names = {line.strip().lstrip("/") for line in names_output.splitlines() if line.strip()}
        if names != expected_names:
            raise LifecycleError("project_container_set_mismatch")
        return services

    @staticmethod
    def _require_healthy(states: dict[str, ServiceState], services: Iterable[str]) -> None:
        for service in services:
            state = states.get(service)
            if state is None or state.state != "running" or state.health != "healthy":
                raise LifecycleError("service_not_healthy", service)

    def _wait_healthy(self, services: Iterable[str], timeout: int) -> dict[str, ServiceState]:
        required = tuple(services)
        deadline = self._monotonic() + timeout
        while True:
            states = self._states()
            if all(
                states[service].state == "running" and states[service].health == "healthy"
                for service in required
            ):
                return states
            if self._monotonic() >= deadline:
                raise LifecycleError("health_check_window_expired", ",".join(required))
            self._sleep(POLL_INTERVAL_SECONDS)

    def _app_check(self) -> None:
        self._run(self._compose("exec", "-T", "app", "bin/command", "app-check"), timeout=90)

    def status(self) -> dict[str, object]:
        states = self._states()
        self._require_healthy(states, SERVICES)
        self._app_check()
        return {
            "project": PROJECT,
            "services": {service: states[service].public() for service in SERVICES},
            "appCheck": "passed",
        }

    def exercise_restart(
        self,
        *,
        quiet_window_confirmed: bool,
        sentinel_read_before_confirmed: bool,
        sentinel_id: str,
    ) -> dict[str, object]:
        if not quiet_window_confirmed:
            raise LifecycleError("quiet_window_confirmation_required")
        if not sentinel_read_before_confirmed or not sentinel_id.strip():
            raise LifecycleError("verified_sentinel_required")

        before = self._states()
        self._require_healthy(before, SERVICES)
        original_ids = {service: before[service].container_id for service in SERVICES}

        self._run(self._compose("stop", "--timeout", "30", "app"), timeout=45)
        stopped = self._states()
        if stopped["app"].state not in ("exited", "stopped"):
            raise LifecycleError("app_stop_not_observed")
        self._run(self._compose("restart", "--timeout", "30", "db"), timeout=60)
        db_ready = self._wait_healthy(("db",), DB_HEALTH_TIMEOUT_SECONDS)
        self._run(self._compose("start", "app"), timeout=45)
        after = self._wait_healthy(SERVICES, APP_HEALTH_TIMEOUT_SECONDS)
        if any(after[service].container_id != original_ids[service] for service in SERVICES):
            raise LifecycleError("container_recreated_unexpectedly")
        self._app_check()
        return {
            "project": PROJECT,
            "operation": "stop-app_restart-db_start-app",
            "services": {service: after[service].public() for service in SERVICES},
            "databaseHealth": db_ready["db"].health,
            "appCheck": "passed",
            "sentinelReadBefore": "operator_confirmed",
            "sentinelReadAfter": "required_outside_adapter",
        }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("status", "exercise-restart"))
    parser.add_argument("--confirm-quiet-window", action="store_true")
    parser.add_argument("--sentinel-id")
    parser.add_argument("--confirm-sentinel-read-before", action="store_true")
    args = parser.parse_args(argv)
    adapter = OpenTourCRMLifecycle()
    try:
        if args.action == "status":
            result = adapter.status()
        else:
            result = adapter.exercise_restart(
                quiet_window_confirmed=args.confirm_quiet_window,
                sentinel_read_before_confirmed=args.confirm_sentinel_read_before,
                sentinel_id=args.sentinel_id or "",
            )
        print(json.dumps(result, sort_keys=True))
        return 0
    except LifecycleError as exc:
        result = {"project": PROJECT, "outcome": "stopped", "error": exc.code}
        if exc.detail:
            result["detail"] = exc.detail
        print(json.dumps(result, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
