import { Analytics } from '../../core/analytics'
import { JourneysEvents } from './events'

export interface GistInboxMessage {
  messageType: string
  expiry: string
  priority: number
  topics?: string[]
  properties: { [key: string]: any }
  queueId: string
  userToken: string
  deliveryId: string
  sentAt: string
  opened: boolean
}

export interface InboxMessage {
  // Unique identifier for this messeage
  readonly messageId: string

  // If the message has been marked opened
  readonly opened: boolean

  // The properties payload of the message
  readonly properties: { [key: string]: any }

  // When the message was sent
  readonly sentAt: string

  /**
   * Tracks a click metric for the message with an optional tracked response value.
   * @returns void
   */
  trackClick(trackedResponse?: string): void

  /**
   * Marks this message as opened
   * @returns Promise that resolves when the message is marked as opened
   */
  markOpened(): Promise<void>

  /**
   * Marks this message as unopened
   * @returns Promise that resolves when the message is marked as unopened
   */
  markUnopened(): Promise<void>

  /**
   * Marks this message as deleted
   * @returns Promise that resolves when the message is deleted
   */
  markDeleted(): Promise<void>
}

export interface InboxAPI {
  /**
   * Returns the total number of messages
   * @returns Promise that resolves to the total count of messages
   */
  total(): Promise<number>

  /**
   * Returns the count of unopened messages
   * @returns Promise that resolves to the count of unopened messages
   */
  totalUnopened(): Promise<number>

  /**
   * Returns all inbox messages
   * @returns Promise that resolves to an array of inbox messages
   */
  messages(): Promise<InboxMessage[]>

  /**
   * Subscribe to inbox message updates
   * @param callback - Function called with array of InboxMessage objects when the message list changes.
   * @returns Unsubscribe function to remove the listener
   */
  onUpdates(callback: (messages: InboxMessage[]) => void): () => void
}

function createInboxMessage(
  analyticsInstance: Analytics,
  gist: any,
  gistMessage: GistInboxMessage
): InboxMessage {
  return {
    sentAt: gistMessage.sentAt,
    messageId: gistMessage.queueId,
    opened: gistMessage?.opened === true,
    properties: gistMessage.properties,
    trackClick: (trackedResponse?: string) => {
      void analyticsInstance.track(JourneysEvents.Metric, {
        deliveryId: gistMessage.deliveryId,
        metric: JourneysEvents.Clicked,
        actionName: trackedResponse,
      })
    },
    markOpened: async () => {
      await gist.updateInboxMessageOpenState(gistMessage.queueId, true)
    },
    markUnopened: async () => {
      await gist.updateInboxMessageOpenState(gistMessage.queueId, false)
    },
    markDeleted: async () => {
      await gist.removeInboxMessage(gistMessage.queueId)
    },
  }
}

async function getFilteredMessages(
  gist: any,
  topics: string[],
  messages: GistInboxMessage[] | null
): Promise<GistInboxMessage[]> {
  let allMessages = messages
  if (!allMessages || !Array.isArray(allMessages)) {
    allMessages = (await gist.getInboxMessages()) as GistInboxMessage[]
  }

  if (!allMessages || !Array.isArray(allMessages)) {
    return []
  }

  if (topics.length === 0) {
    return allMessages
  }

  return allMessages.filter((message) => {
    const messageTopics = message.topics
    if (!messageTopics || messageTopics.length === 0) {
      return false
    }
    return messageTopics.some((messageTopic) => topics.includes(messageTopic))
  })
}

export function createInboxAPI(analyticsInstance: Analytics, gist: any, topics: string[]): InboxAPI {
  return {
    total: async () => {
      const messages = await getFilteredMessages(gist, topics, null)
      return messages.length
    },
    totalUnopened: async () => {
      const messages = await getFilteredMessages(gist, topics, null)
      return messages.filter((message) => {
        return message?.opened !== true
      }).length
    },
    messages: async (): Promise<InboxMessage[]> => {
      const messages = await getFilteredMessages(gist, topics, null)
      return messages.map((msg) => createInboxMessage(analyticsInstance, gist, msg))
    },
    onUpdates: (callback: (messages: InboxMessage[]) => void): (() => void) => {
      const handler = async (gistMessages: GistInboxMessage[]) => {
        try {
          const filteredMessages = await getFilteredMessages(
            gist,
            topics,
            gistMessages
          )
          const inboxMessages = filteredMessages.map((msg) =>
            createInboxMessage(analyticsInstance, gist, msg)
          )

          callback(inboxMessages)
        } catch (error) {
          console.error('Error processing inbox updates:', error)
        }
      }

      gist.events.on('messageInboxUpdated', handler)

      // Return unsubscribe function
      return () => {
        gist.events.off('messageInboxUpdated', handler)
      }
    },
  }
}
