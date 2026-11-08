# 2. Вход в приложение через OpenID Connect

После настройки приложение команды открывает готовую форму Artsofte, получает access token и передаёт его своему backend и Service Desk. Пример ниже рассчитан на frontend `http://localhost:4300` и backend `http://localhost:3000`. Подходит другой стек, если он поддерживает Authorization Code + PKCE S256.

До подключения подготовлены пользователь, роль `student-service:admin` и audience `student-service` из [первой инструкции](01-keycloak-and-roles.md).

## 1. Адреса входа

| Параметр приложения     | Значение                                                                         |
| ----------------------- | -------------------------------------------------------------------------------- |
| Адрес Identity          | `https://auth.makar-star.space`                                                  |
| Realm                   | `training`                                                                       |
| Client ID               | `student-service`                                                                |
| Issuer для проверки JWT | `https://auth.makar-star.space/realms/training`                                  |
| Discovery               | `https://auth.makar-star.space/realms/training/.well-known/openid-configuration` |

Пароль вводится на странице Keycloak. Приложение команды не создаёт свою форму для сбора корпоративного пароля.

## 2. Регистрация localhost в Keycloak

1. Открывается [консоль администратора](https://auth.makar-star.space/admin/master/console/#/training/clients), выполняется вход как `administrator`.
2. В realm **training** открывается **Clients → student-service → Settings**.
3. Проверяются параметры:

| Поле                            | Значение                              |
| ------------------------------- | ------------------------------------- |
| Client authentication           | Off — public client                   |
| Standard flow                   | On                                    |
| Implicit flow                   | Off                                   |
| Direct access grants            | Off                                   |
| Valid Redirect URIs             | `http://localhost:4300/auth/callback` |
| Web Origins                     | `http://localhost:4300`               |
| Valid Post Logout Redirect URIs | `http://localhost:4300/`              |

4. В **Advanced** проверяется **Proof Key for Code Exchange Code Challenge Method = S256**.
5. Изменения сохраняются.

Порт и путь должны совпадать с приложением. `localhost:4300` и `127.0.0.1:4300` — разные адреса. В Redirect URIs не нужен общий `*`.

В текущей конфигурации localhost на порту `4300` уже зарегистрирован. При выборе другого порта команда добавляет точные адреса для него. Если несколько проектов используют один клиент, чужие адреса из списка сохраняются; для независимых настроек создаётся отдельный клиент по образцу `student-service` с теми же нужными mapper и собственным client ID.

## 3. Подключение готовой формы входа

В своём frontend-проекте устанавливается SDK:

```sh
pnpm add keycloak-js
```

Создаётся модуль `auth.ts`:

```ts
import Keycloak from 'keycloak-js';

export const keycloak = new Keycloak({
    url: 'https://auth.makar-star.space',
    realm: 'training',
    clientId: 'student-service',
});

export async function initializeAuth() {
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
}

export async function logout() {
    await keycloak.logout({ redirectUri: `${window.location.origin}/` });
}
```

`initializeAuth()` вызывается один раз до запуска роутера и запросов защищённых данных. На пути `/auth/callback` web-сервер отдаёт тот же frontend, например через fallback на `index.html`. Отдельный экран с ручным обменом кода не нужен: callback обрабатывает SDK.

Ожидаемый сценарий:

1. В браузере открывается `http://localhost:4300`.
2. SDK переводит браузер на `auth.makar-star.space`.
3. Пользователь входит под своей учёткой realm `training`, например `desk-admin`.
4. Браузер возвращается на localhost, SDK обменивает код на токены и открывает приложение.

Для этого возврата туннель не нужен: к localhost обращается браузер самого пользователя. Токены остаются в памяти SDK. Пример не сохраняет их в localStorage и не содержит client secret.

Если сначала нужен публичный экран с кнопкой «Войти», вместо `login-required` используется `check-sso`; отсутствие входа не считается ошибкой. Кнопка вызывает:

```ts
await keycloak.login({
    redirectUri: `${window.location.origin}/auth/callback`,
});
```

## 4. Отправка токена своему backend

Локальный proxy из [третьей инструкции](03-service-desk.md) направит `/api` на backend `localhost:3000`.

```ts
import { keycloak } from './auth';

export async function ownApi(path: string) {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
        throw new Error('Неизвестный адрес собственного API');
    }
    await keycloak.updateToken(30);
    if (!keycloak.token) throw new Error('Вход не выполнен');

    return fetch(url, {
        headers: { Authorization: `Bearer ${keycloak.token}` },
    });
}

const response = await ownApi('/api/admin');
```

`/api/admin` — маршрут приложения команды. В Service Desk такого пути нет. Для API передаётся access token; ID token предназначен для клиента входа.

## 5. Проверка «вход только администраторам» на backend

Keycloak подтверждает личность и выдаёт роли. Решение, разрешено ли действие, принимает backend команды. Проверка должна выполняться на каждом защищённом маршруте.

Ниже — минимальный пример Node.js. Он возвращает `200` только для роли **student-service → admin**, `401` без подходящего токена и `403` при отсутствии роли.

```sh
pnpm add fastify jose
```

Файл `server.mjs`:

```js
import Fastify from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const app = Fastify();
const issuer = 'https://auth.makar-star.space/realms/training';
const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));

app.get('/api/admin', async (request, reply) => {
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    if (!token) return reply.code(401).send({ error: 'Войдите в приложение' });

    let payload;
    try {
        ({ payload } = await jwtVerify(token, jwks, {
            issuer,
            audience: 'student-service',
            algorithms: ['RS256'],
            requiredClaims: ['sub', 'iat', 'exp'],
        }));
        if (payload.typ !== 'Bearer') throw new Error('Неверный тип токена');
    } catch {
        return reply.code(401).send({ error: 'Не удалось подтвердить вход' });
    }

    const roles = payload.resource_access?.['student-service']?.roles;
    if (!Array.isArray(roles) || !roles.includes('admin')) {
        return reply.code(403).send({ error: 'Нужна роль администратора приложения' });
    }
    return { username: payload.preferred_username, access: 'admin' };
});

await app.listen({ host: '127.0.0.1', port: 3000 });
```

Запуск:

```sh
node server.mjs
```

Backend получает открытые ключи с доверенного адреса JWKS и проверяет подпись, issuer, audience и срок токена. Декодирование JWT без `jwtVerify` эти проверки не выполняет. Роль проверяется у своего клиента `student-service`, а не по совпадению строки `admin` в любом месте токена.

В рабочем приложении эта проверка выносится в общий middleware/preHandler и подключается ко всем административным маршрутам. Браузер может скрыть недоступные разделы для удобства, но серверная проверка всё равно обязательна.

## 6. Проверка localhost

| Действие                                                                          | Ожидаемый результат                                                     |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Запрос `/api/admin` без Authorization                                             | `401`                                                                   |
| Вход `desk-admin`, которому назначена `student-service:admin`, затем `/api/admin` | `200`                                                                   |
| Вход `alice` или `support` без этой роли, затем `/api/admin`                      | `403`                                                                   |
| Кнопка выхода                                                                     | Сессия Identity завершается; новый защищённый вход снова запускает OIDC |
| Просроченный или изменённый токен                                                 | `401`                                                                   |

После изменения ролей выполняется выход и повторный вход, чтобы получить новый токен. Logout завершает общую сессию Keycloak; другие приложения этой сессии тоже потребуют новый вход. Уже выданный access JWT может оставаться действительным до своего срока истечения, если API не использует отдельную проверку отзыва.

## 7. Подключение своего стенда

Когда приложение команды опубликовано, в **Clients → student-service → Settings** добавляются его точные адреса. Например, для `https://team1.example.ru`:

| Поле                            | Значение                                 |
| ------------------------------- | ---------------------------------------- |
| Valid Redirect URIs             | `https://team1.example.ru/auth/callback` |
| Web Origins                     | `https://team1.example.ru`               |
| Valid Post Logout Redirect URIs | `https://team1.example.ru/`              |

Локальные адреса можно оставить для разработки. В коде остаются прежние `url`, `realm` и `clientId`; callback из примера вычисляется из адреса frontend. На стенде `/auth/callback` должен отдавать приложение, а `/api` — вести на backend команды. Если frontend и backend имеют разные домены, команда дополнительно настраивает свой CORS либо общий reverse proxy.

Для серверного приложения с cookie-сессией вместо SPA создаётся отдельный confidential client: **Client authentication = On**, точный callback backend и secret только на сервере. OIDC-библиотека выбранного стека обрабатывает Code flow и сессию. Этот вариант не требует `keycloak-js`; менять способ входа на передачу логина и пароля в API не нужно.

Официальная справка: [JavaScript-адаптер Keycloak](https://www.keycloak.org/securing-apps/javascript-adapter), [пользователи и клиентские scopes](https://www.keycloak.org/docs/latest/server_admin/), [jose](https://github.com/panva/jose).
