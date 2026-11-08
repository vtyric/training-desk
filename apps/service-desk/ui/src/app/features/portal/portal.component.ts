import { DatePipe } from '@angular/common';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, FormRecord, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink, RouterLinkActive } from '@angular/router';
import {
    UiButton,
    UiInput,
    UiTextarea,
    UiSelect,
    UiMessage,
    UiTag,
    UiSpinner,
    UiVirtualScrollViewport,
    UiVirtualFor,
    UiFixedSizeVirtualScroll,
} from '@training-desk/ui';

import { errorMessage, PortalApi } from './portal-api.service';
import { PortalAuth } from './portal-auth.service';
import type { SettingsDocument } from '../../../../../../../libs/settings/types';
import {
    DeskRequest,
    RequestAssignee,
    RequestComment,
    RequestField,
    REQUEST_TYPES,
    Session,
    RequestStatus,
    RequestsPage,
    RequestTransition,
    TransitionInput,
} from './portal.models';

@Component({
    selector: 'app-portal',
    standalone: true,
    imports: [
        FormsModule,
        ReactiveFormsModule,
        RouterLink,
        RouterLinkActive,
        DatePipe,
        UiButton,
        UiInput,
        UiTextarea,
        UiSelect,
        UiMessage,
        UiTag,
        UiSpinner,
        UiVirtualScrollViewport,
        UiVirtualFor,
        UiFixedSizeVirtualScroll,
    ],
    templateUrl: './portal.component.html',
    styleUrl: './portal.component.scss',
})
export class PortalComponent implements OnInit {
    private readonly api = inject(PortalApi);
    readonly auth = inject(PortalAuth);
    private readonly router = inject(Router);
    private readonly route = inject(ActivatedRoute);
    private readonly destroyRef = inject(DestroyRef);
    private fieldLoad = 0;
    private listLoad = 0;
    private nextRequestStart = 0;
    private lastRequestIndex = 0;
    private visibleRequestRows = 1;
    private requestsViewport?: UiVirtualScrollViewport;
    private cardLoad = 0;
    private transitionKey: string | null = null;

    readonly view = signal<'create' | 'list' | 'request'>('create');
    readonly requestsPage = signal<RequestsPage | null>(null);
    readonly requestsLoading = signal(false);
    readonly requestsLoadingMore = signal(false);
    readonly requestsMoreError = signal('');
    readonly requestsError = signal('');
    readonly requestStatus = signal<RequestStatus>('ALL_REQUESTS');
    readonly pageSize = 20;
    readonly requestRowHeight = 128;
    readonly trackRequest = (_index: number, ticket: DeskRequest) => ticket.issueId;

    readonly requestStatusOptions = [
        { label: 'Все обращения', value: 'ALL_REQUESTS' },
        { label: 'Открытые', value: 'OPEN_REQUESTS' },
        { label: 'Закрытые', value: 'CLOSED_REQUESTS' },
    ];
    readonly requestTypes = REQUEST_TYPES;
    readonly requestTypeOptions = REQUEST_TYPES.map(({ id, name }) => ({ id, name }));
    readonly session = signal<Session | null>(null);
    readonly busy = signal(false);
    readonly loading = signal(true);
    readonly fieldsLoading = signal(false);
    readonly error = signal('');
    readonly fieldsError = signal('');
    readonly selectedType = signal('10001');
    readonly fields = signal<RequestField[]>([]);
    readonly request = signal<DeskRequest | null>(null);
    readonly closeTransition = signal<RequestTransition | null>(null);
    readonly transitionsError = signal('');
    readonly closing = signal(false);
    readonly comments = signal<RequestComment[]>([]);
    readonly commentsError = signal('');
    readonly commentsLoading = signal(false);
    readonly created = signal(false);
    readonly form = new FormRecord<FormControl<string>>({});
    readonly settingsOpen = signal(false);
    readonly settingsBusy = signal(false);
    readonly settingsLoaded = signal(false);
    readonly settingsError = signal('');
    readonly settingsSaved = signal(false);
    readonly settingsRestartRequired = signal(false);
    readonly settingsForm = new FormGroup({
        json: new FormControl('', { nonNullable: true }),
    });
    readonly commentForm = new FormGroup({
        body: new FormControl('', {
            nonNullable: true,
            validators: [Validators.required, Validators.maxLength(10000)],
        }),
    });

    ngOnInit(): void {
        this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
            void this.initialize();
        });
    }

    async initialize(): Promise<void> {
        this.loading.set(true);
        this.error.set('');
        try {
            await this.auth.initialize();
            this.session.set({
                authenticated: this.auth.authenticated,
                user: { username: this.auth.username, displayName: this.auth.displayName },
            });
            if (this.session()?.authenticated) await this.loadView();
        } catch (error: unknown) {
            this.error.set(errorMessage(error));
        } finally {
            this.loading.set(false);
        }
    }

    async logout(): Promise<void> {
        if (this.busy()) return;
        this.busy.set(true);
        this.error.set('');
        try {
            await this.auth.logout();
            this.session.set({ authenticated: false });
            this.request.set(null);
            this.comments.set([]);
            this.created.set(false);
        } catch (error: unknown) {
            this.error.set(errorMessage(error));
        } finally {
            this.busy.set(false);
        }
    }

    async loadRequests(): Promise<void> {
        const generation = ++this.listLoad;
        this.requestsLoading.set(true);
        this.requestsLoadingMore.set(false);
        this.requestsError.set('');
        this.requestsMoreError.set('');
        this.requestsPage.set(null);
        this.nextRequestStart = 0;
        this.lastRequestIndex = 0;
        this.visibleRequestRows = 1;
        this.requestsViewport = undefined;
        try {
            const page = await this.api.listRequests(this.requestStatus(), 0, this.pageSize);
            if (generation === this.listLoad) {
                this.nextRequestStart = page.start + page.limit;
                this.requestsPage.set(page);
            }
        } catch (error: unknown) {
            if (generation === this.listLoad) this.requestsError.set(errorMessage(error));
        } finally {
            if (generation === this.listLoad) this.requestsLoading.set(false);
        }
    }

    async filterRequests(status: RequestStatus): Promise<void> {
        if (!this.requestStatusOptions.some((option) => option.value === status)) return;
        this.requestStatus.set(status);
        await this.loadRequests();
    }

    onRequestsScroll(index: number, viewport: UiVirtualScrollViewport): void {
        this.requestsViewport = viewport;
        this.lastRequestIndex = index;
        this.visibleRequestRows = Math.max(1, Math.ceil(viewport.getViewportSize() / this.requestRowHeight));
        this.loadMoreIfNearEnd();
    }

    private loadMoreIfNearEnd(): void {
        const page = this.requestsPage();
        if (
            page &&
            !page.isLastPage &&
            !this.requestsMoreError() &&
            this.lastRequestIndex + this.visibleRequestRows + 5 >= page.values.length
        )
            void this.loadMoreRequests();
    }

    async loadMoreRequests(): Promise<void> {
        const current = this.requestsPage();
        if (
            !current ||
            current.isLastPage ||
            this.requestsLoading() ||
            this.requestsLoadingMore() ||
            this.view() !== 'list'
        )
            return;
        const generation = this.listLoad;
        const start = this.nextRequestStart;
        this.requestsLoadingMore.set(true);
        this.requestsMoreError.set('');
        try {
            const page = await this.api.listRequests(this.requestStatus(), start, this.pageSize);
            if (generation !== this.listLoad || this.destroyRef.destroyed) return;
            if ((!page.values.length && !page.isLastPage) || page.start !== start || page.limit < 1)
                throw new Error('Invalid continuation page');
            this.nextRequestStart = page.start + page.limit;
            const values = [
                ...new Map([...current.values, ...page.values].map((ticket) => [ticket.issueId, ticket])).values(),
            ];
            this.requestsPage.set({
                ...page,
                start: 0,
                size: values.length,
                values,
                _links: { self: current._links.self, ...(page._links.next ? { next: page._links.next } : {}) },
            });
        } catch (error: unknown) {
            if (generation === this.listLoad) this.requestsMoreError.set(errorMessage(error));
        } finally {
            if (generation === this.listLoad) {
                this.requestsLoadingMore.set(false);
                // The optional feedback row changes the available viewport height.
                window.requestAnimationFrame(() => {
                    const viewport = this.requestsViewport;
                    if (generation !== this.listLoad || this.destroyRef.destroyed || !viewport) return;
                    viewport.checkViewportSize();
                    this.visibleRequestRows = Math.max(
                        1,
                        Math.ceil(viewport.getViewportSize() / this.requestRowHeight)
                    );
                    this.loadMoreIfNearEnd();
                });
            }
        }
    }

    async newRequest(): Promise<void> {
        this.settingsOpen.set(false);
        await this.router.navigate(['/']);
    }

    statusSeverity(status: string): 'success' | 'warn' | 'info' | 'secondary' {
        if (['Закрыта', 'Решена', 'Выполнена'].includes(status)) return 'success';
        if (['Отложена', 'Уточнение', 'Проверка'].includes(status)) return 'warn';
        if (status === 'Ожидает выполнения') return 'secondary';
        return 'info';
    }

    requestTitle(ticket: DeskRequest): string {
        const summary = ticket.requestFieldValues.find((field) => field.fieldId === 'summary')?.value;
        return typeof summary === 'string' && summary ? summary : this.typeName(ticket.requestTypeId);
    }

    async openSettings(): Promise<void> {
        if (!this.auth.canConfigure) return;
        this.settingsOpen.set(true);
        this.settingsError.set('');
        this.settingsSaved.set(false);
        this.settingsRestartRequired.set(false);
        this.settingsBusy.set(true);
        try {
            const settings = await this.api.settings();
            this.settingsForm.setValue({ json: JSON.stringify(settings, null, 4) });
            this.settingsLoaded.set(true);
        } catch (error: unknown) {
            this.settingsLoaded.set(false);
            this.settingsError.set(errorMessage(error));
        } finally {
            this.settingsBusy.set(false);
        }
    }

    async saveSettings(): Promise<void> {
        if (!this.auth.canConfigure || !this.settingsLoaded() || this.settingsBusy()) return;
        this.settingsError.set('');
        this.settingsSaved.set(false);
        this.settingsRestartRequired.set(false);
        let document: SettingsDocument;
        try {
            const parsed: unknown = JSON.parse(this.settingsForm.controls.json.value);
            if (
                !parsed ||
                typeof parsed !== 'object' ||
                Array.isArray(parsed) ||
                !('revision' in parsed) ||
                typeof parsed.revision !== 'number'
            ) {
                this.settingsError.set(
                    'В настройках нет номера версии revision. Обновите настройки и внесите изменения заново.'
                );
                return;
            }
            document = parsed as SettingsDocument;
        } catch {
            this.settingsError.set('Не удалось прочитать JSON. Проверьте кавычки, запятые и скобки.');
            return;
        }
        this.settingsBusy.set(true);
        try {
            const saved = await this.api.saveSettings(document);
            this.settingsForm.setValue({ json: JSON.stringify(saved.document, null, 4) });
            this.settingsRestartRequired.set(saved.restartRequired);
            this.settingsSaved.set(true);
        } catch (error: unknown) {
            this.settingsError.set(errorMessage(error));
        } finally {
            this.settingsBusy.set(false);
        }
    }

    async selectType(typeId: string): Promise<void> {
        if (this.busy()) return;
        this.selectedType.set(typeId);
        this.created.set(false);
        await this.loadFields();
    }

    async loadFields(): Promise<void> {
        const generation = ++this.fieldLoad;
        this.fieldsLoading.set(true);
        this.fieldsError.set('');
        this.fields.set([]);
        for (const key of Object.keys(this.form.controls)) this.form.removeControl(key);
        try {
            const result = await this.api.fields(this.selectedType());
            if (generation !== this.fieldLoad) return;
            const fields = result.requestTypeFields.filter(
                (field) => field.fieldId !== 'attachment' && field.jiraSchema?.type !== 'array'
            );
            for (const field of fields) {
                const validators = field.required ? [Validators.required] : [];
                this.form.addControl(field.fieldId, new FormControl('', { nonNullable: true, validators }));
            }
            this.fields.set(fields);
        } catch (error: unknown) {
            if (generation === this.fieldLoad) this.fieldsError.set(errorMessage(error));
        } finally {
            if (generation === this.fieldLoad) this.fieldsLoading.set(false);
        }
    }

    async submit(): Promise<void> {
        this.form.markAllAsTouched();
        if (this.form.invalid || this.busy() || this.fieldsLoading() || !this.fields().length) return;
        this.busy.set(true);
        this.error.set('');
        try {
            const values: Record<string, unknown> = {};
            for (const field of this.fields()) {
                const value = this.form.controls[field.fieldId]?.value.trim();
                if (value) values[field.fieldId] = field.validValues?.length ? { id: value } : value;
            }
            const request = await this.api.create(this.selectedType(), values);
            this.request.set(request);
            this.created.set(true);
            await this.router.navigate(['/requests', request.issueKey], { state: { requestCreated: true } });
        } catch (error: unknown) {
            this.error.set(errorMessage(error));
        } finally {
            this.busy.set(false);
        }
    }

    async refreshRequest(): Promise<void> {
        const key = this.route.snapshot.paramMap.get('key');
        if (!key) return;
        const generation = ++this.cardLoad;
        this.transitionKey = null;
        this.closeTransition.set(null);
        this.transitionsError.set('');
        this.error.set('');
        try {
            const request = await this.api.request(key);
            if (!this.isCurrentCard(key, generation)) return;
            this.request.set(request);
            this.comments.set([]);
            await Promise.all([this.loadComments(key, generation), this.loadTransitions(key, generation)]);
        } catch (error: unknown) {
            if (this.isCurrentCard(key, generation)) this.error.set(errorMessage(error));
        }
    }

    assigneeLabel(user: RequestAssignee | null | undefined): string {
        if (!user) return 'Не назначен';
        return user.displayName && user.displayName !== user.name ? `${user.displayName} (${user.name})` : user.name;
    }

    async closeRequest(): Promise<void> {
        const ticket = this.request();
        const transition = this.closeTransition();
        if (!ticket || !transition || this.busy() || this.transitionKey !== ticket.issueKey) return;
        const input: TransitionInput = { transition: { id: transition.id } };
        const resolution = transition.fields?.resolution;
        const allowedResolution = resolution?.allowedValues?.[0];
        if (resolution?.required && !allowedResolution) return;
        if (allowedResolution) input.fields = { resolution: { id: allowedResolution.id } };
        this.busy.set(true);
        this.closing.set(true);
        this.error.set('');
        try {
            await this.api.performTransition(ticket.issueKey, input);
            if (this.route.snapshot.paramMap.get('key') !== ticket.issueKey) return;
            this.created.set(false);
            await this.refreshRequest();
        } catch (error: unknown) {
            if (this.route.snapshot.paramMap.get('key') === ticket.issueKey) this.error.set(errorMessage(error));
        } finally {
            this.closing.set(false);
            this.busy.set(false);
        }
    }

    private isCurrentCard(key: string, generation: number): boolean {
        return generation === this.cardLoad && this.route.snapshot.paramMap.get('key') === key;
    }

    private async loadTransitions(key: string, generation: number): Promise<void> {
        try {
            const result = await this.api.transitions(key);
            if (!this.isCurrentCard(key, generation)) return;
            const target = result.transitions.find((transition) => transition.to.statusCategory.key === 'done');
            if (target?.fields?.resolution?.required && !target.fields.resolution.allowedValues?.length) {
                this.transitionsError.set('Не удалось загрузить действие закрытия. Обновите обращение.');
                return;
            }
            this.transitionKey = key;
            this.closeTransition.set(target ?? null);
        } catch (error: unknown) {
            if (this.isCurrentCard(key, generation)) this.transitionsError.set(errorMessage(error));
        }
    }

    async sendComment(): Promise<void> {
        const key = this.request()?.issueKey;
        const body = this.commentForm.controls.body.value.trim();
        this.commentForm.markAllAsTouched();
        if (!key || !body || this.commentForm.invalid || this.busy()) return;
        this.busy.set(true);
        this.commentsError.set('');
        try {
            const comment = await this.api.comment(key, body);
            this.comments.update((comments) => [...comments, comment]);
            this.commentForm.reset();
        } catch (error: unknown) {
            this.commentsError.set(errorMessage(error));
        } finally {
            this.busy.set(false);
        }
    }

    fieldInvalid(id: string): boolean {
        const control = this.form.controls[id];
        return Boolean(control?.invalid && control.touched);
    }

    fieldValue(value: unknown): string {
        if (value === null || value === undefined) return 'Не указано';
        if (typeof value === 'object') {
            if (Array.isArray(value)) return value.map((item: unknown) => this.fieldValue(item)).join(', ');
            const object = value as Record<string, unknown>;
            return String(object['value'] ?? object['label'] ?? object['name'] ?? object['id'] ?? '—');
        }
        return String(value);
    }

    typeName(id: string): string {
        return REQUEST_TYPES.find((type) => type.id === id)?.name ?? 'Обращение в поддержку';
    }

    private async loadView(): Promise<void> {
        this.settingsOpen.set(false);
        if (this.route.snapshot.data['view'] === 'list') {
            this.view.set('list');
            this.request.set(null);
            await this.loadRequests();
        } else if (this.route.snapshot.paramMap.has('key')) {
            this.view.set('request');
            const state = window.history.state as Record<string, unknown> | null;
            this.created.set(state?.['requestCreated'] === true);
            if (state?.['requestCreated']) {
                const next = { ...state };
                delete next['requestCreated'];
                window.history.replaceState(next, '');
            }
            this.request.set(null);
            await this.refreshRequest();
        } else {
            this.view.set('create');
            this.request.set(null);
            this.created.set(false);
            await this.loadFields();
        }
    }

    private async loadComments(key: string, generation: number): Promise<void> {
        this.commentsLoading.set(true);
        this.commentsError.set('');
        try {
            const response = await this.api.comments(key);
            if (this.isCurrentCard(key, generation))
                this.comments.set(response.values.filter((comment) => comment.public));
        } catch (error: unknown) {
            if (this.isCurrentCard(key, generation)) this.commentsError.set(errorMessage(error));
        } finally {
            if (this.isCurrentCard(key, generation)) this.commentsLoading.set(false);
        }
    }
}
