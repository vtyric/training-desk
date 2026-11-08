---
name: training-desk-identity
description: 'Развивать самостоятельный Keycloak Identity: realm/clients, users/passwords/client roles, writable LDAP federation и FTL-тему входа учебного контура; не переносить вход в Service Desk API.'
---

# Самостоятельный Identity

Прочитай [Identity handoff](../../../docs/identity.md), для темы — [identity/theme architecture](../../../docs/architecture/identity-theme.md). Общая SCSS правка дополнительно использует [ui skill](../training-desk-ui/SKILL.md).

Identity — отдельный Nx-проект `apps/identity`, схема `identity` в общей БД и LDAP. Dockerfile рядом с проектом; LDAP image — `apps/identity/ldap`, bootstrap LDIF — `infra/ldap/users.ldif`, Compose — `infra/compose`. Учебные пользователи/пароли управляются через Keycloak Admin Console и writable LDAP federation; административный `team_slug` отображается на LDAP employeeType.

Роли — client roles `service-desk:customer/support/admin` (в интерфейсе: заявитель, сотрудник поддержки, администратор Service Desk) в Keycloak, не LDAP groups. Убедись, что access token содержит audience service-desk, preferred_username, team_slug и нужный resource_access. Команда Service Desk существует отдельно. Не выдавай пользователю право самостоятельно выбирать tenant или административную роль.

`student-service` — внешний public client; `service-desk-test` — public client встроенного тестового UI. Оба Authorization Code + PKCE S256. `service-desk` — ресурс/audience, не confidential RP. Не включай password/direct grants, implicit flow, server app cookie/RP или client secret в UI.

Swagger — отдельный public client `service-desk-swagger`, Code + PKCE, точные `/docs/static/oauth2-redirect.html` и `/docs/` post-logout URLs; [параметры](../../../docs/swagger.md). Его конфигурация согласуется при каждом запуске configure-identity отдельно от пользователей/ролей.

Первичный `tools/configure-identity.mjs` задаёт managed profile/LDAP sync/demo roles; marker предотвращает повторную замену назначений. Это operator bootstrap, не password flow студентов.

LDAP-мапперы `uid`, `cn`, `sn` сохраняют `is.mandatory.in.ldap=true`: иначе создание пользователя через Keycloak может нарушить обязательные атрибуты LDAP. Проверяй именно создание новой учётной записи и пароль, а не только вход bootstrap-пользователя.

Realm import на startup не обновляет существующий realm. Bootstrap/sync и изменения пользователей/ролей выполняй только на разрешённом учебном экземпляре; сохраняй persistent data. Secret values — ENV, не realm JSON/доки. Доступ к Keycloak UI через computer use требует отдельного разрешения; исходники/CLI и подключённые MCP предпочтительны.

Тема — FTL/CSS в `apps/identity/theme`, общий стиль — `libs/theme`; не собирает пароль вне стандартного Keycloak loginAction. При версии Keycloak сверяй реальные FTL/mapper contracts с официальными источниками. Не возвращай удалённые брендовые SVG или реальные employee values.

Проверки по [матрице](../../../docs/agents/verification.md): schema/clients/roles, тема, реальный PKCE/JWT, denied без API-роли, создание пользователя/пароля через federation. Mock JWT и Sass build не доказывают работающий Keycloak. Корпоративные LDAP/ADFS и production deploy вне этого scope.

Назначения прав удобнее через Keycloak-группы `desk-customers`, `desk-support`, `desk-admins`, наследующие API client roles. `desk-admin` — demo API administrator в training; `administrator` — управление Keycloak master. Одноразовый access-model upgrade переносит начальные demo grants в группы; marker сохраняет дальнейшие решения преподавателя. Не выдавай admin каждому успешному LDAP-входу.

Общая тема покрывает также error/expired/info/logout страницы через federation/template FTL. Сохраняй штатный Keycloak authChecker для вкладок и безопасный возврат на управляемый client.baseUrl. Один login.ftl не обеспечивает корректные страницы остальных сценариев.

Первоначальный исполнитель — ровно один включённый support-lead своего Service Desk (composite support). Каталог читается сервером через read-only client service-desk-directory, без пароля master admin и без SQL/LDAP обходов. Участие в группе/effective roles проверяется в Identity при каждом назначении; не заменяй каталог списком ранее вошедших пользователей. Портал не выбирает исполнителя, это сценарий студенческого сервиса.
