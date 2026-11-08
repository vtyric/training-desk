import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { globalSettings, validateSettingsDocument } from '../schema';
import { SettingsError, type GlobalSettings, type SettingsDocument } from '../types';

/** Single-process writer with atomic file replacement; JSON is the source of truth, never a DB mirror. */
export class SettingsStore {
    private pending: Promise<void> = Promise.resolve();
    private constructor(
        private readonly stateFile: string,
        private readonly active: GlobalSettings
    ) {}

    static async open(defaultFile: string, stateFile: string): Promise<SettingsStore> {
        if (resolve(defaultFile) === resolve(stateFile))
            throw new Error('Settings state file must differ from the tracked defaults');
        const defaults = validateSettingsDocument(JSON.parse(await readFile(defaultFile, 'utf8')));
        let document: SettingsDocument;
        try {
            document = validateSettingsDocument(JSON.parse(await readFile(stateFile, 'utf8')));
        } catch (error) {
            if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
            document = defaults;
            await SettingsStore.atomicWrite(stateFile, document);
        }
        return new SettingsStore(stateFile, globalSettings(document));
    }

    getActiveConfig(): GlobalSettings {
        return structuredClone(this.active);
    }

    async read(): Promise<SettingsDocument> {
        await this.pending;
        return this.readFile();
    }

    /** Version check and rename happen under the same in-process write queue. */
    update(
        mutator: (current: SettingsDocument) => SettingsDocument | Promise<SettingsDocument>,
        expectedRevision?: number
    ): Promise<SettingsDocument> {
        const operation = this.pending.then(async () => {
            const current = await this.readFile();
            if (expectedRevision !== undefined && current.revision !== expectedRevision)
                throw new SettingsError(409, 'Настройки уже изменились. Загрузите их заново и повторите сохранение');
            if (current.revision === Number.MAX_SAFE_INTEGER)
                throw new SettingsError(
                    409,
                    'Не удалось сохранить настройки: достигнут предел редакций. Обратитесь к администратору'
                );
            const updated = await mutator(structuredClone(current));
            const next = validateSettingsDocument({
                ...updated,
                version: 1,
                revision: current.revision + 1,
            });
            await SettingsStore.atomicWrite(this.stateFile, next);
            return structuredClone(next);
        });
        this.pending = operation.then(
            () => undefined,
            () => undefined
        );
        return operation;
    }

    private async readFile(): Promise<SettingsDocument> {
        return validateSettingsDocument(JSON.parse(await readFile(this.stateFile, 'utf8')));
    }

    private static async atomicWrite(file: string, document: SettingsDocument): Promise<void> {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            const handle = await open(temporary, 'wx', 0o600);
            try {
                await handle.writeFile(`${JSON.stringify(document, null, 4)}\n`);
                await handle.sync();
            } finally {
                await handle.close();
            }
            await rename(temporary, file);
            const directory = await open(dirname(file), 'r');
            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
        } finally {
            await rm(temporary, { force: true });
        }
    }
}
