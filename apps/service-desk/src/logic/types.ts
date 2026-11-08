export type Role = 'customer' | 'support' | 'admin';

export interface Principal {
    teamId: string;
    username: string;
    role: Role;
}

export class DomainError extends Error {
    constructor(
        public statusCode: number,
        message: string,
        public errors: Record<string, string> = {}
    ) {
        super(message);
    }
}

export interface CreateRequest {
    serviceDeskId: string;
    requestTypeId: string;
    requestFieldValues: Record<string, unknown>;
    requestParticipants?: string[];
    raiseOnBehalfOf?: string;
}

export interface PageInput {
    start: number;
    limit: number;
}

/** Current eligibility comes from Identity, independently of prior Service Desk logins. */
export interface EligibleAssignee {
    username: string;
    displayName: string;
}

export interface AssigneeDirectory {
    getDefaultAssignee(teamSlug: string): Promise<EligibleAssignee>;
    listEligible(teamSlug: string): Promise<EligibleAssignee[]>;
    findEligible(teamSlug: string, username: string): Promise<EligibleAssignee | null>;
}
