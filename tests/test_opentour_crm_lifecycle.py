import json
import unittest
from unittest import mock

from scripts import opentour_crm_lifecycle as lifecycle


def status_rows(*, health_overrides=None, state_overrides=None, id_overrides=None):
    health_overrides = health_overrides or {}
    state_overrides = state_overrides or {}
    id_overrides = id_overrides or {}
    rows = []
    for index, service in enumerate(lifecycle.SERVICES, start=1):
        rows.append({
            "ID": id_overrides.get(service, f"id-{service}"),
            "Name": lifecycle.CONTAINER_NAMES[service],
            "Service": service,
            "Project": lifecycle.PROJECT,
            "State": state_overrides.get(service, "running"),
            "Health": health_overrides.get(service, "healthy"),
            "Labels": (
                f"com.docker.compose.project={lifecycle.PROJECT},"
                f"com.docker.compose.service={service}"
            ),
        })
    return rows


class FakeDocker:
    def __init__(self):
        self.rows = status_rows()
        self.commands = []
        self.extra_names = []

    def __call__(self, command, timeout):
        self.commands.append(tuple(command))
        if tuple(command[:3]) == ("docker", "compose", "--project-name") and "ps" in command:
            return "\n".join(json.dumps(row) for row in self.rows)
        if tuple(command[:3]) == ("docker", "ps", "-a"):
            return "\n".join(
                [row["Name"] for row in self.rows] + list(self.extra_names)
            )
        if "stop" in command and command[-1] == "app":
            for row in self.rows:
                if row["Service"] == "app":
                    row["State"] = "exited"
                    row["Health"] = "none"
            return ""
        if "restart" in command and command[-1] == "db":
            return ""
        if "start" in command and command[-1] == "app":
            for row in self.rows:
                if row["Service"] == "app":
                    row["State"] = "running"
                    row["Health"] = "healthy"
            return ""
        return ""


class OpenTourCRMLifecycleTests(unittest.TestCase):
    def test_status_checks_exact_project_identity_health_and_app_readiness(self):
        fake = FakeDocker()
        adapter = lifecycle.OpenTourCRMLifecycle(command_runner=fake)

        result = adapter.status()

        self.assertEqual(result["project"], "opentour-crm-local")
        self.assertEqual(set(result["services"]), {"app", "daemon", "db"})
        self.assertEqual(result["appCheck"], "passed")
        self.assertTrue(any("app-check" in command for command in fake.commands))

    def test_status_fails_closed_on_unexpected_project_container(self):
        fake = FakeDocker()
        fake.extra_names = ["opentour-crm-local-app-2"]
        adapter = lifecycle.OpenTourCRMLifecycle(command_runner=fake)

        with self.assertRaisesRegex(lifecycle.LifecycleError, "project_container_set_mismatch"):
            adapter.status()

    def test_status_fails_closed_on_wrong_project_label(self):
        fake = FakeDocker()
        fake.rows[0]["Project"] = "another-project"
        fake.rows[0]["Labels"] = "com.docker.compose.project=another-project"
        adapter = lifecycle.OpenTourCRMLifecycle(command_runner=fake)

        with self.assertRaisesRegex(lifecycle.LifecycleError, "target_identity_mismatch"):
            adapter.status()

    def test_exercise_requires_current_quiet_window_and_verified_sentinel_before_commands(self):
        fake = FakeDocker()
        adapter = lifecycle.OpenTourCRMLifecycle(command_runner=fake)

        with self.assertRaisesRegex(lifecycle.LifecycleError, "quiet_window_confirmation_required"):
            adapter.exercise_restart(
                quiet_window_confirmed=False,
                sentinel_read_before_confirmed=True,
                sentinel_id="synthetic-id",
            )
        with self.assertRaisesRegex(lifecycle.LifecycleError, "verified_sentinel_required"):
            adapter.exercise_restart(
                quiet_window_confirmed=True,
                sentinel_read_before_confirmed=False,
                sentinel_id="synthetic-id",
            )
        self.assertEqual(fake.commands, [])

    def test_exercise_uses_only_bounded_stop_restart_start_sequence(self):
        fake = FakeDocker()
        now = [0.0]

        def sleep(seconds):
            now[0] += seconds

        adapter = lifecycle.OpenTourCRMLifecycle(
            command_runner=fake,
            sleep=sleep,
            monotonic=lambda: now[0],
        )
        result = adapter.exercise_restart(
            quiet_window_confirmed=True,
            sentinel_read_before_confirmed=True,
            sentinel_id="contact-private-id-123",
        )

        actions = [
            command[command.index("--project-name") + 4:]
            for command in fake.commands
            if "stop" in command or "restart" in command or "start" in command
        ]
        self.assertEqual(actions, [("stop", "--timeout", "30", "app"),
                                    ("restart", "--timeout", "30", "db"),
                                    ("start", "app")])
        self.assertEqual(result["operation"], "stop-app_restart-db_start-app")
        self.assertEqual(result["appCheck"], "passed")
        self.assertNotIn("contact-private-id-123", json.dumps(result))
        self.assertEqual(result["sentinelReadAfter"], "required_outside_adapter")
        self.assertTrue(any("app-check" in command for command in fake.commands))
        forbidden = {"down", "pull", "build", "up"}
        self.assertFalse(any(forbidden.intersection(command) for command in fake.commands))

    def test_database_health_timeout_stops_before_restarting_app(self):
        fake = FakeDocker()
        restart_seen = [False]
        original_call = fake.__call__

        def unhealthy_db(command, timeout):
            output = original_call(command, timeout)
            if "restart" in command and command[-1] == "db":
                restart_seen[0] = True
                for row in fake.rows:
                    if row["Service"] == "db":
                        row["Health"] = "starting"
            return output

        now = [0.0]
        with mock.patch.object(lifecycle, "DB_HEALTH_TIMEOUT_SECONDS", 1):
            adapter = lifecycle.OpenTourCRMLifecycle(
                command_runner=unhealthy_db,
                sleep=lambda seconds: now.__setitem__(0, now[0] + seconds),
                monotonic=lambda: now[0],
            )
            with self.assertRaisesRegex(lifecycle.LifecycleError, "health_check_window_expired"):
                adapter.exercise_restart(
                    quiet_window_confirmed=True,
                    sentinel_read_before_confirmed=True,
                    sentinel_id="synthetic-id",
                )
        self.assertTrue(restart_seen[0])
        self.assertFalse(any("start" in command and command[-1] == "app" for command in fake.commands))

    def test_exercise_rejects_container_recreation(self):
        fake = FakeDocker()
        original_call = fake.__call__

        def recreated_app(command, timeout):
            output = original_call(command, timeout)
            if "start" in command and command[-1] == "app":
                for row in fake.rows:
                    if row["Service"] == "app":
                        row["ID"] = "new-app-id"
            return output

        adapter = lifecycle.OpenTourCRMLifecycle(command_runner=recreated_app)
        with self.assertRaisesRegex(lifecycle.LifecycleError, "container_recreated_unexpectedly"):
            adapter.exercise_restart(
                quiet_window_confirmed=True,
                sentinel_read_before_confirmed=True,
                sentinel_id="synthetic-id",
            )


if __name__ == "__main__":
    unittest.main()
