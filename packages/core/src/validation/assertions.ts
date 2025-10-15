import { CoreCustomerioEvent } from '../events'
import { hasUser, isString, isPlainObject } from './helpers'

export class ValidationError extends Error {
  field: string

  constructor(field: string, message: string) {
    super(message)
    this.field = field
  }
}

export function assertMessageId(event: CoreCustomerioEvent): void {
  if (!isString(event.messageId)) {
    throw new ValidationError('.messageId', 'messageId is not a string')
  }
}

export function validateEvent(event?: CoreCustomerioEvent | null) {
  if (!event || typeof event !== 'object') {
    throw new ValidationError('event', 'Event is missing')
  }

  if (!isString(event.type)) {
    throw new ValidationError('type', 'type is not a string')
  }

  assertMessageId(event)

  if (event.type === 'track') {
    if (!isString(event.event)) {
      throw new ValidationError('event', 'Event is not a string')
    }
    if (!isPlainObject(event.properties)) {
      throw new ValidationError('properties', 'properties is not an object')
    }
  }

  if (['group', 'identify'].includes(event.type)) {
    if (!isPlainObject(event.traits)) {
      throw new ValidationError('traits', 'traits is not an object')
    }
  }

  if (!hasUser(event)) {
    throw new ValidationError(
      'userId/anonymousId/previousId/groupId',
      'Must have userId or anonymousId or previousId or groupId'
    )
  }
}
