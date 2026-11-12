# Toolrig

## v0.2

Авторизована реализация availability service без нового агента, OpenBao и документного стека. Контракты: PLATFORM#availability, #openbao, #documents; приёмка EVALUATION#v02. Код/установка/полезные эффекты не считаются готовыми по обновлению документа. Семь seats и модели сохраняются.


Спецификация v0.2, 2026-11-12. Статус: пользователь разрешил запуск Toolrig после операторской проверки; сервисы ещё не мигрированы.

Канонический рабочий репозиторий: `https://github.com/bigdatarookie/toolrig`, локальный root `/Users/garry/Documents/git/toolrig`.

Продукт — Tool Hub, постоянно работающий сервис общих инструментов. Команда Toolrig развивает и обслуживает его. Обычный вызов не требует участия агента Toolrig.

- [SPEC.md](SPEC.md) — миссия, scope и первый этап.
- [TEAM.md](TEAM.md) — роли, модели и границы.
- [PLATFORM.md](PLATFORM.md) — сервисы, инфраструктура и процесс PR.
- [EVALUATION.md](EVALUATION.md) — приёмка и диагностические метрики.
- [CULTURE.md](CULTURE.md), [LEARNED.md](LEARNED.md) — принципы и опыт.
- [rig.yaml](rig.yaml) — проверяемая и разрешённая к запуску топология.

Все Codex seats используют тот же `CODEX_HOME=/Users/garry/.codex-opentour`, что и OpenTour, и user-selected `permission_policy: builtin:yolo`. Это общий auth/config home; usage limit определяется фактическим аккаунтом/workspace, но не общая queue identity или бизнес-власть. Канонический рабочий root — `/Users/garry/Documents/git/toolrig`; системные подключения и миграции не следуют из запуска автоматически. Не копировать UI-культуру родительского проекта в runtime. Оперативное поручение передаётся native queue, отдельный файл handoff не требуется.
