export enum InAppEvents {
    MessageOpened = 'in-app:message-opened',
    MessageDismissed =  'in-app:message-dismissed',
    MessageError = 'in-app:message-error',
    MessageAction = 'in-app:message-action',
}

export enum InboxEvents {
    MessageOpened = 'in-app-inbox:message-opened',
    MessageDismissed = 'in-app-inbox:message-dismissed',
    MessageAction = 'in-app-inbox:message-action',
}

export const allEvents:string[] = [...Object.values(InAppEvents), ...Object.values(InboxEvents)];

export enum JourneysEvents {
    Metric = 'Report Delivery Event',
    Content = 'Report Content Event',
    Opened = 'opened',
    Clicked = 'clicked',
    ViewedContent = 'viewed_content',
    ClickedContent = 'clicked_content',
    DismissedContent = 'dismissed_content'
}

export const ContentType = 'in_app_content'

export function newEvent(type:string, detail:any): CustomEvent {
    return new CustomEvent(type, { detail })
}
