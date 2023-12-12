export enum InAppEvents {
    MessageOpened = 'in-app:message-opened',
    MessageDismissed =  'in-app:message-dismissed',
    MessageError = 'in-app:message-error',
    MessageAction = 'in-app:message-action'
}

export const allEvents:string[] = [InAppEvents.MessageOpened, InAppEvents.MessageDismissed, InAppEvents.MessageError, InAppEvents.MessageAction];

export enum semanticEvents {
    JourneyMetric = 'Journey Delivery Metric',
    Opened = 'opened',
    Clicked = 'clicked',
}

export function newEvent(type:string, detail:any): CustomEvent {
    return new CustomEvent(type, { detail })
}

export function gistToCIO(gistEvent:string): string {
    switch (gistEvent) {
        case 'messageShown':
            return InAppEvents.MessageOpened;
        case 'messageDismissed':
            return InAppEvents.MessageDismissed;
        case 'messageError':
            return InAppEvents.MessageError;
        case 'messageAction':
            return InAppEvents.MessageAction;
        default:
            return "";
    }
}