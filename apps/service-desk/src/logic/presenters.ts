import type { Issue } from '../dal/schema';
import { requestFields, requestType, statuses } from './catalog';

export function dateDto(date: Date) {
    return {
        iso8601: date.toISOString(),
        jira: date.toISOString(),
        friendly: date.toISOString(),
        epochMillis: date.getTime(),
    };
}

export function userDto(username: string, displayName = username) {
    return { name: username, key: username, displayName, active: true };
}

export function issueKey(id: number) {
    return `HELP-${id}`;
}

export function requestDto(issue: Issue, baseUrl: string) {
    return {
        _expands: [],
        issueId: String(issue.id),
        issueKey: issueKey(issue.id),
        requestTypeId: issue.requestTypeId,
        serviceDeskId: '3',
        createdDate: dateDto(issue.createdAt),
        reporter: userDto(issue.reporter),
        // Optional teaching extension: persisted assignment snapshot, not a current eligibility assertion.
        assignee: issue.assignee
            ? { name: issue.assignee, key: issue.assignee, displayName: issue.assigneeDisplayName ?? issue.assignee }
            : null,
        requestFieldValues: Object.entries(issue.fields).map(([fieldId, value]) => ({
            fieldId,
            value,
            label:
                requestFields(issue.requestTypeId).find((field) => field.fieldId === fieldId)?.name ??
                (fieldId === 'summary' ? 'Тема' : fieldId),
        })),
        currentStatus: { status: statuses[issue.status].name, statusDate: dateDto(issue.updatedAt) },
        _links: {
            self: `${baseUrl}/rest/servicedeskapi/request/${issueKey(issue.id)}`,
            web: `${baseUrl}/requests/${issueKey(issue.id)}`,
        },
    };
}

export function issueDto(issue: Issue, baseUrl: string) {
    const status = statuses[issue.status];
    return {
        id: String(issue.id),
        key: issueKey(issue.id),
        fields: {
            ...issue.fields,
            summary: issue.summary,
            description: issue.description,
            project: { id: '10504', key: 'HELP', name: 'Служба поддержки' },
            issuetype: { id: 'training-pc', name: 'Обращение в поддержку' },
            status: {
                id: issue.status,
                name: status.name,
                statusCategory: { key: status.category, name: status.category },
            },
            reporter: userDto(issue.reporter),
            assignee: issue.assignee ? userDto(issue.assignee, issue.assigneeDisplayName ?? issue.assignee) : null,
            priority: { id: '3', name: 'Обычный' },
            resolution: issue.resolution ? { id: '10100', name: issue.resolution } : null,
            created: issue.createdAt.toISOString(),
            updated: issue.updatedAt.toISOString(),
            customfield_10201: {
                requestType: requestType(issue.requestTypeId),
                currentStatus: requestDto(issue, baseUrl).currentStatus,
            },
        },
    };
}

export function pageDto<T>(values: T[], start: number, limit: number, total: number, url: string) {
    return {
        size: values.length,
        start,
        limit,
        isLastPage: start + values.length >= total,
        values,
        _links: {
            self: `${url}?start=${start}&limit=${limit}`,
            ...(start + values.length < total ? { next: `${url}?start=${start + limit}&limit=${limit}` } : {}),
        },
    };
}
