vault {
  address = "http://openbao:8200"
}

auto_auth {
  method "approle" {
    config = {
      role_id_file_path                = "/run/openbao/credentials/role_id"
      secret_id_file_path              = "/run/openbao/credentials/secret_id"
      remove_secret_id_file_after_reading = false
    }
  }
}

template_config {
  exit_on_retry_failure = true
}

env_template "TOOLRIG_TEST_SECRET" {
  contents            = "{{ with secret \"secret/data/toolrig/testing/consumer\" }}{{ .Data.data.value }}{{ end }}"
  error_on_missing_key = true
}

exec {
  command                   = ["/bin/sh", "/openbao/bin/consumer-check"]
  restart_on_secret_changes = "never"
}
