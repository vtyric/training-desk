import type { Database } from '../dal/database';
import { Repository } from '../dal/repository';
import type { Issue } from '../dal/schema';
import { requestFields, requestType, statuses, transitionTargets } from './catalog';
import { dateDto, issueDto, issueKey, pageDto, requestDto, userDto } from './presenters';
import { DomainError, type AssigneeDirectory, type CreateRequest, type PageInput, type Principal } from './types';

export type RequestListInput = PageInput & {
    requestStatus: 'ALL_REQUESTS' | 'OPEN_REQUESTS' | 'CLOSED_REQUESTS';
};

export class RequestLogic {
    readonly repository: Repository;
    constructor(
        private readonly db: Database,
        private readonly baseUrl: string,
        private readonly directory?: AssigneeDirectory
    ) {
        this.repository = new Repository(db);
    }

    async get(principal: Principal, key: string) {
        const match = /^(?:HELP-)?([1-9]\d*)$/.exec(key);
        if (!match || !Number.isSafeInteger(Number(match[1])))
            throw new DomainError(404, 'Обращение не найдено или недоступно вашей учётной записи');
        const issue = await this.repository.findIssue(principal.teamId, Number(match[1]));
        if (!issue || (principal.role === 'customer' && issue.reporter !== principal.username))
            throw new DomainError(404, 'Обращение не найдено или недоступно вашей учётной записи');
        return issue;
    }

    private requireSupport(principal: Principal) {
        if (principal.role === 'customer')
            throw new DomainError(403, 'Назначать исполнителя могут сотрудники поддержки и администратор');
    }

    private async teamSlug(principal: Principal) {
        const slug = await this.repository.findActiveTeamSlug(principal.teamId);
        if (!slug) throw new DomainError(403, 'Нет доступа к этой службе поддержки. Обратитесь к администратору');
        return slug;
    }

    private async withDirectory<T>(
        read: (directory: AssigneeDirectory) => Promise<T>,
        failureMessage = 'Не удалось загрузить сотрудников поддержки. Повторите попытку позже'
    ): Promise<T> {
        if (!this.directory)
            throw new DomainError(503, 'Каталог сотрудников не подключён. Обратитесь к администратору');
        try {
            return await read(this.directory);
        } catch {
            throw new DomainError(503, failureMessage);
        }
    }

    async assignableUsers(
        principal: Principal,
        input: { username?: string; issueKey?: string; project?: string; maxResults: number }
    ) {
        this.requireSupport(principal);
        if (input.project !== undefined && input.project !== 'HELP')
            throw new DomainError(404, 'Проект не найден или недоступен');
        if (input.issueKey !== undefined) await this.get(principal, input.issueKey);
        const slug = await this.teamSlug(principal);
        const candidates = await this.withDirectory((directory) => directory.listEligible(slug));
        const search = (input.username ?? '').trim().toLowerCase();
        return candidates
            .filter(
                (user) =>
                    user.username.toLowerCase().includes(search) || user.displayName.toLowerCase().includes(search)
            )
            .sort((a, b) => a.username.localeCompare(b.username))
            .slice(0, input.maxResults)
            .map((user) => ({ name: user.username, key: user.username, displayName: user.displayName, active: true }));
    }

    async assign(principal: Principal, key: string, name: string | null) {
        this.requireSupport(principal);
        const issue = await this.get(principal, key);
        if (name === '-1')
            throw new DomainError(
                400,
                'Укажите логин исполнителя или null, чтобы снять назначение. Значение -1 не поддерживается'
            );
        let displayName: string | null = null;
        if (name !== null) {
            const slug = await this.teamSlug(principal);
            const eligible = await this.withDirectory((directory) => directory.findEligible(slug, name));
            if (!eligible || eligible.username !== name)
                throw new DomainError(400, 'Сотрудник недоступен для назначения. Обновите список исполнителей');
            displayName = eligible.displayName;
        }
        if (issue.assignee === name && issue.assigneeDisplayName === displayName) return;
        await this.mutate(principal, issue, { assignee: name, assigneeDisplayName: displayName }, 'assignee', {
            from: issue.assignee,
            to: name,
        });
    }

    async create(principal: Principal, input: CreateRequest) {
        if (input.serviceDeskId !== '3') throw new DomainError(404, 'Служба поддержки не найдена');
        const type = requestType(input.requestTypeId);
        const allowedFields = requestFields(input.requestTypeId);
        if (input.raiseOnBehalfOf || input.requestParticipants?.length)
            throw new DomainError(
                400,
                'Создание от имени другого пользователя и добавление участников не поддерживаются. Уберите raiseOnBehalfOf и requestParticipants'
            );
        const errors: Record<string, string> = {};
        for (const key of Object.keys(input.requestFieldValues)) {
            if (!allowedFields.some((field) => field.fieldId === key))
                errors[key] = 'Это поле недоступно для выбранного типа обращения';
        }
        for (const field of allowedFields) {
            const value = input.requestFieldValues[field.fieldId];
            const empty = value === undefined || value === null || value === '';
            if (field.required && empty) errors[field.fieldId] = 'Заполните это поле';
            if (empty) continue;
            if (field.jiraSchema.type === 'option') {
                const id = typeof value === 'object' && value !== null && 'id' in value ? value.id : undefined;
                if (typeof id !== 'string' || !field.validValues.some((option) => option.value === id))
                    errors[field.fieldId] = 'Выберите значение из списка и передайте его как {id: string}';
            } else if (typeof value !== 'string' || !value.trim() || value.length > 20000) {
                errors[field.fieldId] = 'Введите текст длиной от 1 до 20 000 символов';
            }
        }
        if (Object.keys(errors).length)
            throw new DomainError(400, 'Не удалось создать обращение. Проверьте отмеченные поля', errors);
        const fields = Object.fromEntries(
            Object.entries(input.requestFieldValues).filter(([, value]) => value !== null && value !== '')
        );
        const description = String(fields['description']);
        const summary = type.name;
        const slug = await this.teamSlug(principal);
        const lead = await this.withDirectory(
            (directory) => directory.getDefaultAssignee(slug),
            'Не удалось назначить руководителя поддержки. Администратору нужно проверить, что выбран ровно один активный руководитель'
        );
        return this.db.transaction(async (tx) => {
            const repo = new Repository(tx);
            const issue = await repo.createIssue({
                teamId: principal.teamId,
                requestTypeId: type.id,
                summary,
                description,
                fields: { ...fields, summary },
                reporter: principal.username,
                assignee: lead.username,
                assigneeDisplayName: lead.displayName,
            });
            await repo.addHistory(issue.id, principal.username, 'created', {
                status: '10005',
                assignee: lead.username,
            });
            await repo.addEvent(issue, 'jira:issue_created', {
                timestamp: Date.now(),
                webhookEvent: 'jira:issue_created',
                user: userDto(principal.username),
                issue: issueDto(issue, this.baseUrl),
            });
            return requestDto(issue, this.baseUrl);
        });
    }

    async listRequests(principal: Principal, input: RequestListInput) {
        const status =
            input.requestStatus === 'OPEN_REQUESTS'
                ? 'open'
                : input.requestStatus === 'CLOSED_REQUESTS'
                  ? 'closed'
                  : 'all';
        const result = await this.repository.listRequests(
            principal.teamId,
            principal.role === 'customer' ? principal.username : undefined,
            status,
            input.start,
            input.limit
        );
        const page = pageDto(
            result.rows.map((issue) => requestDto(issue, this.baseUrl)),
            input.start,
            input.limit,
            result.total,
            `${this.baseUrl}/rest/servicedeskapi/request`
        );
        for (const [key, href] of Object.entries(page._links)) {
            if (!href) continue;
            const url = new URL(href);
            url.searchParams.set('requestStatus', input.requestStatus);
            page._links[key as keyof typeof page._links] = url.toString();
        }
        return page;
    }

    async request(principal: Principal, key: string) {
        return requestDto(await this.get(principal, key), this.baseUrl);
    }
    async transitions(principal: Principal, key: string, expandFields: boolean) {
        const issue = await this.get(principal, key);
        const targets =
            principal.role === 'customer'
                ? issue.status === '10011'
                    ? []
                    : ['10011']
                : transitionTargets[issue.status];
        return {
            transitions: targets.map((target) => ({
                id: target,
                name: statuses[target].name,
                to: { id: target, name: statuses[target].name, statusCategory: { key: statuses[target].category } },
                ...(expandFields
                    ? {
                          fields:
                              target === '10011'
                                  ? {
                                        resolution: {
                                            required: true,
                                            name: 'Решение',
                                            schema: { type: 'resolution', system: 'resolution' },
                                            allowedValues: [{ id: '10100', name: 'Готово' }],
                                        },
                                    }
                                  : {},
                      }
                    : {}),
            })),
        };
    }

    async transition(
        principal: Principal,
        key: string,
        input: { transition: { id: string }; fields?: { resolution?: { id: string } } }
    ) {
        const issue = await this.get(principal, key);
        const target = input.transition.id;
        if (principal.role === 'customer') {
            if (target !== '10011') throw new DomainError(403, 'Заявитель может только закрыть собственное обращение');
            if (issue.status === '10011') throw new DomainError(409, 'Обращение уже закрыто. Обновите карточку');
        } else if (!transitionTargets[issue.status].includes(target)) {
            throw new DomainError(400, 'Статус уже изменился или этот переход недоступен. Обновите список переходов');
        }
        if (target === '10011' && input.fields?.resolution?.id !== '10100')
            throw new DomainError(400, 'Для закрытия передайте fields.resolution.id = 10100');
        if (target !== '10011' && input.fields?.resolution)
            throw new DomainError(400, 'Для этого перехода поле resolution не используется. Уберите его из запроса');
        await this.mutate(
            principal,
            issue,
            {
                status: target,
                resolution: target === '10011' ? 'Готово' : null,
                ...(target === '10011' ? { assignee: null, assigneeDisplayName: null } : {}),
            },
            'status',
            { from: issue.status, to: target, ...(target === '10011' ? { previousAssignee: issue.assignee } : {}) }
        );
    }

    async listComments(principal: Principal, key: string, page: PageInput) {
        const issue = await this.get(principal, key);
        const result = await this.repository.listComments(
            issue.id,
            principal.role === 'customer',
            page.start,
            page.limit
        );
        const values = result.rows.map((comment) => ({
            id: String(comment.id),
            body: comment.body,
            public: comment.public,
            author: userDto(comment.author),
            created: dateDto(comment.createdAt),
        }));
        return pageDto(
            values,
            page.start,
            page.limit,
            result.total,
            `${this.baseUrl}/rest/servicedeskapi/request/${issueKey(issue.id)}/comment`
        );
    }

    async comment(principal: Principal, key: string, body: string, isPublic: boolean) {
        if (!body.trim()) throw new DomainError(400, 'Введите сообщение');
        const issue = await this.get(principal, key);
        if (!isPublic && principal.role === 'customer')
            throw new DomainError(403, 'Заявитель может отправлять только публичные сообщения. Укажите public=true');
        return this.db.transaction(async (tx) => {
            const repo = new Repository(tx);
            const updated = await repo.updateIssue(issue, {});
            if (!updated) throw new DomainError(409, 'Обращение изменилось. Обновите карточку и повторите действие');
            const comment = await repo.addComment(issue.id, principal.username, body, isPublic);
            await repo.addHistory(issue.id, principal.username, 'comment', { commentId: comment.id, public: isPublic });
            // Only the issue snapshot is sent: internal comment bodies must not leak through webhooks.
            await repo.addEvent(updated, 'jira:issue_updated', {
                timestamp: Date.now(),
                webhookEvent: 'jira:issue_updated',
                issue: issueDto(updated, this.baseUrl),
            });
            return {
                id: String(comment.id),
                body: comment.body,
                public: comment.public,
                author: userDto(comment.author),
                created: dateDto(comment.createdAt),
            };
        });
    }

    private async mutate(
        principal: Principal,
        issue: Issue,
        changes: Partial<Issue>,
        action: string,
        data: Record<string, unknown>
    ) {
        return this.db.transaction(async (tx) => {
            const repo = new Repository(tx);
            const updated = await repo.updateIssue(issue, changes);
            if (!updated) throw new DomainError(409, 'Обращение изменилось. Обновите карточку и повторите действие');
            await repo.addHistory(issue.id, principal.username, action, data);
            await repo.addEvent(updated, 'jira:issue_updated', {
                timestamp: Date.now(),
                webhookEvent: 'jira:issue_updated',
                user: userDto(principal.username),
                issue: issueDto(updated, this.baseUrl),
            });
        });
    }
}
