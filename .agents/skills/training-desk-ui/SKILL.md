---
name: training-desk-ui
description: 'Развивать встроенный Angular UI тестового Service Desk и общую SCSS-библиотеку libs/theme; использовать для форм, callback-настроек и стилей, не для отдельного приложения студентов.'
---

# Тестовый UI и общая тема

Прочитай [UI/theme architecture](../../../docs/architecture/identity-theme.md) и для стилей [theme README](../../../libs/theme/README.md). Keycloak FTL/realm также требует [identity skill](../training-desk-identity/SKILL.md).

UI — `apps/service-desk/ui`, API — `apps/service-desk/src` одного Nx-приложения. Не создавай отдельный front/back проект. Сценарии feature-first, component/signals/Reactive Forms и HTTP-адаптер feature, routes/providers в UI composition root.

Вход через `keycloak-js`, public client `service-desk-test`, Authorization Code + PKCE S256, конфигурация из `/api/config`. Пароль только на Identity, токены в памяти SDK; не добавляй localStorage, client secret, backend RP/cookie-сессию. Bearer добавляется только в предусмотренные same-origin API пути. Приложение модерации студентов в другом репозитории.

Готовая дизайн-система — PrimeNG/Aura по образцу a-spec, контролы и provider в `libs/ui`. Feature-компоненты импортируют общую библиотеку, не PrimeNG напрямую. Не создавай новые самодельные поля/селекты и не накладывай старые глобальные native-input стили на PrimeNG. `theme.install()` один раз глобально. Общие controls/surfaces/typography/assets — `libs/theme`; component SCSS содержит геометрию и токены `--desk-*`, не локальные палитры/копии controls. Сохраняй provenance assets и не возвращай удалённый логотип Artsofte. Общий favicon с буквой A используется порталом и Swagger; Keycloak его не подключает.

Формы берут поля/обязательность/options из API; `10001` — учебная замена, `183/194` отдельны. Успех только после ответа сервера. Администратор редактирует полный JSON через GET/PUT /api/settings. Сотрудник поддержки не меняет настройки. О необходимости перезапуска сообщает X-Restart-Required.

Новый `/rest` контракт требует backend + Jira skill. Предусмотри error/loading/focus/mobile. Проверки по [матрице](../../../docs/agents/verification.md): ngc, ESLint/Prettier, build-ui; theme — Sass import/assets. Browser/computer use требует отдельного согласования, сборка не доказывает визуальный результат.

Создание обращения — одна форма, выбор темы и все поля на одной странице, без этапов. Бренд — текстовый Artsofte; навигация /requests и /. При добавлении SPA-маршрута проверь server fallback и возврат после OIDC. Токены остаются в SDK-памяти; если сохраняется путь возврата, разрешай только локальные пути приложения и не сохраняй auth-query/токены.

Исполнитель в портале — только read-only имя/«Не назначен» у всех ролей. Не добавляй dropdown назначения: распределение является частью отдельного сервиса студентов.

В списке обращений один скролл: виртуальное окно внутри экрана, без общего скролла страницы и без кнопок страниц. Следующие записи подгружаются автоматически порциями; API start/limit используется внутри адаптера. Оставляй справа от даты отступ для системной полосы прокрутки.

Виртуальные строки отслеживаются по `issueId`: `cdkVirtualFor` получает `trackBy`, возвращающий ID. Не используй индекс или номер позиции; при подгрузке повторные записи также сопоставляются по `issueId`.
