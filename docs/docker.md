# Docker: два самостоятельных приложения

Identity и тестовый Service Desk — отдельные приложения с общей инфраструктурой PostgreSQL. Нужны Docker Engine с Compose v2 и Node.js из `.nvmrc` для подготовки ENV; pnpm на хосте для контейнерной сборки не требуется.

## Первый запуск

Из корня репозитория:

```sh
node tools/setup-env.mjs
docker compose config --quiet
docker compose up -d --wait postgres
node --env-file=.env tools/migrate-identity-database.mjs --apply
docker compose up --build -d --wait
node --env-file=.env tools/configure-identity.mjs
docker compose ps --all
```

При существующей `.env` добавляйте только отсутствующие ключи через `node tools/setup-env.mjs --extend`; старые значения сохраняются. Не выводите полный `.env` или `docker compose config` в общий отчёт: развёрнутая конфигурация содержит секреты. `config --quiet` проверяет без их печати.

Первичная `configure-identity` создаёт управляемый профиль, синхронизирует учебных LDAP-пользователей и назначает начальные роли клиента. Маркер завершения предотвращает повторную замену последующих назначений. Это административная операция только на согласованном учебном Identity.

Откройте <http://localhost:8080> — встроенный портал Service Desk. Он перенаправит на Identity <http://localhost:8081> для пароля; API получает Bearer JWT, не пароль/cookie. Swagger — <http://localhost:8080/docs>, проверка работы процесса — <http://localhost:8080/health>.

## Состав

| Сервис         | Назначение                                                   | Исходники/образ                                                           |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `ldap`         | Общие учебные пользователи и пароли                          | `apps/identity/ldap/Dockerfile`; bootstrap LDIF — `infra/ldap/users.ldif` |
| `identity`     | OIDC, LDAP federation, тема входа                            | `apps/identity/Dockerfile`                                                |
| `postgres`     | Одна БД training: public — Service Desk, identity — Keycloak | Официальный PostgreSQL                                                    |
| `migrate`      | SQL-миграции и идемпотентный demo seed                       | `apps/service-desk/Dockerfile`, target `migrate`                          |
| `service-desk` | API, Angular-портал и обработчик уведомлений                 | `apps/service-desk/Dockerfile`, target `runtime`                          |

Отдельных back/front приложений, клиентский интерфейс контейнера и Nginx нет. Bootstrap — инструмент, не дополнительный постоянный сервис. Dockerfiles принадлежат приложениям; Compose и bootstrap-инфраструктура сгруппированы в `infra`.

`migrate: Exited (0)` ожидаемо. Ошибка миграций блокирует Service Desk. Миграции находятся в `apps/service-desk/src/dal/migrations`; применённые SQL не редактируются. Health dependencies обеспечивают порядок старта, но `/health` не доказывает действующий login/JWT или webhook.

## Запуск отдельного приложения

```sh
docker compose up --build -d --wait identity
docker compose up --build -d --wait service-desk
```

Команды используют общий проект и сеть корневого Compose и общий `postgres`. `infra/compose/*.yaml` — фрагменты корневой конфигурации, не самостоятельные контуры с отдельными БД. Identity подтягивает PostgreSQL и LDAP, Service Desk — свои миграции и Identity по зависимостям. Для нового/старого checkout сначала выполните общий bootstrap, который готовит SQL-роль и схему.

Две копии репозитория с одинаковым project name в одном Docker context управляют одним контуром, а не двумя изолированными стендами.

## Порты и состояние

По умолчанию опубликованы loopback-порты Identity `8081` и Service Desk `8080`. PostgreSQL и LDAP напрямую наружу не опубликованы. `DOCKER_BASE_URL` задаёт внешние ссылки Service Desk; `IDENTITY_PUBLIC_URL`/`OIDC_ISSUER_URL` и callback клиента должны соответствовать реальному адресу браузера. Смена порта требует согласованной конфигурации, а не обхода проверок issuer/redirect.

Рабочие настройки хранятся на постоянном томе `service-desk-settings`, путь задаёт `SETTINGS_FILE`. Исходный `config/backend.json` копируется только при отсутствии state. JSON содержит параметры и адреса уведомлений, но не секретные значения. API, ревизии и применение параметров сервера и адресов уведомлений изменений описаны в [settings](settings.md).

Постоянные тома содержат одну общую БД и LDAP. PostgreSQL хранит схемы `public` и `identity`; роль `identity` владеет своей схемой и не получает права на таблицы Service Desk. Обычная остановка:

```sh
docker compose down
```

Не используйте `down --volumes` для штатного обновления, исправления миграций или смены пароля: он удаляет данные. Runtime JSON и БД требуют отдельных резервных копий.

## Разработка на хосте

`pnpm infra:start` запускает PostgreSQL, LDAP и Keycloak с ожиданием готовности. Dev overlay `infra/compose/dev.yaml` открывает только loopback PostgreSQL `55439` и LDAP `1389`, необходимые инструментам и тестам на хосте. API и портал развиваются внутри Nx-проекта `service-desk`; см. [setup](agents/setup.md).

## Сквозная проверка

После первичного bootstrap:

```sh
node --env-file=.env tools/identity-smoke.mjs
```

Либо `pnpm docker:test` при установленных зависимостях. Проверка делает настоящий LDAP-вход через Keycloak, Authorization Code + PKCE, SSO между публичными клиентами, создаёт одно обращение `10001`, читает её и проверяет отказ заявителю в изменении настроек. Это изменение учебных данных. Она не проверяет внешний webhook без получателя и не служит визуальной браузерной проверкой. Не направляйте её на неизвестный удалённый origin.

## Обновления и диагностика

```sh
docker compose up --build -d --wait
docker compose logs --tail=100 migrate service-desk identity
docker compose ps --all
```

Повторный seed не заменяет API-токены существующей demo-команды. PostgreSQL/LDAP bootstrap passwords из ENV относятся к инициализации; редактирование `.env` не меняет сохранённые credentials. Пользователями и паролями LDAP управляют через writable federation в Keycloak. Startup import realm не обновляет существующий realm молча.

Если Docker Desktop сообщает `non-printable ASCII` для `x-docker-expose-session-sharedkey` если путь репозитория содержит кириллицу:

```sh
COMPOSE_BAKE=false docker compose up --build -d --wait
```

Переменная отключает Bake для этой команды; глобальные настройки сохраняются. Ошибки инструментов/портов/миграций исправляются без удаления данных.

Локальный HTTP — режим разработки. Production HTTPS, безопасный LDAP, внешние домены и backup требуют отдельной задачи; Docker-сборка не означает публикацию на VPS.

## Перенос старого Identity PostgreSQL

Существующий контур с отдельным `identity-db` переводится на общую БД через `pnpm db:consolidate` (либо `node --env-file=.env tools/migrate-identity-database.mjs --apply`) после запуска `postgres`. Это также делает `bootstrap --apply` до запуска Identity.

Инструмент останавливает Identity, сохраняет дампы обеих БД в `.local/backups/identity-shared-*` с закрытыми правами, копирует исходную БД во временную, переименовывает схему только в этой копии и восстанавливает `identity` в `training` одной транзакцией. Проверяет количество realms/users и ставит маркер завершения. Не переименовывает/не очищает исходную БД, не удаляет данные Service Desk. Инструмент оставляет старый контейнер PostgreSQL остановленным; после проверки его можно удалить без удаления тома. Старый том и резервные копии сохраняются для отката; активен только общий PostgreSQL. При ошибке Identity остаётся остановлен, чтобы исключить запись в неоднозначный источник.

Повторный запуск сохраняет уже перенесённые данные и пароли. Не восстанавливает старый дамп поверх нового состояния. При свежей установке init-скрипт создаёт SQL-роль/схему; Keycloak применяет свои внутренние Liquibase-миграции. `IDENTITY_DB_PASSWORD` остаётся паролем отдельной SQL-роли в общей БД, а не второго сервера.
