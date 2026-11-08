# Общая SCSS-тема

Nx-библиотека `theme` для оформления портала и страниц входа. Потребители — экран Keycloak в `apps/identity/theme` и Angular-портал в `apps/service-desk/ui`. Приложение модерации студентов находится в отдельном репозитории.

Точка подключения — `src/_index.scss`. Файл `src/_theme.scss` предоставляет короткий импорт `theme`, если Sass `loadPaths` включает `libs/theme/src`.

## Подключение

Один раз в глобальном SCSS приложения:

```scss
@use 'theme';
@include theme.install();
```

Для раскладки отдельного identity-сервиса:

```scss
@use 'theme';
@use 'federation';
@use '../../../libs/ui/src/identity';
@include theme.install($native-controls: false);
@include identity.install();
@include federation.install();
```

Сборщик должен передать `libs/theme/src` в Sass `loadPaths`. `tools/build-identity-theme.mjs` уже делает это и копирует необходимые шрифты в ресурсы Keycloak.

В Angular-портале контролы принадлежат готовой дизайн-системе PrimeNG через `libs/ui`: вызывайте `theme.install($native-controls: false)` и общий `ui.install()`, чтобы нативные FTL-стили не переопределяли PrimeNG. `provideSharedUi()` устанавливает Aura/blue как в a-spec. Keycloak также отключает старые нативные контролы через `theme.install($native-controls: false)` и подключает `identity.install()` из `libs/ui/src/_identity.scss`.

Тема по умолчанию — бело-голубая `abanking`, primary соответствует синей палитре Aura. Для переключения используется `data-theme="artsofte"`; `data-theme="abanking"` возвращает основную тему. Атрибут можно установить на корневой элемент или контейнер: переменные наследуются дочерними элементами.

## Настройка токенов

Через SCSS при установке:

```scss
@use 'theme';
@include theme.install(
    $overrides: (
        color-primary: #2e62d9,
        radius: 8px,
    )
);
```

Либо через CSS после библиотеки:

```scss
:root {
    --desk-color-primary: #2e62d9;
    --desk-color-primary-hover: #2453b8;
    --desk-radius: 8px;
}
```

SCSS-overrides меняют корневую тему. Явный `data-theme` устанавливает значения выбранного варианта заново; для его настройки используйте соответствующий CSS-селектор после установки библиотеки либо `theme.properties()` с overrides внутри этого селектора.

## Ответственность модулей

- `tokens` — карты тем и генерация `--desk-*`: цвета, типографика, радиусы, тени, фокус и disabled.
- `typography` — локальные шрифты Montserrat, тексты, заголовки, подписи полей.
- `controls` — кнопки, поля, валидация, фокус и reduced motion.
- `surfaces` — `.panel`, `.error-banner`, `.success-note`, `.status`, загрузка.
- `federation` — уникальная геометрия полноэкранной страницы identity, отдельно подключаемый mixin.

Точки входа используют общие семантические классы и токены. В стилях приложения остаётся только его раскладка; палитры, стили controls и шрифты не копируются.

## Assets и происхождение

Шрифты и лицензия поставляются библиотекой в `libs/theme/assets/brand`. Происхождение и контрольные суммы записаны в [sources.json](assets/brand/sources.json). Бренд портала — текстовый Artsofte; изображение Abanking больше не поставляется. Angular-контролы используют общий Aura/blue preset из `libs/ui`.

Базовая типографика использует `/brand/montserrat-{latin,cyrillic}.woff2`. Потребитель копирует assets с сохранением этих адресов либо адаптирует их на этапе сборки. Identity-сборщик заменяет только пути шрифтов на `../fonts/*` относительно CSS Keycloak и копирует OFL/provenance. Внешний CDN не требуется.

Файл `favicon.svg` — созданная для стенда белая буква A на синем фоне; портал и Swagger используют один asset. Это не официальный логотип Artsofte. В Keycloak он не подключён. Файла `artsofte.svg` в библиотеке нет. Название темы `artsofte` и заголовок «Artsofte Federation» являются текстовой конфигурацией учебного identity, а не ссылкой на удалённые assets.
