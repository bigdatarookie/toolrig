import json
from datetime import datetime, timezone
import unittest

from scripts import toolrig_docker_temp_cleanup as cleanup


NOW = datetime(2026, 11, 13, 14, 0, tzinfo=timezone.utc)
TARGET_ID = "a" * 64
TASK_ID = "qitem-20261113140409-5b7659bf7e7030e2"
OWNER = "tools-automation@toolrig"


def valid_labels(**overrides):
    values = cleanup.build_labels(
        owner=OWNER, task_qitem=TASK_ID, expires_at="2026-11-12T14:00:00Z",
        now=datetime(2026, 11, 11, 14, 0, tzinfo=timezone.utc),
    )
    values.update(overrides)
    return values


def inspect_output(labels=None, *, status="exited", restart="no", size=71,
                   name="toolrig-temp-test"):
    labels = valid_labels() if labels is None else labels
    fields = [TARGET_ID, "/" + name, status, restart, size]
    fields.extend(labels.get(key) for key in cleanup.SAFE_LABEL_KEYS)
    return "\n".join(json.dumps(value) for value in fields)


class FakeRunner:
    def __init__(self, *, labels=None, task_state="done", status="exited", restart="no"):
        self.labels = valid_labels() if labels is None else labels
        self.task_state = task_state
        self.status = status
        self.restart = restart
        self.commands = []
        self.present = True
        self.replace_id = False

    def __call__(self, command, timeout):
        command = tuple(command)
        self.commands.append(command)
        if command[:3] == ("docker", "inspect", "--size"):
            output = inspect_output(
                self.labels, status=self.status, restart=self.restart,
            )
            if self.replace_id:
                output = output.replace(TARGET_ID, "b" * 64, 1)
            return output
        if command[:3] == ("rig", "queue", "show"):
            state = self.task_state
            pickup = "terminal" if state in cleanup.TERMINAL_STATES else "working"
            return json.dumps({
                "qitemId": TASK_ID,
                "tags": ["project:toolrig"],
                "state": state,
                "pickup": {"state": pickup},
                "sourceSession": "coordination-lead@toolrig",
                "destinationSession": OWNER,
            })
        if command[:3] == ("docker", "container", "ls") and "id=" in " ".join(command):
            return "" if not self.present else TARGET_ID + "\n"
        if command[:4] == ("docker", "container", "rm", TARGET_ID):
            self.present = False
            return TARGET_ID + "\n"
        if command[:3] == ("docker", "container", "ls"):
            return TARGET_ID + "\n" if self.present else ""
        raise AssertionError(command)


class DockerTempCleanupTests(unittest.TestCase):
    def setUp(self):
        self.now = lambda: NOW

    def test_labels_include_creation_owner_project_task_and_expiry(self):
        labels = cleanup.build_labels(
            owner=OWNER, task_qitem=TASK_ID, expires_at="2026-11-14T00:00:00+00:00", now=NOW,
        )
        self.assertEqual(labels[cleanup.LABELS["temporary"]], "true")
        self.assertEqual(labels[cleanup.LABELS["project"]], "toolrig")
        self.assertEqual(labels[cleanup.LABELS["owner"]], OWNER)
        self.assertEqual(labels[cleanup.LABELS["task"]], TASK_ID)
        self.assertEqual(labels[cleanup.LABELS["created"]], "2026-11-13T14:00:00Z")
        self.assertEqual(labels[cleanup.LABELS["expires"]], "2026-11-14T00:00:00Z")

    def test_labels_reject_non_toolrig_owner_and_invalid_expiry(self):
        with self.assertRaisesRegex(cleanup.CleanupError, "invalid_owner"):
            cleanup.build_labels(owner="operator@example.com", task_qitem=TASK_ID,
                                 expires_at="2026-11-14T00:00:00Z", now=NOW)
        with self.assertRaisesRegex(cleanup.CleanupError, "invalid_expiry"):
            cleanup.build_labels(owner=OWNER, task_qitem=TASK_ID,
                                 expires_at="2026-11-13T13:00:00Z", now=NOW)

    def test_default_exact_target_path_is_dry_run_and_never_removes(self):
        fake = FakeRunner()
        result = cleanup.DockerTempCleanup(fake, self.now).remove(
            "toolrig-temp-test", execute=False, confirm_target=None,
            owner_session=None, attestations=True,
        )
        self.assertEqual(result["mode"], "dry_run")
        self.assertEqual(result["resources"][0]["decision"], "eligible")
        self.assertFalse(any(command[:3] == ("docker", "container", "rm") for command in fake.commands))

    def test_inventory_is_read_only_and_preserves_explicitly_untrusted_containers(self):
        labels = valid_labels(**{cleanup.LABELS["project"]: "polar"})
        fake = FakeRunner(labels=labels)
        result = cleanup.DockerTempCleanup(fake, self.now).inventory(attestations=True)
        self.assertEqual(result["mode"], "dry_run")
        row = result["resources"][0]
        self.assertEqual(row["decision"], "preserve")
        self.assertIn("not_toolrig_owned", row["reasonCodes"])
        self.assertFalse(any(command[:3] == ("docker", "container", "rm") for command in fake.commands))

    def test_unexpired_or_malformed_retention_is_preserved(self):
        future = valid_labels(**{cleanup.LABELS["expires"]: "2026-11-15T00:00:00Z"})
        fake = FakeRunner(labels=future)
        result = cleanup.DockerTempCleanup(fake, self.now).remove(
            "toolrig-temp-test", execute=False, confirm_target=None,
            owner_session=None, attestations=True,
        )
        self.assertIn("retention_not_elapsed", result["resources"][0]["reasonCodes"])
        malformed = valid_labels(**{cleanup.LABELS["expires"]: "secret-value\nredacted"})
        fake = FakeRunner(labels=malformed)
        result = cleanup.DockerTempCleanup(fake, self.now).remove(
            "toolrig-temp-test", execute=False, confirm_target=None,
            owner_session=None, attestations=True,
        )
        encoded = json.dumps(result)
        self.assertNotIn("secret-value", encoded)
        self.assertIn("retention_metadata_invalid", encoded)

    def test_task_must_be_terminal_and_owned_by_label_owner(self):
        fake = FakeRunner(task_state="in-progress")
        result = cleanup.DockerTempCleanup(fake, self.now).remove(
            "toolrig-temp-test", execute=False, confirm_target=None,
            owner_session=None, attestations=True,
        )
        self.assertIn("task_not_terminal", result["resources"][0]["reasonCodes"])
        fake = FakeRunner()
        original = fake.__call__

        def wrong_owner_task(command, timeout):
            output = original(command, timeout)
            if tuple(command[:3]) == ("rig", "queue", "show"):
                return json.dumps({"state": "done", "pickup": {"state": "terminal"},
                                   "qitemId": TASK_ID, "tags": ["project:toolrig"],
                                   "sourceSession": "someone-else@toolrig",
                                   "destinationSession": "another@toolrig"})
            return output

        result = cleanup.DockerTempCleanup(wrong_owner_task, self.now).remove(
            "toolrig-temp-test", execute=False, confirm_target=None,
            owner_session=None, attestations=True,
        )
        self.assertIn("task_owner_mismatch", result["resources"][0]["reasonCodes"])

    def test_unstopped_or_restart_enabled_container_is_preserved(self):
        for status, restart, expected in (
            ("running", "no", "container_not_stopped"),
            ("exited", "always", "restart_policy_enabled"),
        ):
            fake = FakeRunner(status=status, restart=restart)
            result = cleanup.DockerTempCleanup(fake, self.now).remove(
                "toolrig-temp-test", execute=False, confirm_target=None,
                owner_session=None, attestations=True,
            )
            self.assertIn(expected, result["resources"][0]["reasonCodes"])

    def test_missing_attestations_preserve_and_do_not_remove(self):
        fake = FakeRunner()
        result = cleanup.DockerTempCleanup(fake, self.now).remove(
            "toolrig-temp-test", execute=True, confirm_target="toolrig-temp-test",
            owner_session=OWNER, attestations=False,
        )
        self.assertIn("safety_attestation_required", result["resources"][0]["reasonCodes"])
        self.assertTrue(fake.present)
        self.assertFalse(any(command[:3] == ("docker", "container", "rm") for command in fake.commands))

    def test_execute_requires_exact_confirmation_and_owner(self):
        for confirm, owner, expected in (
            ("another-name", OWNER, "exact_target_confirmation_mismatch"),
            ("toolrig-temp-test", "other-seat@toolrig", "caller_is_not_owner"),
        ):
            fake = FakeRunner()
            result = cleanup.DockerTempCleanup(fake, self.now).remove(
                "toolrig-temp-test", execute=True, confirm_target=confirm,
                owner_session=owner, attestations=True,
            )
            self.assertIn(expected, result["resources"][0]["reasonCodes"])
            self.assertTrue(fake.present)

    def test_exact_execution_revalidates_then_removes_one_full_id_and_receipts(self):
        fake = FakeRunner()
        result = cleanup.DockerTempCleanup(fake, self.now).remove(
            "toolrig-temp-test", execute=True, confirm_target="toolrig-temp-test",
            owner_session=OWNER, attestations=True,
        )
        self.assertEqual(result["resources"][0]["decision"], "removed")
        self.assertEqual(result["resources"][0]["before"]["writableLayerBytes"], 71)
        self.assertEqual(result["resources"][0]["after"]["state"], "absent")
        self.assertIsNone(result["resources"][0]["after"]["writableLayerBytes"])
        self.assertEqual(sum(command[:3] == ("docker", "inspect", "--size") for command in fake.commands), 2)
        self.assertIn(("docker", "container", "rm", TARGET_ID), fake.commands)
        self.assertFalse(fake.present)

    def test_revalidation_identity_change_aborts_before_remove(self):
        fake = FakeRunner()
        count = [0]
        original = fake.__call__

        def replace_on_second_inspect(command, timeout):
            if tuple(command[:3]) == ("docker", "inspect", "--size"):
                count[0] += 1
                if count[0] == 2:
                    fake.replace_id = True
            return original(command, timeout)

        result = cleanup.DockerTempCleanup(replace_on_second_inspect, self.now).remove(
            "toolrig-temp-test", execute=True, confirm_target="toolrig-temp-test",
            owner_session=OWNER, attestations=True,
        )
        self.assertIn("target_identity_changed", result["resources"][0]["reasonCodes"])
        self.assertFalse(any(command[:3] == ("docker", "container", "rm") for command in fake.commands))

    def test_denylisted_compose_project_and_name_are_preserved(self):
        labels = valid_labels(**{"com.docker.compose.project": "opentour-crm-local"})
        fake = FakeRunner(labels=labels)
        result = cleanup.DockerTempCleanup(fake, self.now).remove(
            "toolrig-temp-test", execute=False, confirm_target=None,
            owner_session=None, attestations=True,
        )
        self.assertIn("compose_project_not_toolrig", result["resources"][0]["reasonCodes"])

    def test_output_does_not_include_unapproved_labels_or_private_docker_errors(self):
        fake = FakeRunner()
        result = cleanup.DockerTempCleanup(fake, self.now).remove(
            "toolrig-temp-test", execute=False, confirm_target=None,
            owner_session=None, attestations=True,
        )
        self.assertNotIn("Config.Env", json.dumps(result))
        self.assertNotIn("mount", json.dumps(result).casefold())
        self.assertEqual(set(result["resources"][0]["before"]["labels"]), set(cleanup.SAFE_LABEL_KEYS))


if __name__ == "__main__":
    unittest.main()
