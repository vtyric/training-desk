import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { SettingsDocument } from '../../../../../../../libs/settings/types';

import {
    DeskRequest,
    RequestComment,
    RequestFields,
    RequestStatus,
    RequestsPage,
    RequestTransition,
    TransitionInput,
} from './portal.models';

@Injectable({ providedIn: 'root' })
export class PortalApi {
    private readonly http = inject(HttpClient);

    settings(): Promise<SettingsDocument> {
        return firstValueFrom(this.http.get<SettingsDocument>('/api/settings'));
    }

    async saveSettings(document: SettingsDocument): Promise<{ document: SettingsDocument; restartRequired: boolean }> {
        const response = await firstValueFrom(
            this.http.put<SettingsDocument>('/api/settings', document, {
                observe: 'response',
                headers: { 'If-Match': `"${document.revision}"` },
            })
        );
        if (!response.body)
            throw new Error('Не удалось подтвердить сохранение. Обновите настройки и проверьте изменения.');
        return {
            document: response.body,
            restartRequired: response.headers.get('X-Restart-Required') === 'true',
        };
    }

    listRequests(requestStatus: RequestStatus, start = 0, limit = 20): Promise<RequestsPage> {
        return firstValueFrom(
            this.http.get<RequestsPage>('/rest/servicedeskapi/request', {
                params: { requestStatus, start, limit },
            })
        );
    }

    fields(typeId: string): Promise<RequestFields> {
        return firstValueFrom(
            this.http.get<RequestFields>(`/rest/servicedeskapi/servicedesk/3/requesttype/${typeId}/field`)
        );
    }

    create(requestTypeId: string, requestFieldValues: Record<string, unknown>): Promise<DeskRequest> {
        return firstValueFrom(
            this.http.post<DeskRequest>('/rest/servicedeskapi/request', {
                serviceDeskId: '3',
                requestTypeId,
                requestFieldValues,
            })
        );
    }

    request(key: string): Promise<DeskRequest> {
        return firstValueFrom(this.http.get<DeskRequest>(`/rest/servicedeskapi/request/${encodeURIComponent(key)}`));
    }

    transitions(key: string): Promise<{ transitions: RequestTransition[] }> {
        return firstValueFrom(
            this.http.get<{ transitions: RequestTransition[] }>(
                `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`,
                { params: { expand: 'transitions.fields' } }
            )
        );
    }

    performTransition(key: string, input: TransitionInput): Promise<void> {
        return firstValueFrom(this.http.post<void>(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, input));
    }

    comments(key: string): Promise<{ values: RequestComment[] }> {
        return firstValueFrom(
            this.http.get<{ values: RequestComment[] }>(
                `/rest/servicedeskapi/request/${encodeURIComponent(key)}/comment`
            )
        );
    }

    comment(key: string, body: string): Promise<RequestComment> {
        return firstValueFrom(
            this.http.post<RequestComment>(`/rest/servicedeskapi/request/${encodeURIComponent(key)}/comment`, {
                body,
                public: true,
            })
        );
    }
}

export function errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
        if (error.status === 0) return 'Сервер недоступен. Проверьте подключение и повторите попытку.';
        if (error.status === 401) return 'Сеанс завершён. Войдите снова.';
        if (error.status === 403)
            return 'У вашей учётной записи нет прав на это действие. Обратитесь к администратору.';
        if (error.status === 404)
            return 'Обращение не найдено или недоступно вашей учётной записи. Вернитесь к списку обращений.';
        if (error.status === 409) return 'Данные изменились. Обновите страницу и повторите действие.';
        const body: unknown = error.error;
        if (body && typeof body === 'object') {
            const data = body as Record<string, unknown>;
            if (typeof data['errorMessage'] === 'string') return data['errorMessage'];
            if (Array.isArray(data['errorMessages'])) return data['errorMessages'].map(String).join(' ');
            if (typeof data['message'] === 'string') return data['message'];
        }
    }
    return 'Не удалось выполнить действие. Попробуйте ещё раз.';
}
