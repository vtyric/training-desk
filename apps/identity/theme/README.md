# Тема отдельного identity-сервиса

Keycloak login theme `artsofte`, родитель `keycloak`. Путь формы, имена `username`, `password`, скрытый `credentialId` и обработка `messagesPerField` сверены с [официальным login.ftl Keycloak 26.7.0](https://github.com/keycloak/keycloak/blob/26.7.0/themes/src/main/resources/theme/base/login/login.ftl). Общие правила тем — в [Server Developer Guide](https://www.keycloak.org/docs/latest/server_development/#_themes).

`login.ftl` принадлежит identity-сервису. Только он принимает пароль и отправляет его в `${url.loginAction}` Keycloak. Приложения студентов в отдельных репозиториях подключаются к identity по OIDC. Тестовый Service Desk содержит API и встроенный UI, использующий `keycloak-js` и Bearer JWT; форму пароля предоставляет только Identity. Тема не реализует authentication flow, проверку LDAP, SSO-сессию или обмен кодом — это задачи Keycloak и backend приложений.

Экран полноэкранный: синий геометрический фон слева, белая форма Artsofte Federation справа. Он явно обозначен учебным. Нет скопированных корпоративных паролей, фотографий или логотипа Artsofte. На узком экране фон становится компактной верхней областью.

Источник общих fonts, controls и tokens — [libs/theme](../../../libs/theme/README.md); раскладка identity хранится в `_federation.scss` той же библиотеки. Приложение подключает install-mixins в `styles.scss`, а не собственную палитру. Выбор `loginTheme: artsofte` в realm выполняется конфигурацией identity.

## Сборка

Из корня репозитория:

```sh
node tools/build-identity-theme.mjs
```

Результат: `dist/apps/identity/theme/artsofte/login`. Туда копируются шаблон, properties, русские/английские messages, CSS и шрифты вместе с OFL и provenance. Сборка очищает только свой generated каталог `dist/apps/identity/theme`. CSS компилируется Sass из общей темы; browser-адреса шрифтов заменяются на относительные `../fonts/*`, поскольку Keycloak обслуживает theme resources по собственному URL.

`federation.ftl` задаёт общий бело-голубой экран. `template.ftl` сохраняет интерфейс `registrationLayout` Keycloak 26.7: наследуемые страницы истёкшего входа, информации и подтверждения выхода используют тот же экран и shared controls. `error.ftl` показывает санитизированную ошибку и безопасный возврат на настроенный `client.baseUrl` либо Keycloak restart URL; параметры redirect из запроса не копируются.

Общий экран подключает штатный `authChecker.js` Keycloak (`startSessionPolling` / `checkAuthSession`): вкладки входа реагируют на созданную в другой вкладке SSO-сессию и смену authentication session. Это не отключает проверку `different_user_authenticated`; при конфликте пользователь получает оформленное объяснение и путь повторного входа. Источники контрактов: [template.ftl](https://github.com/keycloak/keycloak/blob/26.7.0/themes/src/main/resources/theme/base/login/template.ftl), [authChecker.js](https://github.com/keycloak/keycloak/blob/26.7.0/themes/src/main/resources/theme/base/login/resources/js/authChecker.js). Любое обновление Keycloak требует сверки FreeMarker-переменных и проверки реального rendering/login в identity; успешная Sass-компиляция сама по себе не подтверждает корректность серверного шаблона.
