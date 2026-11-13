#!/usr/bin/env python3
"""Dry-run-first cleanup for explicitly owned Toolrig temporary containers.

This helper never prunes. It only inspects Docker containers and, after an
exact-target opt-in plus owner/task/safety checks, removes one stopped
container by its full immutable ID. It never inspects environment values or
mount source paths.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import re
import subprocess
import sys
from typing import Callable, Sequence


LABELS = {
    "temporary": "io.toolrig.temporary",
    "project": "io.toolrig.project",
    "owner": "io.toolrig.owner",
    "task": "io.toolrig.task-qitem",
    "created": "io.toolrig.created-at",
    "expires": "io.toolrig.expires-at",
}
SAFE_LABEL_KEYS = tuple(LABELS.values()) + ("com.docker.compose.project",)
TERMINAL_STATES = {"done", "handed-off", "canceled", "denied", "failed"}
DENIED_PROJECTS = {
    "openbao", "toolrig-openbao", "opentour", "opentour-crm-local", "polar", "t2s",
}
DENIED_NAME_PREFIXES = (
    "openbao-", "toolrig-openbao-", "opentour-", "polar-", "t2s-",
)
CONTAINER_ID = re.compile(r"^[0-9a-f]{64}$")
CONTAINER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
QITEM_ID = re.compile(r"^qitem-[A-Za-z0-9-]{8,80}$")
OWNER = re.compile(r"^[A-Za-z0-9._-]+@toolrig$")
SAFE_LABEL_VALUE = re.compile(r"^[A-Za-z0-9@._:+/-]{1,160}$")


class CleanupError(Exception):
    """An operation failure safe to serialize without private command output."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _run(command: Sequence[str], timeout: int = 10) -> str:
    try:
        result = subprocess.run(
            list(command), capture_output=True, text=True, timeout=timeout, check=False
        )
    except subprocess.TimeoutExpired:
        raise CleanupError("command_timeout") from None
    except OSError:
        raise CleanupError("command_unavailable") from None
    if result.returncode:
        # Never surface stderr/stdout: Docker errors may contain private paths.
        raise CleanupError("command_failed")
    return result.stdout


def _parse_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value or not SAFE_LABEL_VALUE.fullmatch(value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc)


def _utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def build_labels(*, owner: str, task_qitem: str, expires_at: str,
                 now: datetime | None = None) -> dict[str, str]:
    """Return immutable Docker labels to attach on container creation."""
    if not OWNER.fullmatch(owner):
        raise CleanupError("invalid_owner")
    if not QITEM_ID.fullmatch(task_qitem):
        raise CleanupError("invalid_task_qitem")
    created = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    expiry = _parse_datetime(expires_at)
    if expiry is None or expiry <= created:
        raise CleanupError("invalid_expiry")
    return {
        LABELS["temporary"]: "true",
        LABELS["project"]: "toolrig",
        LABELS["owner"]: owner,
        LABELS["task"]: task_qitem,
        LABELS["created"]: _utc_text(created),
        LABELS["expires"]: _utc_text(expiry),
    }


def _docker_inspect_template() -> str:
    # Request only fields this policy needs. In particular, do not read .Config.Env,
    # command arguments, arbitrary labels, or mount source paths.
    fields = [
        ".Id", ".Name", ".State.Status", ".HostConfig.RestartPolicy.Name", ".SizeRw",
    ]
    pieces = ["{{json " + field + "}}" for field in fields]
    for key in SAFE_LABEL_KEYS:
        pieces.append(
            '{{if index .Config.Labels "' + key + '"}}'
            '{{json (index .Config.Labels "' + key + '")}}{{else}}null{{end}}'
        )
    return "\n".join(pieces)


def _decode_inspect(output: str) -> dict[str, object]:
    lines = output.splitlines()
    if len(lines) != 5 + len(SAFE_LABEL_KEYS):
        raise CleanupError("invalid_inspect_result")
    try:
        values = [json.loads(line) for line in lines]
    except json.JSONDecodeError:
        raise CleanupError("invalid_inspect_result") from None
    labels = dict(zip(SAFE_LABEL_KEYS, values[5:]))
    container_id, name, status, restart, writable = values[:5]
    if (
        not isinstance(container_id, str) or not CONTAINER_ID.fullmatch(container_id)
        or not isinstance(name, str) or not isinstance(status, str)
        or not isinstance(restart, str) or (writable is not None and not isinstance(writable, int))
        or (isinstance(writable, int) and writable < 0)
        or any(value is not None and not isinstance(value, str) for value in labels.values())
    ):
        raise CleanupError("invalid_inspect_result")
    return {
        "id": container_id,
        "name": name.removeprefix("/"),
        "status": status,
        "restartPolicy": restart,
        "writableLayerBytes": writable,
        "labels": labels,
    }


def _safe_label(value: object) -> str | None:
    if not isinstance(value, str) or not SAFE_LABEL_VALUE.fullmatch(value):
        return None
    return value


def _public_labels(container: dict[str, object]) -> dict[str, str | None]:
    labels = container["labels"]
    assert isinstance(labels, dict)
    return {key: _safe_label(labels.get(key)) for key in SAFE_LABEL_KEYS}


class DockerTempCleanup:
    def __init__(self, command_runner: Callable[[Sequence[str], int], str] = _run,
                 now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)):
        self._command_runner = command_runner
        self._now = now

    def _run(self, command: Sequence[str], timeout: int = 10) -> str:
        try:
            return self._command_runner(command, timeout)
        except CleanupError:
            raise
        except Exception:
            raise CleanupError("command_runner_failed") from None

    def _inspect(self, target: str) -> dict[str, object]:
        if not (CONTAINER_ID.fullmatch(target) or CONTAINER_NAME.fullmatch(target)):
            raise CleanupError("invalid_exact_target")
        output = self._run([
            "docker", "inspect", "--size", "--type", "container",
            "--format", _docker_inspect_template(), target,
        ])
        container = _decode_inspect(output)
        if CONTAINER_ID.fullmatch(target):
            matches = container["id"] == target
        else:
            matches = container["name"] == target
        if not matches:
            raise CleanupError("exact_target_mismatch")
        return container

    def _task(self, task_id: str) -> dict[str, object] | None:
        if not QITEM_ID.fullmatch(task_id):
            return None
        try:
            output = self._run(["rig", "queue", "show", task_id, "--full", "--json"])
            value = json.loads(output)
        except (CleanupError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    def _decision(self, container: dict[str, object], *, attestations: bool) -> list[str]:
        labels = container["labels"]
        assert isinstance(labels, dict)
        safe = _public_labels(container)
        reasons: list[str] = []
        if safe.get(LABELS["temporary"]) != "true":
            reasons.append("temporary_label_missing_or_invalid")
        if safe.get(LABELS["project"]) != "toolrig":
            reasons.append("not_toolrig_owned")
        owner = safe.get(LABELS["owner"])
        if owner is None or not OWNER.fullmatch(owner):
            reasons.append("owner_missing_or_invalid")
        elif not CONTAINER_NAME.fullmatch(str(container["name"])):
            reasons.append("container_name_invalid")
        task_id = safe.get(LABELS["task"])
        if task_id is None or not QITEM_ID.fullmatch(task_id):
            reasons.append("task_identity_missing_or_invalid")
        compose_project = safe.get("com.docker.compose.project")
        raw_compose_project = labels.get("com.docker.compose.project")
        if raw_compose_project is not None and compose_project is None:
            reasons.append("compose_project_invalid")
        denied = {name.casefold() for name in DENIED_PROJECTS}
        if compose_project is not None and (
            compose_project.casefold() in denied or compose_project.casefold() != "toolrig"
        ):
            reasons.append("compose_project_not_toolrig")
        name = str(container["name"]).casefold()
        if (any(name == project or name.startswith(project + "-") for project in denied)
                or name.startswith(DENIED_NAME_PREFIXES)):
            reasons.append("protected_project_name")

        created = _parse_datetime(safe.get(LABELS["created"]))
        expiry = _parse_datetime(safe.get(LABELS["expires"]))
        if created is None or expiry is None or expiry < created:
            reasons.append("retention_metadata_invalid")
        elif expiry > self._now().astimezone(timezone.utc):
            reasons.append("retention_not_elapsed")

        if container["status"] not in {"created", "exited"}:
            reasons.append("container_not_stopped")
        if container["restartPolicy"] not in {"", "no"}:
            reasons.append("restart_policy_enabled")

        task = self._task(task_id or "")
        if task is None:
            reasons.append("task_state_unknown")
        else:
            pickup = task.get("pickup")
            destination = task.get("destinationSession")
            state = task.get("state")
            if task.get("qitemId") != task_id:
                reasons.append("task_identity_mismatch")
            tags = task.get("tags")
            if not isinstance(tags, list) or "project:toolrig" not in tags:
                reasons.append("task_not_toolrig")
            if not isinstance(pickup, dict) or pickup.get("state") != "terminal" or state not in TERMINAL_STATES:
                reasons.append("task_not_terminal")
            if owner != destination:
                reasons.append("task_owner_mismatch")
        if not attestations:
            reasons.append("safety_attestation_required")
        return reasons

    @staticmethod
    def _receipt(container: dict[str, object], reasons: list[str], *, after: dict[str, object] | None = None) -> dict[str, object]:
        public_before = {
            "id": container["id"],
            "name": container["name"],
            "state": container["status"],
            "writableLayerBytes": container["writableLayerBytes"],
            "labels": _public_labels(container),
        }
        return {
            "targetId": container["id"],
            "decision": "eligible" if not reasons else "preserve",
            "reasonCodes": reasons,
            "before": public_before,
            "after": after or {"state": "not_attempted", "writableLayerBytes": None},
        }

    def inventory(self, *, attestations: bool = False) -> dict[str, object]:
        output = self._run([
            "docker", "container", "ls", "--all", "--no-trunc",
            "--filter", f"label={LABELS['temporary']}", "--format", "{{.ID}}",
        ])
        targets = [line.strip() for line in output.splitlines() if line.strip()]
        resources = []
        for target in targets:
            try:
                container = self._inspect(target)
                reasons = self._decision(container, attestations=attestations)
                resources.append(self._receipt(container, reasons))
            except CleanupError as error:
                resources.append({
                    "targetId": target if CONTAINER_ID.fullmatch(target) else None,
                    "decision": "preserve",
                    "reasonCodes": [error.code],
                    "before": None,
                    "after": {"state": "not_attempted", "writableLayerBytes": None},
                })
        return {"schemaVersion": 1, "mode": "dry_run", "resourceCount": len(resources), "resources": resources}

    def remove(self, target: str, *, execute: bool, confirm_target: str | None,
               owner_session: str | None, attestations: bool) -> dict[str, object]:
        try:
            container = self._inspect(target)
        except CleanupError as error:
            return {"schemaVersion": 1, "mode": "execute" if execute else "dry_run",
                    "resourceCount": 1, "resources": [{"targetId": None, "decision": "preserve",
                    "reasonCodes": [error.code], "before": None,
                    "after": {"state": "not_attempted", "writableLayerBytes": None}}]}
        reasons = self._decision(container, attestations=attestations)
        if execute:
            if confirm_target != target:
                reasons.append("exact_target_confirmation_mismatch")
            if owner_session is None:
                reasons.append("caller_identity_unknown")
            elif _public_labels(container).get(LABELS["owner"]) != owner_session:
                reasons.append("caller_is_not_owner")
        if not execute or reasons:
            row = self._receipt(container, reasons)
            row["decision"] = "eligible" if not reasons else "preserve"
            return {"schemaVersion": 1, "mode": "dry_run" if not execute else "execute",
                    "resourceCount": 1, "resources": [row]}

        # Re-read container, queue state, labels, and expiry immediately before the
        # destructive call. Remove only by the full ID observed in the fresh read.
        fresh = self._inspect(target)
        fresh_reasons = self._decision(fresh, attestations=attestations)
        if fresh["id"] != container["id"]:
            fresh_reasons.append("target_identity_changed")
        if owner_session is None or _public_labels(fresh).get(LABELS["owner"]) != owner_session:
            fresh_reasons.append("caller_is_not_owner")
        if confirm_target != target:
            fresh_reasons.append("exact_target_confirmation_mismatch")
        if fresh_reasons:
            row = self._receipt(fresh, fresh_reasons)
            return {"schemaVersion": 1, "mode": "execute", "resourceCount": 1, "resources": [row]}

        try:
            self._run(["docker", "container", "rm", fresh["id"]])
        except CleanupError as error:
            try:
                remaining_after_error = self._run([
                    "docker", "container", "ls", "--all", "--no-trunc",
                    "--filter", f"id={fresh['id']}", "--format", "{{.ID}}",
                ])
                still_present = any(
                    line.strip() == fresh["id"] for line in remaining_after_error.splitlines()
                )
                after_state = "present" if still_present else "absent"
            except CleanupError:
                after_state = "unknown"
            row = self._receipt(fresh, [error.code], after={
                "state": after_state,
                "writableLayerBytes": None,
                "writableLayerAccounting": "not_observable_after_command_failure",
            })
            row["decision"] = "preserve" if after_state == "present" else "indeterminate"
            return {"schemaVersion": 1, "mode": "execute", "resourceCount": 1, "resources": [row]}
        try:
            remaining = self._run([
                "docker", "container", "ls", "--all", "--no-trunc",
                "--filter", f"id={fresh['id']}", "--format", "{{.ID}}",
            ])
        except CleanupError as error:
            row = self._receipt(fresh, [error.code], after={
                "state": "unknown",
                "writableLayerBytes": None,
                "writableLayerAccounting": "not_observable_after_verification_failure",
            })
            row["decision"] = "indeterminate"
            return {"schemaVersion": 1, "mode": "execute", "resourceCount": 1, "resources": [row]}
        remaining_ids = [line.strip() for line in remaining.splitlines() if line.strip()]
        after_state = "absent" if not remaining_ids else "present"
        row = self._receipt(fresh, [], after={
            "state": after_state,
            "writableLayerBytes": None,
            "writableLayerAccounting": "not_applicable_after_target_absence",
        })
        row["decision"] = "removed" if after_state == "absent" else "remove_unverified"
        if remaining_ids:
            row["reasonCodes"] = ["target_still_present_after_remove"]
        return {"schemaVersion": 1, "mode": "execute", "resourceCount": 1, "resources": [row]}


def _current_session() -> str | None:
    try:
        value = json.loads(_run(["rig", "whoami", "--json"], timeout=10))
    except (CleanupError, json.JSONDecodeError):
        return None
    identity = value.get("identity") if isinstance(value, dict) else None
    sender = identity.get("senderAddress") if isinstance(identity, dict) else None
    return sender if isinstance(sender, str) and OWNER.fullmatch(sender) else None


def _add_attestations(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--attest-no-live-consumers", action="store_true")
    parser.add_argument("--attest-rollback-complete", action="store_true")
    parser.add_argument("--attest-evidence-preserved", action="store_true")


def _attestations(args: argparse.Namespace) -> bool:
    return bool(
        args.attest_no_live_consumers
        and args.attest_rollback_complete
        and args.attest_evidence_preserved
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command")
    inventory = subparsers.add_parser("inventory", help="read-only dry-run inventory (default)")
    _add_attestations(inventory)
    labels = subparsers.add_parser("labels", help="print immutable labels to use at container creation")
    labels.add_argument("--task-qitem", required=True)
    labels.add_argument("--expires-at", required=True, help="RFC3339 timestamp with timezone")
    remove = subparsers.add_parser("remove", help="dry-run one exact target; execution is explicit")
    remove.add_argument("--target", required=True, help="exact container name or full 64-character ID")
    remove.add_argument("--execute", action="store_true", help="explicit destructive invocation")
    remove.add_argument("--confirm-target", help="must exactly repeat --target")
    _add_attestations(remove)
    args = parser.parse_args(argv)
    service = DockerTempCleanup()

    try:
        if args.command == "labels":
            owner = _current_session()
            if owner is None:
                raise CleanupError("caller_identity_unknown")
            result = build_labels(owner=owner, task_qitem=args.task_qitem, expires_at=args.expires_at)
        elif args.command == "remove":
            result = service.remove(
                args.target, execute=args.execute, confirm_target=args.confirm_target,
                owner_session=_current_session() if args.execute else None,
                attestations=_attestations(args),
            )
        elif args.command == "inventory":
            result = service.inventory(attestations=_attestations(args))
        else:
            result = service.inventory()
    except CleanupError as error:
        result = {"schemaVersion": 1, "mode": "error", "resourceCount": 0,
                  "resources": [], "errorCode": error.code}
        print(json.dumps(result, sort_keys=True))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0 if result.get("mode") != "execute" or all(
        item.get("decision") == "removed" for item in result.get("resources", [])
    ) else 2


if __name__ == "__main__":
    raise SystemExit(main())
