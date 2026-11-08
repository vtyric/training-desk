# 3. Интеграция с Service Desk

Приложение команды принимает события удалённого Service Desk, показывает обращения сотрудникам и сохраняет их действия через API: назначение, комментарий и смену статуса.

Для начала нужны адреса Identity и Service Desk, учётки разных ролей и отдельный ключ подписи webhook. Команда администрирует пользователей и клиентов по [первой инструкции](01-keycloak-and-roles.md), вход подключается по [второй](02-openid-connect.md). Исходники стенда и серверная `.env` для интеграции не требуются.

В примерах `https://desk.example.ru` заменяется на адрес выданного Service Desk, `HELP-123` — на ключ созданного обращения. Защищённые запросы содержат `Authorization: Bearer <ACCESS_TOKEN>`, запросы с JSON-телом — также `Content-Type: application/json`.

## Локальная схема: proxy для API, туннель для webhook

```text
Браузер localhost:4300 → proxy/backend команды → удалённый Service Desk
Удалённый Service Desk → HTTPS-туннель → backend команды localhost:3000
```

Proxy пересылает исходящие запросы браузера и решает вопрос CORS. Туннель делает входящий обработчик webhook доступным удалённому серверу. Для самого OIDC-входа туннель не нужен: на localhost возвращается браузер пользователя.

### Пример dev-proxy для Vite

```ts
// vite.config.ts в проекте команды
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
                target: 'https://desk.example.ru',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/desk-api/, ''),
            },
        },
    },
});
```

`/api` ведёт на собственный backend, `/desk-api` — на удалённый Service Desk. Например, `/desk-api/rest/servicedeskapi/request` попадёт в его `/rest/servicedeskapi/request`. Заголовок `Authorization` сохраняется. В другом стеке настраивается аналогичная пересылка.

Браузерный адаптер использует экземпляр `keycloak` из второй инструкции:

```ts
const deskOrigin = 'https://desk.example.ru';

export async function deskFetch(path: string, init: RequestInit = {}) {
    const target = new URL(path, deskOrigin);
    if (target.origin !== deskOrigin) throw new Error('Неизвестный адрес API');
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
if (!response.ok) throw new Error(`API ответил ${response.status}`);
const currentUser = await response.json();
```

Ссылки `_links.next` и `_links.self` в ответах API абсолютные. Их можно передавать этому же адаптеру: он проверит origin и направит запрос через proxy. Прямой `fetch` удалённой ссылки снова станет междоменным запросом браузера.

Dev-proxy Vite работает только при разработке. На стенде команды пересылку выполняет reverse proxy или backend.

## Приём webhook на localhost

Backend команды поднимает `POST /webhooks/service-desk`, например на порту `3000`. После установки `cloudflared` для него запускается туннель:

```sh
cloudflared tunnel --url http://localhost:3000
```

Из выданного hostname получается адрес получателя:

```text
https://random-name.trycloudflare.com/webhooks/service-desk
```

Quick Tunnel работает до остановки процесса и меняет hostname при новом запуске. Интерактивная авторизация туннеля по email для webhook не подходит: Service Desk не проходит браузерный вход. Получатель проверяет HMAC-подпись.

Адрес webhook должен быть публичным HTTPS URL на стандартном порту `443`. Внутренние адреса, `http://localhost:3000` и перенаправления отправителем не принимаются.

## Первый получатель в настройках Service Desk

Настройки меняются с access token учётки приложения, имеющей роль `service-desk:admin`. Токен администратора консоли `master` его не заменяет.

```sh
export DESK_URL='https://desk.example.ru'
export DESK_ADMIN_ACCESS_TOKEN='<access_token администратора приложения>'
```

Сначала API возвращает идентификатор службы и актуальные настройки:

```sh
curl "$DESK_URL/api/me" \
  -H "Authorization: Bearer $DESK_ADMIN_ACCESS_TOKEN"

curl -i "$DESK_URL/api/settings" \
  -H "Authorization: Bearer $DESK_ADMIN_ACCESS_TOKEN"
```

`teamId` из первого ответа — UUID. `demo` — другой идентификатор: `team_slug` пользователя в Identity. ETag из второго ответа используется в `If-Match`.

Если записи `teams[teamId]` ещё нет, она создаётся целиком. Пример файла `webhook-settings.json` в проекте команды:

```json
{
    "teams": {
        "00000000-0000-4000-8000-000000000001": {
            "webhook": {
                "id": "00000000-0000-4000-8000-000000000001",
                "url": "https://random-name.trycloudflare.com/webhooks/service-desk",
                "enabled": true,
                "createdAt": "2026-11-08T09:00:00.000Z"
            }
        }
    }
}
```

Ключ и `id` заменяются на настоящий `teamId`, URL — на текущий адрес туннеля, время задаётся в ISO 8601. Если GET вернул `ETag: "7"`, запрос сохранения выглядит так:

```sh
curl -X PATCH "$DESK_URL/api/settings" \
  -H "Authorization: Bearer $DESK_ADMIN_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'If-Match: "7"' \
  --data-binary @webhook-settings.json
```

Ответ содержит весь JSON, новую `revision` и ETag. В тело PATCH `version` и `revision` не передаются.

Для существующей записи достаточно изменить URL:

```json
{
    "teams": {
        "00000000-0000-4000-8000-000000000001": {
            "webhook": {
                "url": "https://new-name.trycloudflare.com/webhooks/service-desk"
            }
        }
    }
}
```

При сохранении передаётся актуальный ETag. Адрес применяется на следующем цикле обработки без перезапуска. Полный формат и ограничения — в [настройках](../settings.md).

На службу приходится один получатель. Если несколько команд работают с общей `demo`, они меняют один URL. Для независимой работы нужны заранее подготовленные службы с разными `team_slug`/`teamId` либо отдельные экземпляры стенда. Новый OIDC client ID сам по себе такую изоляцию не создаёт.

## Подпись, сохранение и повторы

В уведомлении приходят заголовки:

```text
Content-Type: application/json
X-Training-Event-Id: <стабильный UUID события>
X-Training-Signature: sha256=<64 шестнадцатеричных символа>
```

HMAC-SHA256 вычисляется по исходным байтам тела до JSON-парсера. Повторная сериализация может изменить тело и подпись не совпадёт.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function validSignature(rawBody: Buffer, signature: string, secret: string) {
    if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
    const actual = Buffer.from(signature.slice(7), 'hex');
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

Выданный команде ключ используется как UTF-8 строка `secret`. `Buffer.from(secret, 'hex')` изменит ключ. Саму функцию нужно встроить в HTTP-обработчик выбранного фреймворка, который получает `rawBody` до разбора JSON.

Обработчик:

1. Получает исходное тело и заголовки, проверяет подпись и ID события. Неверная подпись — `401`/`403`.
2. Сохраняет событие в своей БД с уникальным `event_id` и надёжно ставит его в обработку.
3. Отвечает `200` или `204`. Повторный ID не создаёт дубликат задачи.

Повторы возможны, порядок доставки не гарантируется. Отправитель повторяет сетевые ошибки, `429` и `5xx`; другие `4xx` не означают «попробовать позже». При временной ошибке сохранения получатель отвечает `5xx`, а не подтверждает потерянные данные.

## События и актуальная карточка

Создание формирует `jira:issue_created`, изменение статуса, комментария или исполнителя — `jira:issue_updated`. Сокращённый пример:

```json
{
    "webhookEvent": "jira:issue_created",
    "issue": {
        "id": "123",
        "key": "HELP-123",
        "fields": {
            "summary": "Замена оборудования",
            "status": { "id": "10005", "name": "Новая" },
            "assignee": {
                "name": "support-lead",
                "displayName": "Руководитель поддержки"
            }
        }
    }
}
```

Актуальная карточка читается по ключу: `GET /rest/servicedeskapi/request/HELP-123`. Старое событие не должно перезаписывать уже известный свежий статус; перечитывание карточки помогает сверить состояние.

Webhook проверяется отдельным HMAC-ключом. Вызовы API требуют access token пользователя. Для автономной фоновой работы без вошедшего пользователя нужна отдельная серверная учётка и настройка прав Identity; публичный `student-service` их автоматически не создаёт. Внутренний клиент каталога `service-desk-directory` приложению команды не выдаётся.

## Полный сценарий обработки

Обработчик webhook доступен до создания обращения.

1. Заявитель, например `alice`, входит в удалённый портал и отправляет форму нового обращения.
2. Backend команды проверяет и сохраняет событие. Первоначальный исполнитель — руководитель поддержки.
3. Сотрудник, например `support`, входит в приложение команды. Для внешнего API ему нужна `service-desk:support`; для собственного backend — `student-service:moderator`, если он проверяет эту роль.
4. API возвращает доступных исполнителей:

    ```http
    GET /rest/api/2/user/assignable/search?issueKey=HELP-123&maxResults=50
    Authorization: Bearer <ACCESS_TOKEN>
    ```

    ```json
    [{ "name": "support", "key": "support", "displayName": "Сергей Петров", "active": true }]
    ```

5. Выбранный `name` передаётся в назначение:

    ```http
    PUT /rest/api/2/issue/HELP-123/assignee
    Authorization: Bearer <ACCESS_TOKEN>
    Content-Type: application/json
    ```

    ```json
    { "name": "support" }
    ```

    Успех — `204`. `{ "name": null }` снимает назначение; `-1` не поддерживается. Сервер заново проверяет доступность сотрудника в Keycloak. Предыдущий вход кандидата в портал не требуется.

6. Приложение перечитывает карточку и показывает сохранённого исполнителя. `assignee` в карточке/списке — локальное расширение CustomerRequestDTO: снимок логина и имени. Актуальная доступность для назначения определяется списком кандидатов.

Портал заявителя показывает исполнителя только для чтения. Выбор и правила распределения реализует сервис команды.

## Статусы, переписка и закрытие

Доступные переходы и обязательные поля возвращает:

```http
GET /rest/api/2/issue/HELP-123/transitions?expand=transitions.fields
Authorization: Bearer <ACCESS_TOKEN>
```

Выбранный ID из ответа передаётся в POST:

```http
POST /rest/api/2/issue/HELP-123/transitions
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json
```

```json
{ "transition": { "id": "10006" } }
```

В текущем workflow `10006` переводит «Новую» в «Ожидает выполнения». Далее для перехода в «В работе» предлагается `10008`. Перед каждым действием клиент получает доступные переходы заново.

Переписка читается и дополняется по одному пути:

```http
GET /rest/servicedeskapi/request/HELP-123/comment?start=0&limit=25
POST /rest/servicedeskapi/request/HELP-123/comment
```

```json
{ "body": "Приняли обращение в работу.", "public": true }
```

`public=false` создаёт внутреннюю заметку поддержки. Заявитель видит только публичные сообщения; внутренний текст в webhook не включается.

Заявитель закрывает своё открытое обращение кнопкой в портале либо через API. Его GET transitions в текущей конфигурации возвращает переход `10011` с обязательным решением `10100`:

```json
{
    "transition": { "id": "10011" },
    "fields": { "resolution": { "id": "10100" } }
}
```

Успешный POST — `204`: статус становится «Закрыта», исполнитель снимается, `jira:issue_updated` содержит `issue.fields.assignee=null`. Повторное закрытие заявителем — `409`. Эти ID и право закрытия из любого открытого состояния относятся к локальной конфигурации стенда.

## Сверка списка

```http
GET /rest/servicedeskapi/request?requestStatus=OPEN_REQUESTS&start=0&limit=25
Authorization: Bearer <ACCESS_TOKEN>
```

Фильтры: `ALL_REQUESTS`, `OPEN_REQUESTS`, `CLOSED_REQUESTS`. Поддержка видит обращения своей службы, заявитель — свои. Следующая порция находится в `_links.next` и при браузерном запросе проходит через proxy.

Список позволяет сверить состояние, но не подтверждает доставку webhook. Полный сценарий включает получение и сохранение подписанного события.

## Перенос приложения на стенд команды

1. Приложение и обработчик webhook развёрнуты на HTTPS-адресах.
2. Callback, origin и выход зарегистрированы в Keycloak по второй инструкции.
3. Reverse proxy или backend пересылает запросы Service Desk; dev-proxy Vite автоматически не переносится.
4. PATCH меняет URL существующего получателя на постоянный адрес.
5. Повторены создание, назначение, статус, сообщение и закрытие; проверены подпись, повтор события и права разных учёток.

| Проблема                 | Что проверить                                                              |
| ------------------------ | -------------------------------------------------------------------------- |
| CORS в браузере          | Запрос, включая `_links.next`, проходит через локальный proxy              |
| API `401`                | Access token, срок, issuer и audience `service-desk`; ID token не подходит |
| API `403`                | Роли клиента `service-desk`, `team_slug`; для настроек нужна `admin`       |
| Карточка `404`           | Ключ и принадлежность доступной службе/заявителю                           |
| Нет webhook на localhost | Туннель, текущий hostname, путь POST и включённого получателя              |
| Неверная подпись         | Исходные байты, ключ как UTF-8 строку, заголовок `sha256=...`              |
| Создание `503`           | Единственного активного руководителя и каталог Identity                    |
| PATCH `409`              | Актуальный ETag после повторного GET                                       |

Справка: [контракт стенда](../api-compatibility.md), [JSON настроек](../settings.md), [Vite proxy](https://vite.dev/config/server-options.html#server-proxy), [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
