import { SettingsStore } from './dal/settings-store';
export { registerSettingsRoutes } from './api/routes';
export { SettingsLogic } from './logic/settings-logic';
export { SettingsError, type GlobalSettings, type SettingsDocument, type TeamWebhook } from './types';
export { globalSettings, validateSettingsDocument, validateGlobalSettings } from './schema';

/** Default tracked JSON is copied only when state does not exist; never overwrite an existing configuration. */
export function createSettings(defaultFile: string, stateFile: string): Promise<SettingsStore> {
    return SettingsStore.open(defaultFile, stateFile);
}
