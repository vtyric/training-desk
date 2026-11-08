---
name: training-desk-backend
description: 'Развивать API, DAL, JWT-доступ, webhook и JSON settings тестового Service Desk со слоями api → logic → dal; не подменять его приложением модерации студентов.'
---

# Backend тестового Service Desk

Прочитай [backend](../../../docs/architecture/backend.md); при доступе/событиях — нужный раздел [security](../../../docs/architecture/security-and-events.md), при настройках — [settings](../../../docs/settings.md).

- API/DTO/Fastify — `apps/service-desk/src/api`, сценарии — `logic`, Drizzle/SQL/внешние адаптеры — `dal`. Связи зависимостей в существующих composition roots. UI находится в `apps/service-desk/ui` того же Nx-проекта, не в отдельном front.
- SQL/schema/runner/seed и новые миграции — DAL, SQL/meta в `src/dal/migrations`. Не меняй применённые файлы/checksum. Учитывай существующий startup DDL deliveries отдельно от основной Drizzle-схемы.
- Заявка/history/outbox одного действия — одна транзакция; optimistic version check и tenant-фильтрация обязательны. Principal не берётся из тела.
- JWT проверяется через `jose`: issuer/audience/JWKS/expiry, `resource_access.service-desk.roles`, административный `team_slug`. Service Desk не принимает пароль, не выполняет LDAP bind и не создаёт server RP/cookie-сессию. Identity-изменения веди через [identity skill](../training-desk-identity/SKILL.md).
- JSON settings — desired state в durable `SETTINGS_FILE`; шаблон не перезаписывает state. PUT отвечает 200 и требует рестарта, адреса уведомлений — hot worker projection. API не делает двойную JSON+SQL запись и не раскрывает ENV values/произвольные ссылки. Revision/atomic-write/tenant invariants проверяются отдельно.
- Worker сохраняет durable lease, стабильный event ID, безопасный DNS pinning и повторы. Успех PUT/создания заявки не доказывает доставку. Мастер webhook secret только ENV. DNS/HTTP transport находятся в `libs/webhooks/dal`; не переноси сетевой I/O в logic.

Для `/rest` используй также [Jira contract skill](../training-desk-jira-contract/SKILL.md). `/api/*` — собственные API Service Desk. Настройки — GET/PUT/PATCH /api/settings, полный SettingsDocument без config-обёртки, admin-only. Отдельные административные REST команд/токенов/подписок удалены; не возвращай их. Статические API-токены по умолчанию отключены runtime settings, bootstrap ADMIN_TOKEN отдельно; не включай их ради обхода JWT.

Выбери проверки по [матрице](../../../docs/agents/verification.md), сообщи фактические результаты. Не заменяй недоступную инфраструктуру обещанием успеха и не меняй корпоративные системы.

При удалении старого backend-кода проверь package scripts, Nx/Docker entrypoints, тесты и lockfile; правила сохранности state и очистки — в [AGENTS](../../../AGENTS.md).

Swagger REST использует OAuth Code + PKCE через отдельный public client `service-desk-swagger`; вход и RP logout — в браузере документации, не server RP/cookie-сессия. Сохраняй автоматическую подстановку access token и серверную проверку ролей; детали и проверки — [Swagger](../../../docs/identity.md).

Публичный API намеренно минимален: 10 Jira-операций для списка/формы/создания/карточки/комментариев/статусов плюс GET /api/me и GET/PUT/PATCH /api/settings. Не возвращай очереди/JQL/историю/дублирующие issue-карточки без запроса пользователя. Вспомогательные /health и /api/config не показываются в Swagger.
