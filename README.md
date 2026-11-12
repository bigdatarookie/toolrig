# Toolrig

Спецификация v0.1, 2026-11-12. Статус: пользователь разрешил запуск Toolrig после операторской проверки; сервисы ещё не мигрированы.

Канонический рабочий репозиторий: `https://github.com/bigdatarookie/toolrig`, локальный root `/Users/garry/Documents/git/toolrig`.

Продукт — Tool Hub, постоянно работающий сервис общих инструментов. Команда Toolrig развивает и обслуживает его. Обычный вызов не требует участия агента Toolrig.

- [SPEC.md](SPEC.md) — миссия, scope и первый этап.
- [TEAM.md](TEAM.md) — роли, модели и границы.
- [PLATFORM.md](PLATFORM.md) — сервисы, инфраструктура и процесс PR.
- [EVALUATION.md](EVALUATION.md) — приёмка и диагностические метрики.
- [CULTURE.md](CULTURE.md), [LEARNED.md](LEARNED.md) — принципы и опыт.
- [rig.yaml](rig.yaml) — проверяемая и разрешённая к запуску топология.

Все Codex seats используют тот же `CODEX_HOME=/Users/garry/.codex-opentour`, что и OpenTour, и user-selected `permission_policy: builtin:yolo`. Это общий auth/config home и общий usage limit, но не общая queue identity или бизнес-власть. Рабочий root первого этапа — этот пакет в `openrig-exp/toolrig`; системные подключения и миграции не следуют из запуска автоматически. Не копировать UI-культуру родительского проекта в runtime. Оперативное поручение передаётся native queue, отдельный файл handoff не требуется.
