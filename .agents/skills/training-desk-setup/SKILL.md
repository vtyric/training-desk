---
name: training-desk-setup
description: 'Установить, запустить или восстановить локальный Identity и тестовый Service Desk через Docker или pnpm; не выполнять production deploy и глобальную настройку инструментов.'
---

# Setup учебного контура

Прочитай [AGENTS](../../../AGENTS.md) и [setup guide](../../../docs/agents/setup.md). Работай из корня checkout; корпоративные MCP и компьютер автора не нужны.

Выбери по запросу Docker готового контура либо dev API/UI на хосте. Покажи план `node tools/bootstrap.mjs --mode docker` или `--mode dev` (без изменений). При просьбе установить/запустить выполни выбранную команду с `--apply`; при анализе остановись на плане.

Prerequisites: Node/pnpm проекта, работающий Docker/Compose. Не меняй глобальные версии/контекст и не обходи frozen lockfile. Недостающие ENV ключи добавляются `node tools/setup-env.mjs --extend`, не заменой старых значений. Это не меняет persistent passwords/realm. Runtime `SETTINGS_FILE` и тома сохраняются.

Два Nx-приложения — identity и service-desk (API и тестовый UI внутри). Root Compose агрегирует пять сервисов; отдельные файлы в `infra/compose`, Dockerfiles рядом с проектами. Запуск отдельных приложений — root Compose subsets по [Docker guide](../../../docs/docker.md); они используют один PostgreSQL/проект/том. SQL-миграции находятся в `apps/service-desk/src/dal/migrations`. Dev-порты публикуются override-файлом `infra/compose/dev.yaml`; обычный root Compose не обязан оставлять их открытыми.

Оба режима `bootstrap --apply` сами вызывают initial bootstrap после готовности Identity. При ручном запуске отдельных Compose выполни `node --env-file=.env tools/configure-identity.mjs`: marker защищает последующие user/role настройки. Это не постоянный сервис.

В Docker дождись healthy постоянно работающих сервисов и migrate exit0. В dev подготавливаются PostgreSQL/LDAP/Keycloak; `pnpm start` нужен только для работающих host-процессов. `/health` — liveness, не проверка JWT/login/webhook.

При ошибке укажи конкретный блокер и остановись без циклических перезапусков, удаления данных или отключения проверок. Smoke создаёт учебные данные; не направляй его на неизвестный удалённый origin. Проверки — по [матрице](../../../docs/agents/verification.md). Browser/computer use и VPS/DNS не разрешаются обычным setup автоматически.

Отчёт: режим, выполненные команды, реальные статусы и адреса. Не называй локальный запуск публикацией или fake-tools тест реальным Docker-прогоном.

Перенос прежнего Identity PostgreSQL выполняет `tools/migrate-identity-database.mjs`: сначала резервные копии, проверка целевой схемы/маркера, остановка Identity, затем перенос. Старый том не удаляется; после переноса работает один PostgreSQL/БД training с public и identity. Фрагменты infra Compose не запускай как отдельные проекты.
