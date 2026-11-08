import { HttpInterceptorFn } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import Keycloak from 'keycloak-js';
import { from, switchMap } from 'rxjs';

interface PublicConfig {
    identity: { url: string; realm: string; clientId: string };
}

/** Public browser client; access and refresh tokens live only inside the SDK instance. */
@Injectable({ providedIn: 'root' })
export class PortalAuth {
    private client?: Keycloak;
    private initialization?: Promise<boolean>;

    initialize(): Promise<boolean> {
        this.initialization ??= this.initializeClient();
        return this.initialization;
    }

    get username(): string {
        const value: unknown = this.client?.tokenParsed?.['preferred_username'];
        return typeof value === 'string' ? value : 'Пользователь';
    }

    get displayName(): string {
        const value: unknown = this.client?.tokenParsed?.['name'] ?? this.client?.idTokenParsed?.['name'];
        return typeof value === 'string' && value.trim() ? value : this.username;
    }

    get authenticated(): boolean {
        return Boolean(this.client?.authenticated);
    }

    get canConfigure(): boolean {
        return Boolean(this.client?.hasResourceRole('admin', 'service-desk'));
    }

    get roleLabel(): string {
        if (this.client?.hasResourceRole('admin', 'service-desk')) return 'Администратор службы поддержки';
        if (this.client?.hasResourceRole('support-lead', 'service-desk')) return 'Руководитель поддержки';
        if (this.client?.hasResourceRole('support', 'service-desk')) return 'Сотрудник поддержки';
        if (this.client?.hasResourceRole('customer', 'service-desk')) return 'Заявитель';
        return 'Нет доступа к службе поддержки';
    }

    async accessToken(): Promise<string> {
        await this.initialize();
        if (!this.client?.authenticated) throw new Error('Не удалось войти. Обновите страницу и войдите снова.');
        await this.client.updateToken(30);
        if (!this.client.token) throw new Error('Сеанс завершён. Войдите снова.');
        return this.client.token;
    }

    async login(): Promise<void> {
        await this.client?.login({ redirectUri: `${window.location.origin}/auth/callback` });
    }

    async logout(): Promise<void> {
        await this.client?.logout({ redirectUri: `${window.location.origin}/` });
    }

    private async initializeClient(): Promise<boolean> {
        const response = await fetch('/api/config', { cache: 'no-store' });
        if (!response.ok) throw new Error('Не удалось загрузить параметры входа. Обновите страницу.');
        const config = (await response.json()) as PublicConfig;
        if (!config.identity?.url || !config.identity.realm || !config.identity.clientId) {
            throw new Error('Вход не настроен. Обратитесь к администратору.');
        }
        this.client = new Keycloak(config.identity);
        return this.client.init({
            onLoad: 'login-required',
            flow: 'standard',
            pkceMethod: 'S256',
            checkLoginIframe: false,
            redirectUri: `${window.location.origin}/auth/callback`,
        });
    }
}

/** Never send the Service Desk bearer token to identity or an arbitrary third-party URL. */
export const serviceDeskBearer: HttpInterceptorFn = (request, next) => {
    const target = new URL(request.url, window.location.origin);
    const protectedPath = target.pathname.startsWith('/rest/') || target.pathname.startsWith('/api/');
    if (target.origin !== window.location.origin || !protectedPath) return next(request);
    const auth = inject(PortalAuth);
    return from(auth.accessToken()).pipe(
        switchMap((token) => next(request.clone({ setHeaders: { Authorization: `Bearer ${token}` } })))
    );
};
