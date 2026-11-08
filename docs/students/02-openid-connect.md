# 2. Вход через OpenID Connect

Приложение команды открывается на localhost, перенаправляет пользователя на форму Artsofte в удалённом Keycloak и получает access token. С этим токеном оно обращается к своему backend и Service Desk.

Подходит любой стек с поддержкой Authorization Code + PKCE S256. Ниже — пример браузерного SPA на TypeScript с `keycloak-js`. Пользователи и роли готовятся по [первой инструкции](01-keycloak-and-roles.md).

## Регистрация локального приложения и стенда

В **Clients → student-service** задаются:

| Параметр                   | Значение для SPA      |
| -------------------------- | --------------------- |
| Client type / Protocol     | OpenID Connect        |
| Client authentication      | Off: публичный клиент |
| Standard flow              | On                    |
| Implicit flow              | Off                   |
| Direct access grants       | Off                   |
| PKCE Code Challenge Method | S256                  |

Пример адресов для локального frontend на порту `4300` и стенда команды:

| Настройка                       | Локально                              | Стенд                                    |
| ------------------------------- | ------------------------------------- | ---------------------------------------- |
| Valid Redirect URIs             | `http://localhost:4300/auth/callback` | `https://team1.example.ru/auth/callback` |
| Web Origins                     | `http://localhost:4300`               | `https://team1.example.ru`               |
| Valid Post Logout Redirect URIs | `http://localhost:4300/`              | `https://team1.example.ru/`              |

Адреса задаются точно, включая порт и путь. `localhost` и `127.0.0.1` — разные origins. Для другого порта требуется отдельная запись.

Для параллельных проектов можно создать клиентов по образцу `student-service`. При копировании сохраняются нужные mapper имени, `team_slug`, ролей и audience из первой инструкции. Изменение ENV не обновляет существующего клиента: адреса сохраняются в консоли Keycloak.

## Как открывается готовая форма входа

Приложение не собирает пароль. Его кнопка «Войти» запускает OIDC-клиент, который открывает готовую страницу Artsofte на домене Keycloak. После входа браузер возвращается на `/auth/callback`, а SDK обменивает одноразовый код на токены.

```text
Приложение команды → форма Keycloak → callback приложения → защищённый экран
```

Для возврата браузера на localhost туннель не нужен. Если сеанс Keycloak уже открыт, используется SSO без повторного пароля.

## Браузерный пример на TypeScript

Установка в собственном проекте:

```sh
pnpm add keycloak-js
```

Инициализация выполняется до запуска роутера:

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

if (window.location.pathname === '/auth/callback') {
    window.history.replaceState(window.history.state, '', '/');
}

// Здесь запускается роутер приложения.
```

SDK обрабатывает callback и проверяет OIDC state/nonce. В этом примере после входа открывается главная страница. Если требуется возврат в карточку, до входа сохраняется только проверенный внутренний путь. Токены, код и параметры OAuth в такое хранилище не записываются.

При прямом открытии `/auth/callback` web-сервер приложения должен отдавать SPA, например через fallback на `index.html`.

### Вариант с кнопкой «Войти»

Для публичного экрана в `init` используется `onLoad: 'check-sso'`. Проверка `if (!authenticated) throw` из примера убирается: при `false` приложение показывает кнопку, при `true` — защищённый экран.

```ts
await keycloak.login({
    redirectUri: `${window.location.origin}/auth/callback`,
});
```

Выход:

```ts
await keycloak.logout({
    redirectUri: `${window.location.origin}/`,
});
```

Завершающий `/` совпадает с зарегистрированным адресом выхода. Logout завершает общую сессию Identity, включая другие подключённые приложения.

## Запрос к собственному backend

Access и refresh tokens остаются в памяти SDK. Перед запросом SDK обновляет access token при необходимости:

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

`/api/profile` здесь обозначает маршрут backend команды. В Service Desk такого пути нет. Для запросов к Service Desk через proxy используется адаптер из [третьей инструкции](03-service-desk.md).

## Проверка подписи и роли на backend

Backend проверяет токен до выполнения защищённого действия. Скрытие кнопок в браузере служит только оформлением интерфейса.

После настройки собственной audience и ролей по первой инструкции пример Node.js выглядит так:

```sh
pnpm add jose
```

```ts
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const issuer = 'https://auth.example.ru/realms/training';
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

Адрес JWKS берётся из доверенной конфигурации Identity/Discovery, а не из непроверенного JWT. HTTP-обработчик выбранного фреймворка возвращает `401` при ошибке проверки токена и `403` при отсутствии роли. Пример не создаёт HTTP-маршрут приложения.

Если сервис разделяет данные по службам, backend связывает проверенный `team_slug` с разрешённым разделом. Значение из тела запроса права не расширяет.

API Service Desk ожидает audience `service-desk`; backend команды в примере — `student-service`. Mapper может включить оба значения в один access token. Для API передаётся access token, а не ID token.

## Вариант с серверным входом

Если callback и сессию обрабатывает backend, вместо SPA-клиента создаётся отдельный confidential client, например `student-service-web`:

| Настройка                            | Значение                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Client authentication                | On                                                                                                   |
| Standard flow                        | On                                                                                                   |
| Direct access grants / Implicit flow | Off                                                                                                  |
| Valid Redirect URIs                  | Точный callback backend: например, `http://localhost:3000/auth/callback` и его HTTPS-адрес на стенде |
| Mapper                               | Нужные роли и audience Service Desk и собственного сервиса                                           |
| Client secret                        | Из Credentials клиента; только в серверной конфигурации                                              |

OIDC-библиотека backend получает endpoints из `https://auth.example.ru/realms/training/.well-known/openid-configuration`. Она создаёт state/nonce, выполняет Code flow и PKCE при поддержке библиотеки, обменивает код с серверным secret и создаёт защищённую сессию приложения.

Браузер получает сессионную cookie; токены хранятся на backend. Оттуда выполняются запросы к Service Desk с access token пользователя. Такой вариант настраивается библиотекой выбранного стека и не требует `keycloak-js`.

## Перенос с localhost на стенд

1. В Keycloak зарегистрированы HTTPS callback, origin и адрес выхода стенда.
2. В приложении указаны прежний публичный адрес Identity и нужный `clientId`.
3. На `/auth/callback` web-сервер отдаёт приложение.
4. После повторного входа проверены `401` без токена и `403` без нужной роли.

Далее: [proxy, webhook и API Service Desk](03-service-desk.md).

Справка: [JavaScript-адаптер Keycloak](https://www.keycloak.org/securing-apps/javascript-adapter), [OIDC endpoints](https://www.keycloak.org/securing-apps/oidc-layers), [jose](https://github.com/panva/jose).
