# Инструкции для агентов

## Сначала определить границу

Здесь два самостоятельных приложения: `identity` (Keycloak + writable LDAP federation + схема `identity` в общей БД) и `service-desk` (тестовый Jira-совместимый API и встроенный UI). Приложение модерации студентов находится в отдельном репозитории. Прежние отдельные Nx back/front заменены `apps/service-desk/src` и `apps/service-desk/ui`; общая тема — `libs/theme`.

Для русских документов открывай `redaktura`; для подписей, сообщений, ошибок и экранов — `ux-copy`. После изменения контрактов сверяйся также с доменным skill ниже.

Перед изменениями прочитай [обзор архитектуры](docs/architecture/README.md), затем **открой применимый SKILL.md**, не ограничиваясь описанием. Если discovery не показал навык, используй прямой путь ниже. Противоречие документа коду отметь явно. Инструкции и skills этого checkout — актуальный источник; не используй их старые копии из другого каталога проекта или глобального каталога skills.

| Задача                                                                       | Skill                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Установка, первый запуск, восстановление, Docker/Compose                     | [training-desk-setup](.agents/skills/training-desk-setup/SKILL.md)                               |
| Backend, DAL, миграции, JWT API, webhook и JSON settings                     | [training-desk-backend](.agents/skills/training-desk-backend/SKILL.md)                           |
| Пути/DTO/валидация/пагинация Jira API                                        | Дополнительно [training-desk-jira-contract](.agents/skills/training-desk-jira-contract/SKILL.md) |
| Keycloak, realm/clients, users/passwords/roles, LDAP federation и тема входа | [training-desk-identity](.agents/skills/training-desk-identity/SKILL.md)                         |
| Тестовый UI Service Desk, Angular, SCSS/theme/assets                         | [training-desk-ui](.agents/skills/training-desk-ui/SKILL.md)                                     |
| Редактура русской документации и текстов интерфейса                          | [redaktura](.agents/skills/redaktura/SKILL.md) и [ux-copy](.agents/skills/ux-copy/SKILL.md)      |
| Русская документация и тексты интерфейса                                     | [redaktura](.agents/skills/redaktura/SKILL.md) и [ux-copy](.agents/skills/ux-copy/SKILL.md)      |
| Запрошенный review, аудит архитектуры или готовности                         | [training-desk-review](.agents/skills/training-desk-review/SKILL.md)                             |

Читай только документы подходящей области. Не загружай весь OpenAPI для небольшой правки. UI/тема Keycloak требует identity skill, а изменение общей SCSS-библиотеки дополнительно ui skill.

## Согласование и разрешения

- Отвечай на языке сообщения пользователя.
- Анализ и предложения делай самостоятельно. Изменения предварительно согласовывай; конкретная просьба реализовать описанную задачу разрешает необходимые изменения в её объёме. Выход за объём согласовывай отдельно.
- Computer use и управление приложениями через UI требуют отдельного согласования. Предпочитай подключённые MCP; репозиторий исследуй CLI/файлами.
- По возможности делегируй независимые части сабагентам с непересекающимися файлами. Корневая модель проверяет их фактический результат и проверки.
- Учебная задача не разрешает записи в корпоративные Jira/LDAP/ADFS, внешнюю публикацию/VPS, изменение DNS или выдачу доступов.

## Инварианты архитектуры

- pnpm и существующий Nx. Не добавляй второй package manager/lockfile. Nx-приложения: `identity`, `service-desk`. Dockerfiles рядом с приложениями, инфраструктура — `infra/compose` и `infra/ldap`.
- Backend строгий TypeScript без `any`, слои **api → logic → dal**. HTTP в API, сценарии/политики в logic, SQL/файлы/JWKS/внешние адаптеры в DAL. Исключения композиции ограничены существующими app/runtime/main и library entrypoints.
- Один PostgreSQL и одна БД `training`: Service Desk использует `public`, Keycloak — `identity` с отдельной SQL-ролью. Не поднимай отдельный сервер БД для каждого приложения; резервные копии/перенос должны сохранять обе схемы.
- SQL-миграции и meta принадлежат DAL: `apps/service-desk/src/dal/migrations`; runner/seed также в DAL. Применённые SQL/checksum не редактируются.
- Запись заявки/history/outbox — одна транзакция. Сохраняй tenant-фильтр и optimistic version check; `teamId` тела не разрешает доступ.
- Identity управляет паролями/пользователями и client roles. Service Desk проверяет access JWT/JWKS/issuer/audience, `resource_access.service-desk.roles` и `team_slug`. LDAP-группы не определяют роли API. Не добавляй password form, server RP/cookie-сессию или client secret в UI/API.
- Тестовый UI использует `keycloak-js`, public client `service-desk-test`, PKCE S256; приложение студентов — отдельный client `student-service`. Секреты/токены не входят в bundle или localStorage.
- Публичный каталог ограничен 14 операциями (форма, обращение, переписка, статусы, учётная запись и настройки). Не возвращай удалённые очереди/поиск/историю без явного запроса.
- Настройки доступны только через GET/PUT/PATCH /api/settings: полный JSON без config-обёртки, только администратору Service Desk. Не возвращай отдельные team/global settings или административные REST команд/токенов/подписок. В пользовательских названиях используй «заявитель», «сотрудник поддержки», «администратор Service Desk», без SQL/bootstrap-терминов.
- JSON `SETTINGS_FILE` — источник истины настроек; `config/backend.json` копируется только при отсутствии. Global config активируется после рестарта, callbacks проецирует worker hot. Не добавляй secret literals/произвольные ENV refs или скрытый JSON+SQL dual write в settings API.
- Jira — официальное публичное подмножество **Data Center 10.3**, не Cloud/private browser endpoints. Тип `10001` — учебная конфигурация, не подтверждённый production ID.
- Новое обращение назначается единственному активному руководителю поддержки своего Service Desk (Keycloak support-lead). Портал показывает исполнителя read-only; переназначением управляет сервис студентов через API. При закрытии assignee и снимок его имени очищаются в той же транзакции, что статус/history/outbox.
- Форма создания обращения одна, без шагов/нумерации этапов и кнопок «Далее». Навигация — «Обращения» и «Новое обращение», бренд Artsofte.
- Готовые контролы PrimeNG/Aura и их provider — общая библиотека `libs/ui` по образцу a-spec; feature импортирует её вместо прямого импорта PrimeNG. Не добавляй в продукт надписи об учебной среде/тестовых данных.
- Общий стиль в `libs/theme`: токены, controls, surfaces, typography/assets. Component SCSS — раскладка и ссылки на токены, без копий палитры/контролов. Identity UI — FTL/CSS, тестовый Service Desk UI — Angular feature-first с HTTP-адаптером.
- RxJS применяй по потребности потока; последовательные транзакционные `async/await` не переписывай ради единообразия.
- Сохраняй существующие ENV, JSON state и тома. Для добавления недостающих ENV ключей используй `setup-env --extend`; это не меняет пароли persistent сервисов.

## Очистка после изменений

В согласованной области удаляй ставшие ненужными исходники, конфигурации, зависимости и генерируемые сборки. Перед удалением проверь импорты, Nx targets, package scripts, Docker COPY/Compose, assets и ссылки документации; отсутствие импорта само по себе не доказывает, что файл не нужен. Не возвращай отдельные `apps/back`, `apps/front`, Nginx или прежние LDAP/cookie-адаптеры.

Очистка репозитория не включает `.env`, runtime `SETTINGS_FILE`, БД/тома, другие checkout и глобальные Docker caches/images. Не запускай `down -v`, prune или общий `git clean` как часть такой очистки. После удаления зависимостей синхронизируй только pnpm lockfile и выполни проверки затронутых потребителей.

## Git hooks

Версионируемые хуки находятся в `.githooks`; установка в checkout — `pnpm hooks:install` (локальный `core.hooksPath`). `pnpm precommit` запускает только Prettier и ESLint для рабочего дерева, ничего автоматически не исправляет и не добавляет в index. Не переноси поддерживаемые хуки в неверсионируемый `.git/hooks`.

## Завершение

Выбери проверки по [матрице](docs/agents/verification.md). Проверь свою часть и результат сабагентов. Сообщи, что изменено, что реально проверено и что осталось ограничением. Обнови документы/skills при изменении контракта. Сборка не доказывает реальный login, rendering, webhook или production readiness. Изменение инструкций не является способом обойти согласованный scope или проверки.
