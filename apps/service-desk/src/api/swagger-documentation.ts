import type { SwaggerTransform } from '@fastify/swagger';

const sections = {
    identity: { name: 'Моя учётная запись', description: 'Текущий пользователь и его права.' },
    forms: { name: 'Форма обращения', description: 'Поля формы создания обращения.' },
    requests: { name: 'Обращения', description: 'Создание обращения, просмотр и переписка с поддержкой.' },
    support: {
        name: 'Статус обращения',
        description: 'Закрытие собственного обращения и смена статуса сотрудником поддержки.',
    },
    settings: {
        name: 'Настройки службы поддержки',
        description: 'Настройки сервиса в одном JSON. Изменять их может администратор службы поддержки.',
    },
} as const;
export const swaggerTags = Object.values(sections);
type Section = keyof typeof sections;
const operations: Record<string, { section: Section; summary: string; details?: string }> = {};
function add(section: Section, entries: [string, string, string?][]) {
    for (const [operation, summary, details] of entries) operations[operation] = { section, summary, details };
}
add('identity', [['GET /api/me', 'Получить мою учётную запись и права']]);
add('forms', [
    ['GET /rest/servicedeskapi/servicedesk/:deskId/requesttype/:typeId/field', 'Получить поля формы обращения'],
]);
add('requests', [
    [
        'GET /rest/servicedeskapi/request',
        'Получить список обращений',
        'Заявитель получает свои обращения, поддержка и администратор — обращения своей службы поддержки. Просмотр всех обращений поддержкой — локальное расширение Jira. Фильтр requestStatus: ALL_REQUESTS, OPEN_REQUESTS или CLOSED_REQUESTS. Пагинация: start от 0; limit по умолчанию 25, максимум 100.',
    ],
    [
        'POST /rest/servicedeskapi/request',
        'Создать обращение',
        'Новое обращение назначается активному руководителю своей службы поддержки. Если руководитель не назначен, их несколько или каталог пользователей недоступен, сервер отвечает 503. Обращение при этом не создаётся.',
    ],
    ['GET /rest/servicedeskapi/request/:key', 'Получить обращение'],
    [
        'GET /rest/servicedeskapi/request/:key/comment',
        'Получить переписку по обращению',
        'Заявитель видит только публичные сообщения.',
    ],
    [
        'POST /rest/servicedeskapi/request/:key/comment',
        'Добавить сообщение',
        'Заявитель добавляет публичные сообщения (public=true). Внутренние заметки доступны сотрудникам поддержки.',
    ],
]);
add('support', [
    [
        'GET /rest/api/2/issue/:key/transitions',
        'Получить доступные изменения статуса',
        'Заявителю доступно только закрытие собственного открытого обращения. Для закрытого обращения список пуст. Параметр expand=transitions.fields добавляет обязательные поля перехода и допустимые значения.',
    ],
    [
        'POST /rest/api/2/issue/:key/transitions',
        'Изменить статус обращения',
        'Заявитель может закрыть собственное обращение из любого открытого статуса: transition.id=10011, fields.resolution.id=10100. Это локальное расширение Jira. Закрытие снимает исполнителя и сохраняет историю с событием обновления. Повторное закрытие — 409. Другие переходы доступны только поддержке; их список возвращает GET.',
    ],
]);
add('support', [
    [
        'GET /rest/api/2/user/assignable/search',
        'Найти доступных исполнителей',
        'Только для поддержки и администратора. Список содержит активных сотрудников своей службы поддержки с нужными правами в Keycloak. Предыдущий вход сотрудника в портал не требуется. Параметры: username, issueKey, project=HELP, maxResults (по умолчанию 50, максимум 100).',
    ],
    [
        'PUT /rest/api/2/issue/:key/assignee',
        'Назначить или снять исполнителя',
        'Только для поддержки и администратора. Поле name содержит логин доступного сотрудника своей службы поддержки; null снимает исполнителя. Значение -1 не поддерживается. Перед назначением сервер проверяет права сотрудника в Keycloak. Назначение, история и событие сохраняются вместе. Поле assignee в карточке — локальное расширение Jira.',
    ],
]);
add('settings', [
    ['GET /api/settings', 'Получить настройки службы поддержки'],
    [
        'PUT /api/settings',
        'Сохранить настройки службы поддержки',
        'Получите настройки через GET, измените значения и отправьте весь JSON. Адреса уведомлений применяются сразу. Остальные изменения — после перезапуска сервиса.',
    ],
    [
        'PATCH /api/settings',
        'Изменить отдельные настройки',
        'Передайте только изменяемые поля, например {"server":{"port":3001}}. Остальные настройки сохранятся. Для проверки редакции передайте If-Match из GET.',
    ],
]);
const access: Record<Section, string> = {
    identity:
        'Доступ: заявитель, поддержка и администратор службы поддержки. Сервер возвращает данные пользователя, выполнившего вход.',
    forms: 'Доступ: заявитель, поддержка и администратор службы поддержки.',
    requests: 'Доступ: заявитель — свои обращения; поддержка и администратор — обращения своей службы поддержки.',
    support:
        'Доступ: заявитель — только закрытие собственного обращения; поддержка и администратор — смена статуса и назначение исполнителя в своей службе поддержки.',
    settings: 'Доступ: только администратор службы поддержки.',
};
const success: Record<string, number> = {
    'POST /rest/servicedeskapi/request': 201,
    'POST /rest/servicedeskapi/request/:key/comment': 201,
    'POST /rest/api/2/issue/:key/transitions': 204,
    'PUT /rest/api/2/issue/:key/assignee': 204,
};
/** Documentation-only: health/config and static routes remain available but are not business operations. */
export const documentSwaggerRoute: SwaggerTransform = ({ schema, url, route }) => {
    const method = Array.isArray(route.method) ? route.method[0] : route.method;
    const operation = `${method} ${url}`;
    const entry = operations[operation];
    if (!entry) return { schema: { ...(schema ?? {}), hide: true }, url };
    return {
        url,
        schema: {
            ...schema,
            tags: [sections[entry.section].name],
            summary: entry.summary,
            description: [access[entry.section], entry.details].filter(Boolean).join('\n\n'),
            response: {
                [success[operation] ?? 200]: { description: 'Успешный ответ' },
                401: { description: 'Войдите в службу поддержки.' },
                403: { description: 'Нет прав на это действие. Обратитесь к администратору.' },
                ...(schema?.response && typeof schema.response === 'object' ? schema.response : {}),
            },
        },
    };
};
