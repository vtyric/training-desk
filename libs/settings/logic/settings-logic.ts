import { globalSettings, validateSettingsDocument } from '../schema';
import type { SettingsStore } from '../dal/settings-store';
import { SettingsError, type SettingsDocument } from '../types';
import { mergeSettings } from './merge-settings';

/** One settings document supports complete replacement and partial updates. */
export class SettingsLogic {
    constructor(
        private readonly store: SettingsStore,
        private readonly validateWebhookUrl: (url: string) => Promise<void>
    ) {}

    get(): Promise<SettingsDocument> {
        return this.store.read();
    }

    restartRequired(document: SettingsDocument): boolean {
        return JSON.stringify(globalSettings(document)) !== JSON.stringify(this.store.getActiveConfig());
    }

    async put(input: unknown, headerRevision?: number): Promise<SettingsDocument> {
        const next = validateSettingsDocument(input);
        if (headerRevision !== undefined && headerRevision !== next.revision)
            throw new SettingsError(
                400,
                'Номера редакции в If-Match и revision различаются. Загрузите настройки заново'
            );
        return this.store.update(async (current) => {
            await this.validateReceivers(next, current);
            return next;
        }, next.revision);
    }
    patch(input: unknown, headerRevision?: number): Promise<SettingsDocument> {
        return this.store.update(async (current) => {
            const next = validateSettingsDocument(mergeSettings(current, input));
            await this.validateReceivers(next, current);
            return next;
        }, headerRevision);
    }

    private async validateReceivers(next: SettingsDocument, current: SettingsDocument): Promise<void> {
        // Validation and stable metadata use the same revision-checked writer as the final rename.
        for (const [id, entry] of Object.entries(next.teams)) {
            const webhook = entry.webhook;
            const existing = current.teams[id]?.webhook;
            if (webhook.url !== webhook.url.trim())
                throw new SettingsError(400, 'Уберите пробелы в начале и конце адреса уведомлений');
            // Disabling an existing receiver remains possible when its DNS is unavailable.
            if (webhook.url && (webhook.enabled || existing?.url !== webhook.url)) {
                try {
                    await this.validateWebhookUrl(webhook.url);
                } catch {
                    throw new SettingsError(400, 'Укажите общедоступный HTTPS-адрес для уведомлений');
                }
            }
            if (existing) webhook.createdAt = existing.createdAt;
        }
    }
}
