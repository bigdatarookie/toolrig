# Toolrig: приёмка и эффект

## v02

Availability: read-only наблюдение реального provider account/windows с timestamps; тест policy remaining<=5/0 и multi-window на fixtures без искусственного исчерпания. Один разрешённый canary подтверждает поддерживаемую смену и сохранение conversation/qitem/config/permissions, фактический аккаунт и следующий tool turn. Проверить concurrent requests/shared-home isolation, restart pending continuation, unavailable alternative→до0→ближайшийreset→wake→полезное продолжение. Fixtures не доказывают live switch; не израсходовать quota ради проверки и не рестартовать чужие active seats. Если второго предоставленного аккаунта нет, live switch NOT RUN с точным gap, остальные функции не блокируются. Отдельного capacity seat нет.

OpenBao: закреплённое воспроизводимое развёртывание, durable storage, изолированные init/unseal/restart/backup-restore, разрешённая выдача/отказ чужому consumer/отзыв, отсутствие secret values в reports/logs и один реальный scoped consumer через reference. Live consumer не подменяется mock, test secret не объявляется миграцией всех credentials.

Documents: representational fixtures PDF text/scanned/table, DOCX table, XLSX sheets/formulas/cached values, CSV quoting/BOM. Проверить выбор диапазонов, render, source references, явные ошибки, OCR uncertainty и неизменность original. Проверить install/smoke на macOS и Linux; непроверенная платформа NOT RUN. Один реальный агент читает/рендерит нужный документ через Hub; огромный raw output не критерий успеха.

Приёмка не повторяет все старые проверки ради новой записи; affected independent reviewer сохраняет окончательное решение. Метрики availability: time-after-reset до actual useful continuation, предотвратимый downtime отдельно от подтверждённой недоступности, native continuity success, число human interventions. Diagnostic metrics не budgets/новые gates.


## Сквозные критерии

Принимаются независимым назначенным reviewer в affected scope и с реальным потребителем. Merge/тест SDK/наличие MCP tool отдельно не завершает внедрение.

- Hub: настоящий cloud и local-model клиент находит и выполняет разрешённую операцию; чужой ресурс недоступен, исключение понятно диагностируется. Это клиенты, не local models в составе Toolrig.
- Browser: два потребителя работают независимо; сохранённая авторизация не теряется; shared tab не получает конкурентное управление; recovery/cleanup не затрагивают пользователя.
- Documents: нужные страницы/листы реально читаются/рендерятся, текст/таблицы сопоставимы с исходником, OCR/ошибки/неподдерживаемый формат явны.
- Secrets/remote: разрешённый потребитель подключается к существующему target через reference; секрет не появляется в ответе/логах/argv. Проверить отказ другому потребителю, ротацию и recovery в разрешённом scope без обрыва чужих сервисов.
- Services: первый проектный service использует общий install/update/restore/uninstall, переживает restart; имя/владелец понятны; прежний экземпляр после update не накапливается; данные и rollback сохраняются.
- Review: хотя бы один реальный PR принимает компетентный неавтор вне обязательного QA-маршрута; независимость соблюдена, повторного QA/Lead gate нет. Не создавать пустой PR ради доказательства.
- Readiness publication: для первого действительно READY инструмента наблюдаются один durable `tool-ready` qitem оператору и один fleet-wide broadcast с точной версией, вызовом, платформами, ограничениями и evidence. Повтор того же `(tool, version, readiness-state)` не создаёт дубликат; отзыв готовности создаёт отдельную корректировку. До появления READY тестовое или фиктивное уведомление не отправляется.

## Метрики

Время и число вызовов до полезного результата, reviewer wait/review duration, ошибки и time-to-recovery, технические обращения к человеку, повторяемость известной проблемы, фактическое применение несколькими ригами. Tokens — cumulative counters с input/cached/output, окнами/coverage и без выдуманного точного attribution. Сравнивать сопоставимые задачи; runtime ресурсы отделять от token usage. Диагностические метрики не искусственные budgets/stop gates; обещанный процент экономии заранее не фиксируется.

## Граница текущей стадии

Запуск команды разрешён, но ни один implementation/consumer/service-migration критерий не считается PASS из существования пакета или работающих seats. Read-only inventory — начальный исторический этап, не текущий предел мандата. Для v0.2 требуются реализация и consumer эффекты по разделу v02. Изменение внешних служб, секретов и удалённых хостов требует собственного разрешённого scope и проверки через потребителя.
