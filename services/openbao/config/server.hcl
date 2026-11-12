ui = false
api_addr = "http://127.0.0.1:8200"
cluster_addr = "http://openbao:8201"
log_level = "info"

storage "raft" {
  path    = "/openbao/file"
  node_id = "toolrig-openbao-local"
}

listener "tcp" {
  address         = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"
  tls_disable     = 1
}
