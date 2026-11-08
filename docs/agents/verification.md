# Проверки по типу изменения

Используйте Node/pnpm проекта и проверяйте фактический вывод. Не называйте команду успешной, если она не запускалась. Небольшая Markdown/style правка не требует полного интеграционного прогона.

| Изменение                  | Проверки                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown/skills            | `pnpm agents:check`, Prettier изменённых файлов, skill-creator validator для изменённых skills; проверить смысл routing                         |
| Setup helper               | План без изменений, новые ветки в изолированной копии с fake tools, повторный запуск, fail-fast и сохранность ENV/state; ESLint/Prettier        |
| Сервер/auth/DAL            | `pnpm typecheck`, ESLint изменённого TS, целевые тесты и `pnpm test` при доступной инфраструктуре                                               |
| Jira DTO/API               | Нужный method/path/status pinned Data Center snapshot, validation, роль/tenant, visibility и пагинация                                          |
| Settings                   | Tenant projection, запрет секретных ENV references, ревизии, сохранность/atomic file, global restart vs callback hot, повторная worker-проекция |
| Портал                     | Angular typecheck, ESLint/Prettier, `pnpm exec nx run service-desk:build-ui`; loading/error/реальный API                                        |
| Identity realm/users/roles | Проверка JSON/mapper/clients, реальный login с PKCE, access token audience/роли клиента, denied без API-роли, writable LDAP через admin         |
| Identity theme             | `node tools/build-identity-theme.mjs`, Sass import/assets, проверка FTL на Keycloak; SCSS build не доказывает rendering                         |
| Docker/Compose             | `docker compose config --quiet`, затронутая сборка, запуск с health dependencies; отдельные файлы из `infra/compose`                            |

Сервер TypeScript: `pnpm exec tsc --noEmit -p apps/service-desk/tsconfig.server.json`. UI TypeScript: `pnpm exec ngc --noEmit -p apps/service-desk/ui/tsconfig.app.json`. `pnpm build` собирает Service Desk и тему Identity; не повторяйте проверки без новой причины. Полные lint/format уместны при широком изменении.

Для Swagger/OAuth изменений проверяйте генерацию OpenAPI/initializer и очистку авторизации через `tests/swagger.test.ts`, реальный PKCE/SSO/logout — `pnpm swagger:test`. Последний создаёт обращение; `pnpm identity:test-users` дополнительно проверяет выдачу роли admin временной учётной записи и удаляет её после проверки. Подробности — [Swagger](../swagger.md).

## Инфраструктура и побочные эффекты

Интеграционные тесты используют dev PostgreSQL/Identity/LDAP. SQL-тесты создают отдельные временные БД и удаляют только их; требуется `CREATEDB`. Не удаляйте основные тома и не подгоняйте тесты под случайные данные production/чужого стенда.

Для SQL-тестов на хосте нужны dev-порты: `pnpm infra:start` применяет `infra/compose/dev.yaml`. Последующий запуск обычного root Compose может убрать эти публикации; это не потеря данных.

Тесты JWT с локальной парой ключей подтверждают проверку токена, но не доказывают работающую federation Keycloak. Реальные login/создание пользователя/пароля/roles требуют запущенного Identity. работу HTTP-сервера не заменяет эти проверки.

Создание обращения и настройка webhook изменяют учебные данные. Доставка требует зарегистрированного доступного разрешённого HTTPS URL и не подтверждается только outbox/ответом `201`. `pnpm docker:test` / `node --env-file=.env tools/identity-smoke.mjs` проверяет реальный PKCE/SSO/JWT и создаёт одно обращение; webhook без получателя не проверяется. Сквозные smoke tools изучайте перед запуском и не направляйте на неизвестный удалённый origin.

## Отчёт

Разделяйте форматирование/компиляцию, unit/integration tests, настоящий Identity/JWT сценарий, проверку UI и публикацию. Computer use требует отдельного разрешения. Корневой агент проверяет результаты сабагентов по файлам и фактическим командам.

Фиксируйте реальные предупреждения сборки и ограничения среды. Не повышайте CSS budget и не отключайте валидацию ради зелёного результата. Недоступность Docker/сети/Identity — ограничение, а не успешный тест и не основание заявить production readiness.

Автоматическое продолжение входа проверяется `tests/identity-continuation.test.ts`: доверенный адрес, одна попытка, блокировка внешнего адреса и безопасное поведение без browser storage. Реальный конфликт двух вкладок, сохранение state/redirect/PKCE и выход проверяет `node --env-file=.env tools/identity-recovery-smoke.mjs` на локальном Identity. Пароли берутся из ENV, в вывод не попадают.
