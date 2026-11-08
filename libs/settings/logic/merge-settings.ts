import { SettingsError } from '../types';

const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validatePatch(value: unknown) {
    if (value === null) throw new SettingsError(400, 'Для изменения настройки укажите значение вместо null');
    if (Array.isArray(value)) {
        for (const item of value) validatePatch(item);
    } else if (object(value)) {
        for (const [key, item] of Object.entries(value)) {
            if (forbidden.has(key)) throw new SettingsError(400, 'Недопустимое имя настройки');
            validatePatch(item);
        }
    }
}

/** Objects merge recursively; arrays and scalar fields are replaced as complete values. */
export function mergeSettings(current: unknown, patch: unknown): unknown {
    if (!object(patch) || !Object.keys(patch).length)
        throw new SettingsError(400, 'Укажите объект с настройками, которые нужно изменить');
    if (Object.hasOwn(patch, 'version') || Object.hasOwn(patch, 'revision'))
        throw new SettingsError(400, 'version и revision нельзя изменять через PATCH; используйте If-Match');
    validatePatch(patch);
    return merge(current, patch);
}
function merge(current: unknown, patch: unknown): unknown {
    if (!object(patch)) return structuredClone(patch);
    const next = object(current) ? structuredClone(current) : {};
    for (const [key, value] of Object.entries(patch)) next[key] = merge(next[key], value);
    return next;
}
