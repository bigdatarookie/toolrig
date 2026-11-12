# infrastructure.secrets

## v0.2

Backend выбран OpenBao; один контейнер, stable refs, project policies, bootstrap/unseal/recovery и backup/restore до подключения consumers. Keychain не обязательный backend. Авторизация Codex — отдельные разрешённые account refs, не произвольное копирование auth/session файлов. Не менять все production credentials; первый consumer scoped с rollback.


Готовый secrets backend, references, authorized injection/rotation/recovery. Сначала audit existing secrets-manager. Не читать/публиковать значения без необходимости и authority. Сохранять работающий доступ до проверенной замены.

Следовать common/TEAM/PLATFORM/EVALUATION в применимом scope, без загрузки всей истории.
