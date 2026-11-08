# Общий UI

Граница готовой дизайн-системы PrimeNG 21: контролы реэкспортируются из `@training-desk/ui`, компоненты приложения не импортирует PrimeNG напрямую. Они сохраняют штатный ControlValueAccessor, клавиатуру, overlay и состояния ошибок; самодельной реализации select/input нет.

`provideSharedUi()` устанавливает Aura с синей primary-палитрой, как в локальном `a-spec`, русские сообщения и `.app-dark`. Палитра берётся из стандартных PrimeUI токенов синей палитры. Общий `_ui.scss` связывает токены раскладки `libs/theme` с семантическими переменными PrimeNG. Провайдер подключается и SCSS один раз на приложение.

Источник подхода: `/Users/makar/WebstormProjects/a-spec/apps/front/src/app/app.config.ts` и `libs/front/shared/src/lib/ui`. Проект не зависит от файлов соседнего checkout. Используются публичные MIT-пакеты PrimeNG и PrimeUI themes, исходники a-spec не копируются.

Angular использует готовые PrimeNG-контролы. Keycloak не запускает Angular и использует общие SCSS-токены, не зависящие от фреймворка из `libs/theme`; его нативные FTL-контролы используют общий адаптер `libs/ui/src/_identity.scss` и типографику `_tokens.scss`.

Для списков доступны `UiVirtualScrollViewport`, `UiVirtualFor`, `UiFixedSizeVirtualScroll` — экспорт Angular CDK через общую UI-границу. Высота строки должна совпадать с `itemSize`; виртуальная прокрутка используется вместе с автоматической подгрузкой серверных порций данных.
