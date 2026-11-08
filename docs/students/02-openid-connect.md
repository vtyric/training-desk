# 2. Вход через OpenID Connect в вашем проекте

Результат: приложение открывается локально, отправляет пользователя на форму входа Artsofte на удалённом Keycloak, получает access token и вызывает свой backend и API Service Desk.

Язык и фреймворк не ограничены. Ниже приведён браузерный пример на TypeScript с `keycloak-js`; для другого стека подходят OIDC-библиотеки с Authorization Code и PKCE S256.

## Что подготовить в Keycloak

Предполагается, что административный доступ из [первой инструкции](01-keycloak-and-roles.md) уже выдан. В консоли открыть **Clients → student-service** и проверить:

| Параметр                   | Значение для браузерного SPA |
| -------------------------- | ---------------------------- |
| Client type / Protocol     | OpenID Connect               |
| Client authentication      | Off: публичный клиент        |
| Standard flow              | On                           |
| Implicit flow              | Off                          |
| Direct access grants       | Off                          |
| PKCE Code Challenge Method | S256                         |

Для примера используются локальный frontend `http://localhost:4300` и стенд команды `https://team1.example.ru`.

| Настройка                       | Локально                              | Стенд команды                            |
| ------------------------------- | ------------------------------------- | ---------------------------------------- |
| Valid Redirect URIs             | `http://localhost:4300/auth/callback` | `https://team1.example.ru/auth/callback` |
| Web Origins                     | `http://localhost:4300`               | `https://team1.example.ru`               |
| Valid Post Logout Redirect URIs | `http://localhost:4300/`              | `https://team1.example.ru/`              |

Указывать точные адреса, включая порт и путь. `localhost` и `127.0.0.1` — разные origins. Если используется другой порт, его также нужно зарегистрировать. Для параллельных проектов можно создать отдельные клиенты по образцу `student-service`, сохранив мапперы `preferred_username`, `name`, `team_slug`, ролей и audience Service Desk из первой инструкции.

Изменение ENV не обновляет уже существующий клиент Keycloak автоматически: эти адреса сохраняются в консоли. Публичный Issuer самого Keycloak остаётся постоянным при переходе вашего приложения с localhost на стенд.

## Как используется форма входа

Отдельной формы «подключить проект» в портале Service Desk нет. Подключение состоит из настроек клиента Keycloak и кода вашего приложения.

Кнопка «Войти» в вашем приложении запускает SDK. Браузер открывает уже готовую страницу Artsofte на домене Keycloak. После ввода логина и пароля Keycloak возвращает браузер на зарегистрированный `/auth/callback`. Пароль остаётся в Identity, а SDK обменивает одноразовый код на токены.

```text
Ваш frontend → форма входа Keycloak → ваш /auth/callback → ваше приложение
```

Для такого входа публиковать localhost в интернет не требуется: обратно на локальный адрес переходит браузер пользователя. Если в Keycloak уже открыт сеанс, вход продолжается через SSO без повторного пароля.

## Пример браузерного подключения

Установка в своём проекте:

```sh
pnpm add keycloak-js
```

Конфигурация с публичным адресом стенда:

```ts
import Keycloak from 'keycloak-js';

export const keycloak = new Keycloak({
    url: 'https://auth.example.ru',
    realm: 'training',
    clientId: 'student-service',
});

const authenticated = await keycloak.init({
    onLoad: 'login-required',
    flow: 'standard',
    pkceMethod: 'S256',
    checkLoginIframe: false,
    scope: 'openid profile email',
    redirectUri: `${window.location.origin}/auth/callback`,
});

if (!authenticated) throw new Error('Вход не завершён');

// SDK обрабатывает callback до запуска роутера вашего приложения.
if (window.location.pathname === '/auth/callback') {
    window.history.replaceState(window.history.state, '', '/');
}

// Здесь запускается ваш роутер или приложение.
```

Этот пример возвращает на главную страницу. Для восстановления карточки можно сохранить только проверенный внутренний путь до входа. Токены, OAuth-код и параметры callback в такое хранилище не записываются.

Маршрут `/auth/callback` должен отдавать ваше SPA и при прямом открытии браузером. На стенде это настраивается в web-сервере приложения, например через fallback на `index.html`.

Для экрана с кнопкой «Войти» в `init` используется `onLoad: 'check-sso'`. В этом режиме строка `if (!authenticated) throw` из автоматического примера убирается: при `authenticated=false` приложение показывает публичный экран с кнопкой. Обработчик кнопки вызывает:

```ts
await keycloak.login({
    redirectUri: `${window.location.origin}/auth/callback`,
});
```

Для выхода:

```ts
await keycloak.logout({
    redirectUri: `${window.location.origin}/`,
});
```

Завершающий `/` соответствует адресам выхода в таблице. Logout завершает общую сессию Identity, включая другие подключённые приложения.

## Запросы с токеном

Перед запросом SDK обновляет токен при необходимости. Пример для вашего backend, доступного браузеру на том же origin:

```ts
export async function authorizedFetch(path: string, init: RequestInit = {}) {
    const target = new URL(path, window.location.origin);
    if (target.origin !== window.location.origin || !target.pathname.startsWith('/api/')) {
        throw new Error('Неизвестный адрес собственного API');
    }
    await keycloak.updateToken(30);
    if (!keycloak.token) throw new Error('Сеанс завершён');

    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${keycloak.token}`);
    return fetch(target, { ...init, headers });
}

const response = await authorizedFetch('/api/profile');
```

`/api/profile` — пример маршрута вашего backend; в предоставленном Service Desk такого пути нет. Проверка входа в Service Desk выполняется через `/api/me`, как описано в третьей инструкции.

Браузер использует публичный клиент без секрета. Access и refresh tokens остаются в памяти SDK. Публичные параметры `url`, `realm`, `clientId` можно хранить в конфигурации frontend.

## Проверка токена на вашем backend

Ваш backend проверяет access token, даже если интерфейс уже скрыл кнопки без нужной роли. После добавления audience и собственных ролей по первой инструкции пример на Node.js выглядит так:

```sh
pnpm add jose
```

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const issuer = 'https://auth.example.ru/realms/training';
// Адрес берётся из доверенного Discovery, а не из непроверенного JWT.
const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));

export async function authenticate(authorization: string | undefined) {
    const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
    if (!token) throw new Error('UNAUTHORIZED');

    const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: 'student-service',
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'iat', 'exp'],
    });
    if (payload.typ !== 'Bearer') throw new Error('UNAUTHORIZED');
    return payload;
}
```

Пример проверки роли на сервере после проверки подписи:

```ts
import type { JWTPayload } from 'jose';

function hasClientRole(payload: JWTPayload, clientId: string, role: string): boolean {
    const resources = payload.resource_access;
    if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return false;
    const client = (resources as Record<string, unknown>)[clientId];
    if (!client || typeof client !== 'object' || Array.isArray(client)) return false;
    const roles = (client as Record<string, unknown>).roles;
    return Array.isArray(roles) && roles.every((value) => typeof value === 'string') && roles.includes(role);
}

export async function requireModerator(authorization: string | undefined) {
    let payload: JWTPayload;
    try {
        payload = await authenticate(authorization);
    } catch {
        throw Object.assign(new Error('Войдите в приложение'), { statusCode: 401 });
    }
    if (!hasClientRole(payload, 'student-service', 'moderator')) {
        throw Object.assign(new Error('Нет прав на обработку обращений'), { statusCode: 403 });
    }
    return payload;
}
```

HTTP-обработчик вашего фреймворка использует `statusCode` для ответа. Сам helper не создаёт маршрут приложения.

Ошибка проверки соответствует HTTP `401`. Для модераторского действия после успешной проверки нужен `resource_access.student-service.roles` с ролью `moderator`; её отсутствие соответствует `403`. Если приложение разделяет данные по службам, `team_slug` связывается с разрешённым разделом на сервере. Значение из тела запроса права не расширяет.

Для вызова Service Desk используется access token с audience `service-desk` и его ролями. Audience вашего backend `student-service` добавляется отдельным mapper; при настройке обеих токен может содержать оба значения. Декодирование JWT без проверки подписи не заменяет `jwtVerify`.

## Вариант с серверным входом

Для приложения, где callback и сессию обрабатывает backend, администратор команды создаёт отдельный confidential client, например `student-service-web`:

| Настройка                            | Значение                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Client authentication                | On                                                                                                  |
| Standard flow                        | On                                                                                                  |
| Direct access grants / Implicit flow | Off                                                                                                 |
| Valid Redirect URIs                  | Точный callback backend, например `http://localhost:3000/auth/callback` и его HTTPS-адрес на стенде |
| Мапперы                              | Нужные роли/audience Service Desk и вашего сервиса, как в первой инструкции                         |
| Client secret                        | Из Credentials этого клиента, только в серверной конфигурации                                       |

OIDC-библиотека backend получает endpoints из Discovery: `https://auth.example.ru/realms/training/.well-known/openid-configuration`. Она создаёт state/nonce, использует Code flow и PKCE при поддержке библиотеки, обменивает код с серверным secret и создаёт защищённую сессию приложения. Браузер получает сессионную cookie, токены хранятся на backend. Запросы к Service Desk выполняются оттуда с access token пользователя.

Этот вариант настраивается средствами выбранного стека. Он не требует Angular или `keycloak-js`; публичный клиент `student-service` из SPA-примера не используется как хранилище серверного секрета.

## Переход с localhost на стенд

1. В Keycloak добавить HTTPS callback, origin и адрес выхода стенда.
2. В конфигурации приложения сохранить тот же публичный адрес Identity и нужный `clientId`.
3. Настроить отдачу SPA на `/auth/callback`.
4. Выйти и войти на новом адресе. Проверить `401` без токена и `403` для пользователя без нужной роли.

Сетевые запросы к Service Desk, локальный proxy и входящие webhook описаны в [третьей инструкции](03-service-desk.md).

Справка: [официальный JavaScript-адаптер Keycloak](https://www.keycloak.org/securing-apps/javascript-adapter), [OIDC endpoints](https://www.keycloak.org/securing-apps/oidc-layers), [jose](https://github.com/panva/jose).
