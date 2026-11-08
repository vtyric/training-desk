import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';
import { providePrimeNG } from 'primeng/config';

/** Same Aura/blue theme contract as a-spec, using its underlying PrimeUI palette tokens. */
export const serviceDeskPreset = definePreset(Aura, {
    semantic: {
        primary: {
            50: '{blue.50}',
            100: '{blue.100}',
            200: '{blue.200}',
            300: '{blue.300}',
            400: '{blue.400}',
            500: '{blue.500}',
            600: '{blue.600}',
            700: '{blue.700}',
            800: '{blue.800}',
            900: '{blue.900}',
            950: '{blue.950}',
        },
    },
});

/** Install once per Angular application; controls, overlays and Forms share one theme. */
export function provideSharedUi() {
    return providePrimeNG({
        ripple: false,
        theme: { preset: serviceDeskPreset, options: { darkModeSelector: '.app-dark' } },
        translation: {
            emptyMessage: 'Нет вариантов для выбора',
            emptyFilterMessage: 'Ничего не найдено',
            emptySearchMessage: 'Ничего не найдено',
            searchMessage: 'Найдено: {0}',
            selectionMessage: 'Выбрано: {0}',
            emptySelectionMessage: 'Не выбрано',
            clear: 'Очистить',
            accept: 'Да',
            reject: 'Нет',
            cancel: 'Отмена',
            aria: { close: 'Закрыть', trueLabel: 'Да', falseLabel: 'Нет', nullLabel: 'Не выбрано' },
        },
    });
}
