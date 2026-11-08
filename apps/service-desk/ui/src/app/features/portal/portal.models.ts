export interface Session {
    authenticated: boolean;
    user?: { username: string; displayName?: string };
}

export interface RequestField {
    fieldId: string;
    name: string;
    description?: string;
    required: boolean;
    validValues?: { value: string; label: string }[];
    jiraSchema?: { type: string; system?: string; items?: string };
}

export interface RequestFields {
    requestTypeFields: RequestField[];
}

export interface RequestAssignee {
    name: string;
    key: string;
    displayName: string;
    active: boolean;
}

export interface DeskRequest {
    issueId: string;
    issueKey: string;
    requestTypeId: string;
    serviceDeskId: string;
    currentStatus: { status: string; statusDate?: { iso8601: string } };
    createdDate?: { iso8601: string };
    reporter?: { displayName?: string; name?: string };
    assignee?: RequestAssignee | null;
    requestFieldValues: { fieldId: string; label: string; value: unknown }[];
}

export type RequestStatus = 'ALL_REQUESTS' | 'OPEN_REQUESTS' | 'CLOSED_REQUESTS';

export interface RequestsPage {
    size: number;
    start: number;
    limit: number;
    isLastPage: boolean;
    values: DeskRequest[];
    _links: { self: string; next?: string };
}

export interface RequestComment {
    id: string;
    body: string;
    public: boolean;
    author?: { displayName?: string; name?: string };
    created?: { iso8601: string };
}

export const REQUEST_TYPES = [
    {
        id: '10001',
        name: 'Замена оборудования',
        description: 'Заменить неисправное или устаревшее устройство',
        icon: '↔',
    },
    {
        id: '194',
        name: 'Не удаётся войти',
        description: 'Ошибка входа в рабочую учётную запись',
        icon: '↗',
    },
    { id: '183', name: 'Компьютер не включается', description: 'Компьютер не включается или не отвечает', icon: '▣' },
] as const;

export interface RequestTransition {
    id: string;
    name: string;
    to: { id: string; name: string; statusCategory: { key: string } };
    fields?: {
        resolution?: { required: boolean; allowedValues?: { id: string; name: string }[] };
    };
}

export interface TransitionInput {
    transition: { id: string };
    fields?: { resolution: { id: string } };
}
