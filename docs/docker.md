# Запуск и обновление через Docker

Команды выполняются из корня репозитория. Нужны Docker Engine с Compose v2 и Node.js из `.nvmrc`. Для Docker-режима pnpm на хосте не требуется; зависимости устанавливаются при сборке образов.

## Первый запуск

```sh
node tools/setup-env.mjs
node tools/bootstrap.mjs --mode docker
node tools/bootstrap.mjs --mode docker --apply
```

Первая команда создаёт `.env` с независимыми секретами. Если файл уже есть, используется `node tools/setup-env.mjs --extend`: значения сохраняются, добавляются только недостающие ключи и совместимые переименования переменных.

Bootstrap без `--apply` показывает план. С `--apply` он проверяет окружение, запускает PostgreSQL, готовит общую схему Identity, собирает образы, применяет миграции/начальные данные и настраивает Keycloak.

При ручном запуске тот же порядок выглядит так:

```sh
docker compose config --quiet
docker compose up -d --wait postgres
node --env-file=.env tools/migrate-identity-database.mjs --apply
docker compose up --build -d --wait
node --env-file=.env tools/configure-identity.mjs
```

`config --quiet` проверяет Compose без вывода секретных значений. Полный `docker compose config` содержит развёрнутые ENV и не подходит для общего отчёта.

## Состав контура

| Сервис         | Содержимое                                                             | Dockerfile                                       |
| -------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| `postgres`     | Одна БД `training`: `public` для Service Desk, `identity` для Keycloak | Официальный образ PostgreSQL                     |
| `ldap`         | Учётные записи и пароли                                                | `apps/identity/ldap/Dockerfile`                  |
| `identity`     | Keycloak и тема входа                                                  | `apps/identity/Dockerfile`                       |
| `migrate`      | Миграции и начальные данные Service Desk                               | `apps/service-desk/Dockerfile`, target `migrate` |
| `service-desk` | API, Angular-портал и обработчик уведомлений                           | `apps/service-desk/Dockerfile`, target `runtime` |

`migrate: Exited (0)` — нормальное завершение. Остальные сервисы должны быть healthy. Ошибка миграции блокирует старт Service Desk. `/health` подтверждает работу процесса, но не проверяет вход или webhook.

Compose собран из фрагментов `infra/compose`; они не запускаются как отдельные проекты. Dockerfiles находятся рядом с приложениями. Отдельные frontend/Nginx-контейнеры не нужны: портал раздаётся API.

## Адреса локального контура

| Раздел           | Адрес                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| Портал           | <http://localhost:8080/>                                                 |
| Обращения        | <http://localhost:8080/requests>                                         |
| Swagger          | <http://localhost:8080/docs/>                                            |
| Консоль Keycloak | <http://localhost:8081/admin/>                                           |
| Discovery        | <http://localhost:8081/realms/training/.well-known/openid-configuration> |

По умолчанию наружу опубликованы только loopback-порты `8080` и `8081`. PostgreSQL и LDAP не публикуются. Для host-разработки `pnpm infra:start` применяет `infra/compose/dev.yaml`: PostgreSQL доступен на `127.0.0.1:55439`, LDAP — на `127.0.0.1:1389`.

Обычный запуск root Compose может убрать dev-публикации портов; данные при этом сохраняются. Две копии репозитория с одинаковым Compose project name в одном Docker context управляют одним контуром.

## Обновление и диагностика

```sh
node tools/setup-env.mjs --extend
node tools/bootstrap.mjs --mode docker --apply
docker compose ps --all
docker compose logs --tail=100 migrate service-desk identity
```

Остановка без удаления данных:

```sh
docker compose down
```

`down --volumes` удаляет данные и не используется для обычного обновления, смены пароля или исправления миграций. SQL-миграции находятся в DAL; применённые файлы и checksum не меняются.

Запуск только нужного приложения с его зависимостями:

```sh
pnpm identity:start
pnpm service-desk:start
```

Для нового окружения сначала нужен общий bootstrap. Seed сохраняет уже существующие учётные данные. Изменение ENV не меняет пароль существующего LDAP-пользователя или конфигурацию импортированного realm; пользователи/клиенты обслуживаются через Keycloak.

Если Docker Desktop выдаёт `non-printable ASCII` для `x-docker-expose-session-sharedkey` при пути с кириллицей, у команды можно отключить Bake:

```sh
COMPOSE_BAKE=false docker compose up --build -d --wait
```

Глобальный Docker context и настройки инструментов bootstrap не меняет.

## Что сохраняется на томах

PostgreSQL хранит обращения и Identity в разных схемах одной БД. SQL-роль `identity` владеет своей схемой и не получает права на таблицы обращений. LDAP хранит пользовательские пароли. Рабочий JSON настроек находится на томе `service-desk-settings`, путь — `/data/settings/backend.json`.

Резервные копии нужны для PostgreSQL, LDAP и рабочего JSON. Текст `.env` также сохраняется отдельно с ограниченным доступом. Создание новой `.env` поверх старой не восстанавливает прежние пароли.

## Обновление прежнего отдельного PostgreSQL Identity

`tools/migrate-identity-database.mjs --apply` вызывается bootstrap до старта Identity. Для старого контура он останавливает Keycloak и сохраняет дампы обеих БД в `.local/backups/identity-shared-*` с закрытыми правами.

Схема переименовывается только во временной копии исходной БД, затем восстанавливается в `training.identity` одной транзакцией. Инструмент сверяет количество realms/users и ставит маркер. Исходная БД не очищается; старый контейнер остаётся остановленным, том сохраняется. После проверки контейнер можно удалить без тома.

Повторный запуск не восстанавливает старые данные поверх новой схемы. Неоднозначное или частично подготовленное состояние останавливает перенос; при ошибке Identity остаётся остановленным до разбора причины. `IDENTITY_DB_PASSWORD` после переноса — пароль роли в общей БД, не отдельного сервера.

## Проверки и внешнее размещение

Команды проверок и их побочные эффекты перечислены в [матрице](agents/verification.md). Сквозные сценарии создают учебные обращения и не направляются на неизвестный удалённый стенд автоматически.

Docker-сборка не публикует сервис на домене. Для внешнего размещения отдельно настраиваются HTTPS, публичный hostname Keycloak, issuer/API URL, callback/origins, защита LDAP и резервное копирование. Смена адреса требует согласованной настройки [Identity](identity.md), а не отключения проверок сертификата или issuer.

## Очистка образов на VPS

После успешного автоматического деплоя `tools/deploy-vps.mjs` запускает `infra/deploy/cleanup-images.sh`. На VPS остаются текущая и предыдущая успешно развёрнутые версии шести образов `ghcr.io/vtyric/training-desk-*`. Ссылки `/opt/training-desk/current` и `previous` обозначают эти релизы. При повторном запуске того же коммита предыдущая версия сохраняется. Неудачный деплой очистку не запускает.

Удаляются только SHA-теги указанных шести репозиториев. Принудительное удаление и глобальный Docker prune не используются: образ, занятый контейнером, Docker сохраняет. Тома, база, настройки, папки релизов и чужие образы в очистку не входят. Политика применяется к VPS; версии пакетов в GHCR остаются доступными для повторного скачивания.
