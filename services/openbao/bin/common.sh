#!/usr/bin/env bash
set -euo pipefail

OPENBAO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENBAO_PROJECT="${TOOLRIG_OPENBAO_PROJECT:-toolrig-openbao}"
OPENBAO_PORT="${TOOLRIG_OPENBAO_PORT:-8200}"
OPENBAO_BIND="${TOOLRIG_OPENBAO_BIND:-127.0.0.1}"
OPENBAO_ADDR="${TOOLRIG_OPENBAO_ADDR:-http://${OPENBAO_BIND}:${OPENBAO_PORT}}"
OPENBAO_STATE_DIR="${TOOLRIG_OPENBAO_STATE_DIR:-${OPENRIG_HOME:-$HOME/.openrig}/services/toolrig/openbao}"
OPENBAO_RECOVERY_DIR="${TOOLRIG_OPENBAO_RECOVERY_DIR:-${OPENRIG_HOME:-$HOME/.openrig}/recovery/toolrig/openbao}"
OPENBAO_BACKUP_DIR="${TOOLRIG_OPENBAO_BACKUP_DIR:-$OPENBAO_STATE_DIR/backups}"
OPENBAO_BOOTSTRAP_FILE="$OPENBAO_RECOVERY_DIR/bootstrap.json"

export TOOLRIG_OPENBAO_PROJECT="$OPENBAO_PROJECT"
export TOOLRIG_OPENBAO_PORT="$OPENBAO_PORT"
export TOOLRIG_OPENBAO_BIND="$OPENBAO_BIND"

compose() {
  local files=(-f "$OPENBAO_ROOT/compose.yaml")
  if [[ -n "${TOOLRIG_OPENBAO_COMPOSE_OVERRIDE:-}" ]]; then
    files+=(-f "$TOOLRIG_OPENBAO_COMPOSE_OVERRIDE")
  fi
  docker compose -p "$OPENBAO_PROJECT" "${files[@]}" "$@"
}

ensure_private_dirs() {
  umask 077
  mkdir -p "$OPENBAO_STATE_DIR" "$OPENBAO_RECOVERY_DIR" "$OPENBAO_BACKUP_DIR"
  chmod 700 "$OPENBAO_STATE_DIR" "$OPENBAO_RECOVERY_DIR" "$OPENBAO_BACKUP_DIR"
}

require_bootstrap() {
  if [[ ! -f "$OPENBAO_BOOTSTRAP_FILE" ]]; then
    printf 'bootstrap recovery file is absent: %s\n' "$OPENBAO_BOOTSTRAP_FILE" >&2
    return 1
  fi
  local mode
  mode="$(stat -c '%a' "$OPENBAO_BOOTSTRAP_FILE" 2>/dev/null)" ||
    mode="$(stat -f '%Lp' "$OPENBAO_BOOTSTRAP_FILE")"
  if [[ "$mode" != "600" ]]; then
    printf 'bootstrap recovery file must have mode 0600\n' >&2
    return 1
  fi
}

root_bao() {
  require_bootstrap
  local token
  token="$(jq -er '.root_token | select(type == "string" and length > 0)' "$OPENBAO_BOOTSTRAP_FILE")"
  BAO_TOKEN="$token" compose exec -T -e BAO_TOKEN openbao bao "$@"
}

root_api() {
  require_bootstrap
  local token
  token="$(jq -er '.root_token | select(type == "string" and length > 0)' "$OPENBAO_BOOTSTRAP_FILE")"
  printf 'header = "X-Vault-Token: %s"\n' "$token" |
    curl --disable --config - --fail --silent --show-error \
      --connect-timeout 5 --max-time "${TOOLRIG_OPENBAO_SNAPSHOT_TIMEOUT:-1800}" "$@"
  unset token
}
