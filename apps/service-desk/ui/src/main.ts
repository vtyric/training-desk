import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, RouterOutlet } from '@angular/router';
import { provideSharedUi } from '@training-desk/ui/theme';

import { PortalAuth, serviceDeskBearer } from './app/features/portal/portal-auth.service';

@Component({ selector: 'app-root', standalone: true, imports: [RouterOutlet], template: '<router-outlet />' })
class AppComponent {}

const loadPortal = () => import('./app/features/portal/portal.component').then((module) => module.PortalComponent);

const returnPathKey = 'service-desk.return-path';
function allowedPortalPath(path: string | null): string {
    return path && /^\/(?:requests(?:\/HELP-[1-9]\d*)?)?$/.test(path) ? path : '/';
}

/** Store only a validated internal route, never credentials or tokens. */
function rememberPortalPath(): void {
    if (window.location.pathname === '/auth/callback') return;
    try {
        window.sessionStorage.setItem(returnPathKey, allowedPortalPath(window.location.pathname));
    } catch {
        // Browser storage may be unavailable; login can still complete at the home page.
    }
}
function restorePortalPath(): void {
    if (window.location.pathname !== '/auth/callback') return;
    let path = '/';
    try {
        path = allowedPortalPath(window.sessionStorage.getItem(returnPathKey));
        window.sessionStorage.removeItem(returnPathKey);
    } catch {
        // An unavailable storage must not prevent a successful Identity login.
    }
    window.history.replaceState(window.history.state, '', path);
}

/** Initialize the official adapter before Router can consume the OIDC callback URL. */
async function start(): Promise<void> {
    rememberPortalPath();
    const auth = new PortalAuth();
    const authenticated = await auth.initialize();
    if (!authenticated) return;
    restorePortalPath();
    await bootstrapApplication(AppComponent, {
        providers: [
            { provide: PortalAuth, useValue: auth },
            provideZonelessChangeDetection(),
            provideSharedUi(),
            provideHttpClient(withInterceptors([serviceDeskBearer])),
            provideRouter([
                { path: '', loadComponent: loadPortal, pathMatch: 'full' },
                { path: 'requests', loadComponent: loadPortal, data: { view: 'list' } },
                { path: 'requests/:key', loadComponent: loadPortal },
                { path: 'auth/callback', loadComponent: loadPortal },
                { path: '**', redirectTo: '' },
            ]),
        ],
    });
}

start().catch(() => {
    const root = document.querySelector('app-root');
    if (!root) return;
    const message = document.createElement('p');
    message.setAttribute('role', 'alert');
    message.textContent = 'Не удалось открыть страницу входа. Попробуйте ещё раз.';
    const retry = document.createElement('a');
    retry.href = '/';
    retry.textContent = 'Открыть страницу входа';
    root.replaceChildren(message, retry);
});
