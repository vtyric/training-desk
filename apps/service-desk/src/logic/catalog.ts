import { DomainError } from './types';

export const statuses: Record<string, { name: string; category: string }> = {
    '10005': { name: 'Новая', category: 'new' },
    '10006': { name: 'Ожидает выполнения', category: 'indeterminate' },
    '10007': { name: 'Уточнение', category: 'indeterminate' },
    '10008': { name: 'В работе', category: 'indeterminate' },
    '10009': { name: 'Отложена', category: 'indeterminate' },
    '10010': { name: 'Проверка', category: 'indeterminate' },
    '10011': { name: 'Закрыта', category: 'done' },
};

export const transitionTargets: Record<string, string[]> = {
    '10005': ['10006'],
    '10006': ['10007', '10008', '10009'],
    '10007': ['10006'],
    '10008': ['10006', '10007', '10010'],
    '10009': ['10006'],
    '10010': ['10008', '10011'],
    '10011': [],
};

const unitValues = [
    { value: '13200', label: 'Abanking Classic' },
    { value: '13201', label: 'Reconnect' },
    { value: '13202', label: 'Artsofte digital' },
    { value: '13203', label: 'DigitalDeveloper' },
    { value: '13204', label: 'Nocode' },
    { value: '13205', label: 'Nopaper' },
    { value: '13206', label: 'Profitbase' },
    { value: '13207', label: 'TradeDealer' },
    { value: '13209', label: 'Invest' },
    { value: '13210', label: 'Artsofte Consulting' },
    { value: '13211', label: 'CoreTeamManufacture' },
    { value: '13212', label: 'CoreTeamBackoffice' },
    { value: '13213', label: 'CoreTeamBizdev' },
];
const pcUnitValues = [
    { value: '12617', label: 'Abanking Classic' },
    { value: '12626', label: 'Artsofte Consulting' },
    { value: '12624', label: 'Adigital' },
    { value: '12630', label: 'AiSales' },
    { value: '12622', label: 'CT-Manufacture' },
    { value: '12634', label: 'DigitalDeveloper' },
    { value: '12629', label: 'NOCODE' },
    { value: '12625', label: 'Nopaper' },
    { value: '12620', label: 'ProfitBase' },
    { value: '14113', label: 'CT-BizDev' },
    { value: '12621', label: 'TradeDealer' },
    { value: '12618', label: 'CT-Backoffice-HR' },
    { value: '12623', label: 'CT-Backoffice-IT' },
    { value: '12619', label: 'CT-Backoffice-ЮО' },
    { value: '12627', label: 'CT-Backoffice-ФД' },
    { value: '14052', label: 'CT-Backoffice-Operation' },
];

export interface RequestField {
    fieldId: string;
    name: string;
    description: string;
    required: boolean;
    validValues: { value: string; label: string; children: never[] }[];
    jiraSchema: { type: string; system?: string; custom?: string; customId?: number; items?: string };
}

function field(
    fieldId: string,
    name: string,
    required: boolean,
    type = 'string',
    values: { value: string; label: string }[] = []
): RequestField {
    const customId = fieldId.startsWith('customfield_') ? Number(fieldId.slice(12)) : undefined;
    return {
        fieldId,
        name,
        description: name,
        required,
        validValues: values.map((value) => ({ ...value, children: [] })),
        jiraSchema: customId
            ? {
                  type,
                  customId,
                  custom: `com.atlassian.jira.plugin.system.customfieldtypes:${type === 'option' ? 'select' : 'textfield'}`,
              }
            : { type, system: fieldId },
    };
}

export const requestTypeIds = ['10001', '183', '194'] as const;

export function requestType(id: string) {
    if (!(requestTypeIds as readonly string[]).includes(id)) throw new DomainError(404, 'Тип обращения не найден');
    return {
        id,
        serviceDeskId: '3',
        issueTypeId: 'training-pc',
        name: id === '10001' ? 'Замена оборудования' : id === '194' ? 'Не удаётся войти' : 'Компьютер не включается',
        description:
            id === '10001'
                ? 'Замена неисправного или устаревшего оборудования'
                : id === '194'
                  ? 'Не удаётся войти в компьютер'
                  : 'Компьютер не включается и не реагирует на кнопку питания',
        helpText: '',
        groupIds: ['62'],
    };
}

export function requestFields(id: string): RequestField[] {
    requestType(id);
    if (id === '10001')
        return [
            field('customfield_12900', 'Название устройства', true),
            field('customfield_20001', 'Что нужно заменить?', true, 'option', [
                { value: '20001', label: 'ПК' },
                { value: '20002', label: 'Ноутбук' },
                { value: '20003', label: 'Монитор' },
                { value: '20004', label: 'Периферия для ПК' },
                { value: '20005', label: 'Другое' },
            ]),
            field('customfield_20002', 'Причина замены', true, 'option', [
                { value: '20101', label: 'Поломка' },
                { value: '20102', label: 'Устаревшее оборудование' },
                { value: '20103', label: 'Другая причина' },
            ]),
            field('description', 'Описание', true),
        ];
    return [
        field('customfield_12900', 'Название устройства', id === '183'),
        ...(id === '183'
            ? [
                  field('customfield_12901', 'Горит индикатор питания?', true, 'option', [
                      { value: '12401', label: 'Да' },
                      { value: '12402', label: 'Нет' },
                  ]),
              ]
            : []),
        field('description', 'Описание', true),
        field(
            id === '194' ? 'customfield_10713' : 'customfield_13130',
            'Подразделение',
            id === '183',
            'option',
            id === '194' ? unitValues : pcUnitValues
        ),
    ];
}
