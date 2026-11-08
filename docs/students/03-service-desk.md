# 3. Service Desk: Swagger и интеграция

После этой инструкции сервис команды сможет получать новые обращения, читать их, назначать исполнителя, вести переписку и менять статус. Сначала запросы проверяются вручную в Swagger, затем повторяются из собственного приложения.

## 1. Вход в Swagger

1. Открывается [Swagger Service Desk](https://desk.makar-star.space/docs/).
2. Нажимается **Authorize** вверху страницы.
3. Выбирается OAuth-вход **identityOAuth**. Клиент — `service-desk-swagger`, scopes — `openid`, `profile`, `email`. Client secret не нужен.
4. Нажимается **Authorize**, в открывшейся форме вводятся логин `desk-admin` и его пароль.
5. После возврата в Swagger окно закрывается кнопкой **Close**.

`desk-admin` — учётка realm `training` с правами Service Desk. `administrator` управляет Keycloak и здесь не используется. Пароль не вводится в тело API-запросов: Swagger сам добавит access token в заголовок `Authorization`.

Для смены пользователя снова открывается **Authorize**, нажимается **Logout**, затем выполняется новый вход. Если уже действует общая сессия Keycloak, без Logout повторный вход может использовать прежнюю учётку.

## 2. Первый запрос и права

1. Раскрывается **Моя учётная запись → GET /api/me**.
2. Нажимается **Try it out → Execute**.
3. В блоке **Server response** ожидается `200` и такой состав ответа:

```json
{
    "username": "desk-admin",
    "role": "admin",
    "roleName": "Администратор службы поддержки",
    "teamId": "UUID вашей службы"
}
```

Значение `teamId` копируется из настоящего ответа. Это UUID. `demo` — значение `team_slug` в Keycloak, его нельзя подставить вместо UUID.

Далее раскрывается **Настройки службы поддержки → GET /api/settings**, выполняется **Try it out → Execute**. Ответ `200` содержит весь JSON настроек. В **Response headers** находится `etag`, например `"7"`; он нужен при сохранении изменений.

При входе как `support` или `alice` GET настроек должен вернуть `403`. После Logout запрос без входа должен вернуть `401`. Затем для следующих шагов снова выполняется вход как `desk-admin`.

## 3. Локальный backend для webhook

Адрес локального приложения существует только на компьютере студента. Удалённый Service Desk не может обратиться к его `http://localhost:3000` напрямую.

```text
Браузер localhost:4300 → локальный proxy → Service Desk на сервере
Service Desk на сервере → публичный HTTPS-туннель → backend localhost:3000
```

Для первой проверки можно сохранить [готовый приёмник](examples/webhook-receiver.mjs) в свой проект как `webhook-receiver.mjs`. Исходники серверного контура для этого не нужны: достаточно одного файла. В локальном файле `.env.local` задаётся выданный ключ:

```dotenv
TEAM_WEBHOOK_SECRET=выданный_ключ_вашей_службы
```

Запуск с Node.js 22:

```sh
node --env-file=.env.local webhook-receiver.mjs
```

Пример сохраняет принятые события в `.data/service-desk-events.ndjson` и печатает ключ обращения в терминале. Файл `.env.local` и каталог `.data` добавляются в `.gitignore` собственного проекта. Пример слушает порт `3000`; другой backend на этом порту на время первой проверки останавливается. Далее маршрут переносится в собственный backend команды. Демонстрационный приёмник не заменяет сохранение событий и задач в БД приложения.

На backend команды создаётся маршрут **POST /webhooks/service-desk**. Перед разбором JSON он получает исходные байты тела, проверяет подпись, сохраняет событие и отвечает `200` или `204`. Формат подписи приведён в шаге 6.

После запуска backend и установки `cloudflared` в отдельном терминале выполняется:

```sh
cloudflared tunnel --url http://localhost:3000
```

Cloudflare напечатает публичный адрес. Например:

```text
https://random-name.trycloudflare.com
```

Полный адрес получателя получается добавлением пути:

```text
https://random-name.trycloudflare.com/webhooks/service-desk
```

В инструкции это пример: у каждого запущенного туннеля свой hostname. Процессы backend и туннеля остаются запущенными во время проверки. После нового запуска Quick Tunnel hostname обычно меняется — новый URL сохраняется через PATCH ниже.

Webhook требует публичный HTTPS URL на порту `443`, без браузерной авторизации и перенаправлений. URL `http://localhost:3000/...` API настроек не примет. Для OpenID callback на localhost туннель не нужен — там возвращается браузер пользователя.

## 4. Сохранение адреса webhook через Swagger

На одну службу приходится один получатель. У всех учёток с `team_slug=demo` общий `teamId` и общий URL. Перед заменой адреса проверяется, что он не используется другой командой. Отдельный клиент Keycloak не создаёт отдельную службу Service Desk.

### Если получателя ещё нет

1. Выполняется GET `/api/me`, копируется `teamId`.
2. Выполняется GET `/api/settings`, проверяется отсутствие `teams[teamId]`, копируется актуальный ETag.
3. В локальной консоли браузера или Node получается текущее время:

    ```js
    new Date().toISOString();
    ```

4. Раскрывается **PATCH /api/settings → Try it out**.
5. В поле **if-match** вставляется ETag вместе с двойными кавычками, например `"7"`. Если поля ещё нет в установленном Swagger, для первого одиночного PATCH его можно пропустить: заголовок необязателен. Перед записью повторяется GET; параллельные правки без If-Match не защищены от устаревшего изменения того же поля.
6. В тело вставляется JSON ниже. Два значения `TEAM_ID` заменяются UUID из `/api/me`, URL — адресом работающего туннеля, `CURRENT_ISO_TIME` — текущим временем из предыдущего шага.

    ```json
    {
        "teams": {
            "TEAM_ID": {
                "webhook": {
                    "id": "TEAM_ID",
                    "url": "https://random-name.trycloudflare.com/webhooks/service-desk",
                    "enabled": true,
                    "createdAt": "CURRENT_ISO_TIME"
                }
            }
        }
    }
    ```

7. Нажимается **Execute**. Ожидается `200`, новая `revision`, новый ETag и сохранённый URL в ответе.

Пример содержит заполнители и не отправляется без замены. В `createdAt` не ставится будущее время: отправляются события, созданные начиная с времени подписки. Заявка для проверки создаётся после успешного PATCH, а не до него.

### Если получатель уже существует

Для смены адреса достаточно такого тела PATCH:

```json
{
    "teams": {
        "TEAM_ID": {
            "webhook": {
                "url": "https://new-name.trycloudflare.com/webhooks/service-desk",
                "enabled": true
            }
        }
    }
}
```

Перед запросом снова выполняется GET настроек и берётся свежий ETag. `id` и `createdAt` существующего получателя сохраняются. `version` и `revision` в PATCH не передаются.

При `409` другая запись уже изменила настройки: нужен новый GET, затем повтор только своей правки. URL применяется worker без перезапуска Service Desk. Ответ PATCH `200` подтверждает сохранение адреса; доставку подтверждает фактическое событие на backend.

### GET, PATCH и PUT

| Метод                 | Для чего                                                            |
| --------------------- | ------------------------------------------------------------------- |
| GET `/api/settings`   | Получить весь документ и ETag                                       |
| PATCH `/api/settings` | Изменить отдельные поля, например URL webhook                       |
| PUT `/api/settings`   | Заменить весь документ, взятый из актуального GET, с его `revision` |

Для URL обычно достаточно PATCH. Пустой объект в PATCH не удаляет запись, а неизвестные поля и `null` возвращают `400`. Остальные серверные параметры могут требовать перезапуска; ответ сообщает об этом в `X-Restart-Required`.

На общем стенде может остаться включённый получатель от предыдущей проверки. Перед своим тестом его URL заменяется адресом своего работающего туннеля. Когда туннель выключается, получатель отключается PATCH с `"enabled": false`. При следующем запуске задаётся новый URL и `enabled=true`.

## 5. Создание и чтение обращения

### Поля формы

В Swagger выполняется **Форма обращения → GET /rest/servicedeskapi/servicedesk/{deskId}/requesttype/{typeId}/field**:

- `deskId`: `3`;
- `typeId`: `10001`.

Ответ `200` содержит обязательные поля и допустимые значения. Для этой формы обязательны название устройства, тип замены, причина и описание.

### Создание

Для проверки роли заявителя выполняется Logout и вход как `alice`. Затем **Обращения → POST /rest/servicedeskapi/request → Try it out**:

```json
{
    "serviceDeskId": "3",
    "requestTypeId": "10001",
    "requestFieldValues": {
        "customfield_12900": "PC-1234",
        "customfield_20001": { "id": "20002" },
        "customfield_20002": { "id": "20101" },
        "description": "Ноутбук не включается. Проверены зарядное устройство и розетка."
    }
}
```

Ожидается `201`. Из ответа сохраняется `issueKey`, например `HELP-123`. В следующих запросах пример `HELP-123` заменяется своим ключом.

Новое обращение первоначально назначено `support-lead`. В локальном backend должно появиться подписанное событие `jira:issue_created`. Сам ответ `201` не доказывает доставку.

Создать обращение также можно через [портал](https://desk.makar-star.space/). Он использует тот же API.

### Карточка и список

- GET `/rest/servicedeskapi/request/{key}` с ключом созданного обращения: `200`, карточка с текущим статусом и исполнителем.
- GET `/rest/servicedeskapi/request` с `requestStatus=ALL_REQUESTS`, `start=0`, `limit=25`: `200`, массив `values` и сведения о следующей порции.

Заявитель видит свои обращения, поддержка — обращения своей службы. Фильтры списка: `ALL_REQUESTS`, `OPEN_REQUESTS`, `CLOSED_REQUESTS`. Если есть `_links.next`, приложение запрашивает следующую порцию.

## 6. Проверка webhook

Webhook содержит заголовки:

```text
Content-Type: application/json
X-Training-Event-Id: стабильный UUID события
X-Training-Signature: sha256=64 шестнадцатеричных символа
```

Создание отправляет `webhookEvent: "jira:issue_created"`, изменения — `webhookEvent: "jira:issue_updated"`. В `issue.key` находится ключ обращения. Актуальное состояние можно перечитать через GET карточки.

Подпись проверяется по исходным байтам тела до JSON-парсера:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function validSignature(rawBody: Buffer, signature: string, secret: string) {
    if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
    const actual = Buffer.from(signature.slice(7), 'hex');
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

`secret` — отдельный ключ подписи, выданный владельцем для вашей службы. Он используется как UTF-8 строка, без `Buffer.from(secret, 'hex')`. Ключ не получается через Swagger, пароль пользователя, OIDC client secret или master-токен. Серверная `.env` студентам для этого не передаётся.

Порядок обработки на backend:

1. Проверяются исходное тело, подпись и UUID из `X-Training-Event-Id`. Неверная подпись — `401` или `403`.
2. Событие сохраняется в БД приложения с уникальным `event_id` и ставится в обработку.
3. После надёжного сохранения возвращается `200` или `204`. Повтор с тем же ID подтверждается, но вторую задачу не создаёт.

При временной ошибке сохранения возвращается `5xx`. Service Desk повторяет сетевые ошибки, `429` и `5xx`. Повторы и другой порядок событий возможны, поэтому старое событие не должно перезаписывать свежую карточку. Текст внутренних заметок в webhook не передаётся.

## 7. Назначение исполнителя, переписка и статусы

Для обработки выполняется вход как `support` либо `desk-admin`. В примере собственного приложения доступ «только администраторы» дополнительно требует `student-service:admin`; права Service Desk сами по себе этого доступа не дают.

### Назначение

1. GET `/rest/api/2/user/assignable/search`: `issueKey=HELP-123`, `maxResults=50`.
2. Из ответа выбирается `name` доступного сотрудника.
3. PUT `/rest/api/2/issue/{key}/assignee`, `key=HELP-123`, тело:

    ```json
    { "name": "support" }
    ```

4. Ожидается `204`, затем GET карточки показывает нового исполнителя.

Для снятия используется `{ "name": null }`. Портал заявителя показывает исполнителя, но выбор реализует приложение команды. Список кандидатов учитывает актуальные роли и включённость пользователя; для назначения его предварительный вход в портал не требуется.

### Комментарий

POST `/rest/servicedeskapi/request/{key}/comment`, `key=HELP-123`:

```json
{ "body": "Обращение принято в работу.", "public": true }
```

Ожидается `201`. GET того же пути возвращает переписку. `public=false` — внутренняя заметка поддержки; заявитель её не видит и не может создавать.

### Рабочий статус

1. GET `/rest/api/2/issue/{key}/transitions`: `key=HELP-123`, `expand=transitions.fields`.
2. Из ответа берётся ID разрешённого перехода и его обязательные поля.
3. POST того же пути отправляет выбранный переход. Например, в текущем workflow переход из «Новая» в «Ожидает выполнения»:

    ```json
    { "transition": { "id": "10006" } }
    ```

4. Ожидается `204`, затем GET карточки показывает новый статус. Доступные переходы перед каждым следующим действием запрашиваются заново.

### Закрытие заявителем

1. Выполняется Logout, затем вход как `alice`, создавшая обращение.
2. GET transitions возвращает доступное закрытие и обязательное решение.
3. POST transitions в текущем workflow:

    ```json
    {
        "transition": { "id": "10011" },
        "fields": { "resolution": { "id": "10100" } }
    }
    ```

4. Ожидается `204`. В карточке статус «Закрыта», исполнитель `null`. В webhook `jira:issue_updated` также приходит `issue.fields.assignee=null`.

Повторное закрытие — `409`. Значения ID относятся к конфигурации этого стенда: в другом Jira workflow их нельзя считать постоянными.

## 8. Запросы из localhost: proxy

Для Vite используется `vite.config.ts`:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        port: 4300,
        strictPort: true,
        proxy: {
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
            '/desk-api': {
                target: 'https://desk.makar-star.space',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/desk-api/, ''),
            },
        },
    },
});
```

После изменения конфигурации dev-сервер перезапускается. `/api/admin` попадает в backend команды. `/desk-api/api/me` попадает в Service Desk `/api/me`. Заголовок `Authorization` пересылается вместе с запросом.

Клиентский адаптер использует `keycloak` из второй инструкции:

```ts
import { keycloak } from './auth';

const deskOrigin = 'https://desk.makar-star.space';

export async function deskFetch(path: string, init: RequestInit = {}) {
    const target = new URL(path, deskOrigin);
    if (target.origin !== deskOrigin) throw new Error('Неизвестный адрес Service Desk');
    if (!(target.pathname.startsWith('/rest/') || target.pathname.startsWith('/api/'))) {
        throw new Error('Неизвестный путь API');
    }
    await keycloak.updateToken(30);
    if (!keycloak.token) throw new Error('Вход не выполнен');

    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${keycloak.token}`);
    return fetch(`/desk-api${target.pathname}${target.search}`, { ...init, headers });
}

const response = await deskFetch('/api/me');
const currentUser = await response.json();
```

Запросы выполняются через относительный `/desk-api/...`, включая абсолютные `_links.next` из ответов. Прямой `fetch` на удалённый домен обходит proxy и снова становится междоменным запросом браузера. Backend может обращаться к Service Desk напрямую: браузерные ограничения CORS на серверный HTTP-клиент не действуют.

## 9. Перенос на стенд команды

1. Приложение и backend опубликованы на своих HTTPS-адресах.
2. Callback, origin и адрес выхода стенда добавлены в Keycloak по [инструкции входа](02-openid-connect.md).
3. На стенде `/api` направлен на backend команды, `/desk-api` — на Service Desk. Это делает reverse proxy или backend; dev-proxy Vite после сборки не работает.
4. PATCH меняет URL webhook на постоянный HTTPS-адрес команды.
5. Повторяется создание обращения, получение события, назначение, комментарий, статус и закрытие.

При ошибке проверяется:

| Ответ или симптом          | Проверка                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `401` API                  | Передан access token, а не ID token; срок, issuer и audience `service-desk`                    |
| `403` API                  | Роли клиента `service-desk`, `team_slug=demo`; настройки требуют `admin`                       |
| `401` собственного backend | В токене есть audience `student-service`, подпись и срок корректны                             |
| `403` собственного backend | Есть роль `student-service:admin`                                                              |
| `503` создания             | Есть ровно один активный руководитель службы; доступен каталог Identity                        |
| `409` настроек             | Повторён GET и взят актуальный ETag                                                            |
| CORS                       | Запрос и ссылки следующей порции проходят через `/desk-api`                                    |
| Webhook не пришёл          | Туннель и backend работают, путь правильный, получатель включён, заявка создана после подписки |
| Подпись неверна            | Используются исходные байты и выданный ключ службы как UTF-8 строка                            |

Контракт стенда: [API](../api-compatibility.md), [JSON настроек](../settings.md). Официальная справка: [Vite proxy](https://vite.dev/config/server-options#server-proxy), [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
