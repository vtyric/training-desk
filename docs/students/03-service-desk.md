# 3. Интеграция с Service Desk

Результат: ваш локальный сервис получает уведомление о новом обращении, показывает его сотруднику, сохраняет выбранного исполнителя и меняет статус через API удалённого Service Desk.

Исходники стенда не требуются. Перед началом нужны:

- публичные адреса Identity и Service Desk;
- административный доступ Keycloak и отдельная учётка приложения с ролью `service-desk:admin` для настроек;
- учётки заявителя и сотрудника поддержки;
- отдельный ключ проверки webhook для своей службы поддержки — его выдаёт владелец развёртывания при передаче стенда. Значения секретов API настроек не показывает.

Пользователи и роли описаны в [первой инструкции](01-keycloak-and-roles.md), вход в ваш проект — во [второй](02-openid-connect.md).

## Схема локальной работы

```text
Браузер localhost:4300 → ваш proxy/backend → удалённый Service Desk
Удалённый Service Desk → публичный HTTPS-туннель → ваш backend localhost:3000
```

Вход выполняется через публичный Keycloak и возвращает браузер на localhost. Настройка CORS на Service Desk для схемы с локальным proxy не требуется. Входящий webhook — отдельный серверный запрос, ему нужен доступный снаружи обработчик.

Далее `DESK_URL=https://desk.example.ru` и `AUTH_URL=https://auth.example.ru` обозначают выданные адреса, а `HELP-123` — ключ из ответа создания обращения. Защищённые запросы содержат `Authorization: Bearer <access_token>`; запросы с JSON-телом — также `Content-Type: application/json`.

## Запросы браузера через proxy

Вариант для Vite. Приложение и proxy работают на порту `4300`:

```ts
// vite.config.ts вашего проекта
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

Запрос браузера `/desk-api/rest/servicedeskapi/request` попадёт в удалённый `/rest/servicedeskapi/request`. Proxy сохраняет заголовок `Authorization`. Префикс `/api` в примере ведёт на ваш локальный backend, `/desk-api` — на удалённый Service Desk. В другом стеке можно настроить аналогичный dev-proxy или пересылать запросы своим backend.

Пример браузерного адаптера с экземпляром `keycloak` из второй инструкции:

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

`_links.next` и `_links.self` в ответах Service Desk содержат абсолютные адреса. Их тоже можно передавать в этот адаптер: он проверит origin и отправит запрос через proxy. Прямой `fetch` абсолютного адреса снова станет запросом браузера на другой домен.

Dev-proxy Vite действует при разработке. На стенде команды аналогичная маршрутизация настраивается в reverse proxy или в вашем backend.

## Как получать уведомления на localhost

1. Ваш backend поднимает обработчик `POST /webhooks/service-desk`, например на `http://localhost:3000`.
2. Для него запускается HTTPS-туннель. Пример после установки `cloudflared`:

    ```sh
    cloudflared tunnel --url http://localhost:3000
    ```

3. Выданный адрес, например `https://random-name.trycloudflare.com`, превращается в адрес получателя: `https://random-name.trycloudflare.com/webhooks/service-desk`.
4. Адрес сохраняется в настройках Service Desk по инструкции ниже.

Quick Tunnel работает, пока запущен процесс; при новом запуске hostname меняется. Интерактивная защита туннеля входом по email для webhook не подходит: Service Desk не проходит браузерный вход. Получатель проверяет подпись уведомлений.

Обычный proxy запросов API не делает локальный обработчик доступным вашему удалённому Service Desk. URL `http://localhost:3000` в настройках webhook не принимается: получатель должен быть публичным HTTPS-адресом на стандартном порту `443`.

## Настройка первого получателя

Здесь используется access token **учётки приложения** с ролью `service-desk:admin`. Токен администратора консоли realm `master` не заменяет его. Примеры curl выполняются на вашей машине; исходники и `.env` сервера для них не нужны.

```sh
export DESK_URL='https://desk.example.ru'
# Access token из OIDC-входа под администратором приложения.
export DESK_ADMIN_ACCESS_TOKEN='<access_token>'
```

1. Узнать идентификатор своей службы:

    ```sh
    curl "$DESK_URL/api/me" \
      -H "Authorization: Bearer $DESK_ADMIN_ACCESS_TOKEN"
    ```

    Поле `teamId` содержит UUID. Это не строка `demo`: `demo` — значение `team_slug` в Identity.

2. Получить настройки и ETag:

    ```sh
    curl -i "$DESK_URL/api/settings" \
      -H "Authorization: Bearer $DESK_ADMIN_ACCESS_TOKEN"
    ```

3. Если записи `teams[teamId]` ещё нет, создать её полностью. Ниже вместо UUID и URL нужны свои значения; время — ISO 8601. Если GET вернул `ETag: "7"`, он передаётся как `If-Match: "7"`:

    ```sh
    curl -X PATCH "$DESK_URL/api/settings" \
      -H "Authorization: Bearer $DESK_ADMIN_ACCESS_TOKEN" \
      -H 'Content-Type: application/json' \
      -H 'If-Match: "7"' \
      --data-binary @webhook-settings.json
    ```

    Файл `webhook-settings.json` в вашем проекте:

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

    Ключ и `id` равны настоящему `teamId`. `PATCH` возвращает весь JSON с новой `revision` и новым ETag. В тело PATCH поля `version` и `revision` не передаются.

4. Когда запись уже существует, для смены URL достаточно:

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

    Нужен новый ETag из последнего GET/PATCH. Изменение адреса применяется на следующем цикле обработчика без перезапуска. Изменение параметров сервера может требовать перезапуска — это сообщает `X-Restart-Required`.

На одну службу сейчас приходится одна такая запись получателя. Если команды используют общую `demo`, её URL общий и изменения заменяют получателя друг друга. Для параллельной независимой работы нужны заранее подготовленные отдельные службы с разными `team_slug`/`teamId` либо отдельные экземпляры стенда. Отдельный OIDC client ID сам по себе не создаёт такую изоляцию.

## Проверка подписи и повторов

В запросе приходят:

```text
Content-Type: application/json
X-Training-Event-Id: <стабильный UUID события>
X-Training-Signature: sha256=<64 шестнадцатеричных символа>
```

Подпись — HMAC-SHA256 **исходных байтов тела**. JSON разбирается после проверки. Повторная сериализация объекта может изменить пробелы и порядок полей, поэтому для подписи не подходит.

Пример функции Node.js для вашего обработчика:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function validSignature(rawBody: Buffer, signature: string, secret: string) {
    if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
    const actual = Buffer.from(signature.slice(7), 'hex');
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

Ключ, выданный команде, используется как обычная UTF-8 строка `secret`. Преобразование `Buffer.from(secret, 'hex')` изменит ключ и не совпадёт с подписью отправителя. `rawBody` собирается до JSON-парсера вашим HTTP-фреймворком; сама функция не настраивает роут или чтение тела.

Порядок обработки:

1. Получить сырое тело и заголовки.
2. Проверить подпись и наличие ID события. При неверной подписи вернуть `401` или `403`.
3. Сохранить событие в своей БД с уникальным ограничением на `event_id`. Повтор того же события не создаёт повторную задачу.
4. Надёжно поставить событие в свою обработку и ответить `200`/`204`. Длительная бизнес-обработка выполняется после сохранения.

Повторы возможны, порядок доставки не гарантируется. Отправитель повторяет сетевые ошибки, `429` и `5xx`; прочие ответы `4xx` не используются как сигнал повторить позже. Если временно не удаётся сохранить событие, нужен `5xx`, а не успешный ответ с потерей данных.

## Что приходит в событиях

При создании — `jira:issue_created`, при изменении статуса, комментария или исполнителя — `jira:issue_updated`. Например:

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

Это сокращённый пример, а не полный контракт события. Для чтения карточки по ключу используется GET `/rest/servicedeskapi/request/HELP-123`.

Из-за возможного нарушения порядка старое событие не должно переписывать уже известный более свежий статус. Для сверки можно перечитать карточку с действующим токеном сотрудника. Получение webhook по HMAC не требует браузерного access token; API-вызовы для назначения и статуса требуют авторизованного пользователя. Для автономных фоновых API-вызовов без вошедшего пользователя нужна отдельная серверная учётка/настройка прав Identity; такой сценарий не появляется автоматически от публичного клиента `student-service`. Служебный клиент каталога `service-desk-directory` для этого не выдаётся приложению студентов.

## Сценарий: новое обращение и распределение

После настройки webhook обработчик должен быть доступен до создания обращения.

1. В портале удалённого Service Desk войти как заявитель, например `alice`. В «Новом обращении» заполнить и отправить единую форму.
2. Ваш backend получает событие, проверяет подпись, сохраняет ID и карточку в своей БД. Первоначальный исполнитель — руководитель поддержки.
3. В своё приложение войти сотрудником, например `support`, с ролью `service-desk:support` и собственной ролью `student-service:moderator`, если ваш backend её использует.
4. Получить кандидатов:

    ```http
    GET /rest/api/2/user/assignable/search?issueKey=HELP-123&maxResults=50
    Authorization: Bearer <ACCESS_TOKEN>
    ```

В ответе приходят доступные учётки, например:

```json
[{ "name": "support", "key": "support", "displayName": "Сергей Петров", "active": true }]
```

Для назначения используется `name` из этого ответа, не внутренний UUID пользователя Keycloak.

5. Сохранить выбранный логин через API:

    ```http
    PUT /rest/api/2/issue/HELP-123/assignee
    Authorization: Bearer <ACCESS_TOKEN>
    Content-Type: application/json
    ```

    ```json
    { "name": "support" }
    ```

    Успех — `204`. `{ "name": null }` снимает назначение. `name=-1` не поддерживается. Сервер заново проверяет доступность кандидата в Keycloak; предыдущий вход кандидата в портал не требуется.

6. Перечитать карточку и показать сохранённого исполнителя. В карточке/списке `assignee` — локальное расширение CustomerRequestDTO, снимок логина и имени. Доступность для нового назначения определяется списком кандидатов, не этим снимком.

Внешний портал только показывает исполнителя. Интерфейс выбора и правила распределения реализуются в вашем проекте.

## Сценарий: статус, переписка и закрытие

Для рабочего статуса сначала получить разрешённые переходы:

```http
GET /rest/api/2/issue/HELP-123/transitions?expand=transitions.fields
Authorization: Bearer <ACCESS_TOKEN>
```

Затем передать ID перехода из ответа:

```http
POST /rest/api/2/issue/HELP-123/transitions
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json
```

```json
{ "transition": { "id": "10006" } }
```

`10006` — пример текущего перехода из «Новая» в «Ожидает выполнения». Для дальнейшего перехода в «В работе» текущий workflow предлагает `10008` после ожидания. Перед каждым действием список проверяется заново. Для поддержки дальнейшие переходы ограничены процессом обработки; их нельзя заменить произвольной строкой статуса.

Переписка:

```http
GET /rest/servicedeskapi/request/HELP-123/comment?start=0&limit=25
POST /rest/servicedeskapi/request/HELP-123/comment
```

```json
{ "body": "Приняли обращение в работу.", "public": true }
```

`public=false` создаёт внутреннюю заметку, доступную поддержке. Заявитель видит только публичные сообщения. В событие обновления внутренний текст заметки не включается.

Заявитель может закрыть своё открытое обращение кнопкой в портале. Для API-закрытия он получает собственные переходы через тот же GET. В текущей конфигурации ответ указывает `10011` и обязательное решение `10100`:

```json
{
    "transition": { "id": "10011" },
    "fields": { "resolution": { "id": "10100" } }
}
```

POST отвечает `204`. Статус становится «Закрыта», исполнитель снимается, а `jira:issue_updated` содержит `issue.fields.assignee=null`. Повторное закрытие заявителем возвращает `409`. Эти ID и право заявителя закрыть из любого открытого состояния — локальная конфигурация стенда, а не универсальные правила Jira.

## Как сверить список без webhook

```http
GET /rest/servicedeskapi/request?requestStatus=OPEN_REQUESTS&start=0&limit=25
Authorization: Bearer <ACCESS_TOKEN>
```

Фильтры: `ALL_REQUESTS`, `OPEN_REQUESTS`, `CLOSED_REQUESTS`. Поддержка видит обращения своего Service Desk, заявитель — только свои. Следующая порция указана в `_links.next`; при браузерном вызове она проходит через proxy, как показано выше.

Этот список позволяет сверить данные, но не подтверждает получение webhook. Для полного локального сценария нужен работающий HTTPS-туннель и принятые подписанные события.

## Перенос на стенд команды

1. Развернуть своё приложение и обработчик webhook на HTTPS-адресе.
2. В Keycloak добавить точные callback, origin и адрес выхода, как во второй инструкции.
3. Настроить production proxy/backend для запросов к Service Desk; dev-proxy Vite туда не переносится сам.
4. Через PATCH заменить URL уже существующего получателя на постоянный HTTPS URL.
5. Повторить создание, назначение, смену статуса, комментарий и закрытие. Проверить подпись, повтор события и доступ учёток разных ролей.

## Где искать ошибку

| Симптом                             | Что проверить                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| Браузер сообщает CORS               | Запрос ушёл напрямую на удалённый домен, включая `_links.next`, вместо локального proxy |
| API возвращает `401`                | Access token, срок, issuer и audience `service-desk`; ID token не подходит              |
| API возвращает `403`                | Роли клиента `service-desk` и `team_slug`; для настроек нужна `admin`                   |
| Карточка возвращает `404`           | Ключ и принадлежность обращения доступной службе/заявителю                              |
| Webhook не приходит на localhost    | Туннель, текущий hostname, правильный путь POST, включённый получатель                  |
| Подпись не совпадает                | Сырые байты, верный отдельный ключ как UTF-8 строка, заголовок `sha256=...`             |
| Новое обращение не создаётся, `503` | Единственный активный руководитель своего Service Desk и доступность каталога Identity  |
| PATCH отвечает `409`                | Устаревший If-Match; настройки надо получить заново                                     |

Справка: [контракт стенда](../api-compatibility.md), [JSON настроек](../settings.md), [Vite proxy](https://vite.dev/config/server-options.html#server-proxy), [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
