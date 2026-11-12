#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
openbao_root="$repo_root/services/openbao"

test -x "$openbao_root/bin/openbao"
test -f "$openbao_root/compose.yaml"
test -f "$openbao_root/config/server.hcl"
test -f "$openbao_root/config/agent.hcl"
test -x "$openbao_root/bin/consumer-check"
test -f "$openbao_root/tests/integration.sh"
grep -q 'down does not accept Compose arguments' "$openbao_root/bin/openbao"

mode_test_dir="$(mktemp -d "${TMPDIR:-/tmp}/toolrig-openbao-mode-test.XXXXXX")"
trap 'rm -rf "$mode_test_dir"' EXIT
: >"$mode_test_dir/bootstrap.json"
chmod 600 "$mode_test_dir/bootstrap.json"
TOOLRIG_OPENBAO_RECOVERY_DIR="$mode_test_dir" bash -c 'source "$1/bin/common.sh"; require_bootstrap' _ "$openbao_root"
rm -rf "$mode_test_dir"
trap - EXIT

config_json="$("$openbao_root/bin/openbao" config --format json)"
CONFIG_JSON="$config_json" python3 - <<'PY'
import json
import os

config = json.loads(os.environ["CONFIG_JSON"])
services = config["services"]
assert list(services) == ["openbao"], services.keys()
service = services["openbao"]
assert service["image"].endswith("@sha256:5046911075e137e154ce49ab051502f4ec7cf367d484ae4a4dce665d9b90561f")
assert service["ports"][0]["host_ip"] == "127.0.0.1"
assert service["read_only"] is True
assert service["environment"]["TMPDIR"] == "/openbao/file"
assert "cap_add" not in service
assert len(service["volumes"]) == 2
assert "/openbao/file" in {volume["target"] for volume in service["volumes"]}
PY

grep -q 'storage "raft"' "$openbao_root/config/server.hcl"
grep -q 'path *= *"/openbao/file"' "$openbao_root/config/server.hcl"
grep -q 'tls_disable *= *1' "$openbao_root/config/server.hcl"
if grep -q 'disable_mlock' "$openbao_root/config/server.hcl"; then
  echo "OpenBao 2.7.2 no longer accepts disable_mlock" >&2
  exit 1
fi
grep -q 'secret_id_file_path' "$openbao_root/config/agent.hcl"
grep -q 'env_template' "$openbao_root/config/agent.hcl"
grep -q 'error_on_missing_key *= *true' "$openbao_root/config/agent.hcl"

if grep -R -n -E 'dev_mode *= *true|dev *= *true|root_token *= *"[^"$]' "$openbao_root/compose.yaml" "$openbao_root/config"; then
  echo "unsafe persistent dev-mode or literal root token in tracked configuration" >&2
  exit 1
fi

echo "OpenBao deployment contract: PASS"
