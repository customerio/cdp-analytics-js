import { Analytics } from '../../core/analytics'
import { JourneysEvents } from './events'

const CIO_TOPIC_PREFIX = '_cio'

// Inbox topics are stored as `cio_inbox_<inbox_id>`, so the inbox id is derived
// from the message's topic rather than carried as a separate field.
const INBOX_TOPIC_PREFIX = 'cio_inbox_'

export function deriveInboxId(topics?: string[]): string | undefined {
  const topic = topics?.find((t) => t.startsWith(INBOX_TOPIC_PREFIX))
  return topic ? topic.slice(INBOX_TOPIC_PREFIX.length) : undefined
}

// Single definition of an inbox delivery-metric payload, shared by the gist
// event handlers and the headless inbox API's trackClick. Inbox-specific (adds
// message_id/inbox_id) — distinct from the in-app delivery metrics in index.ts.
export function trackInboxMetric(
  analyticsInstance: Analytics,
  message: GistInboxMessage,
  metric: JourneysEvents,
  extra?: Record<string, unknown>
): void {
  if (!message?.deliveryId) {
    return
  }
  void analyticsInstance.track(JourneysEvents.Metric, {
    deliveryId: message.deliveryId,
    metric,
    message_id: message.messageId ?? message.queueId,
    inbox_id: deriveInboxId(message.topics),
    ...extra,
  })
}

export interface GistInboxMessage {
  messageType: string
  expiry: string
  priority: number
  topics?: string[]
  type: string
  properties: { [key: string]: any }
  messageId?: string
  queueId: string
  userToken: string
  deliveryId: string
  sentAt: string
  opened: boolean
}

export type InboxActionBehavior = 'openUrl' | 'dismiss' | 'openDeeplink' | 'performAction'

export interface InboxActionConfig {
  behavior: InboxActionBehavior
  action?: string
  name?: string
  dismiss?: boolean
  newTab?: boolean
}

export interface InboxMessageActionParams {
  message: GistInboxMessage
  action: 'opened' | 'dismissed' | 'clicked' | 'unopened'
  actionConfig?: InboxActionConfig
}

export interface InboxMessage {
  // Unique identifier for this messeage
  readonly messageId: string

  // If the message has been marked opened
  readonly opened: boolean

  // The properties payload of the message
  readonly properties: { [key: string]: any }

  // When the message was sent
  readonly sentAt: Date

  // When the message expires
  readonly expiresAt?: Date

  // Optional message type
  readonly type: string

  // Optional list of topics this message belongs to
  readonly topics: string[]

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
    sentAt: new Date(gistMessage.sentAt),
    expiresAt: gistMessage.expiry ? new Date(gistMessage.expiry) : undefined,
    messageId: gistMessage.queueId,
    opened: gistMessage?.opened === true,
    properties: gistMessage.properties,
    type: gistMessage.type || '',
    topics: gistMessage.topics || [],
    trackClick: (trackedResponse?: string) => {
      trackInboxMetric(analyticsInstance, gistMessage, JourneysEvents.Clicked, {
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

  allMessages = allMessages.slice().sort((a, b) => {
    return new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime()
  })

  if (topics.length === 0) {
    return allMessages.filter((message) => {
      const messageTopics = message.topics
      if (!messageTopics || messageTopics.length === 0) {
        return true
      }
      return !messageTopics.some((topic) => topic.startsWith(CIO_TOPIC_PREFIX))
    })
  }

  const hasCioTopic = topics.some((topic) => topic.startsWith(CIO_TOPIC_PREFIX))

  return allMessages.filter((message) => {
    const messageTopics = message.topics
    if (!messageTopics || messageTopics.length === 0) {
      return false
    }
    if (!hasCioTopic && messageTopics.some((topic) => topic.startsWith(CIO_TOPIC_PREFIX))) {
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
