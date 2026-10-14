import type { Context } from '../../core/context'
import { isDeviceEvent } from './device-delivery'

type Tombstone = { timestamp: number; deletes: string[]; cancelled: string[] }

// Keep this outside event payloads. A persisted retry must remain cancelled even
// if another analytics instance (or an old pagehide listener) saves it again.
export function deviceSupersession() {
  const memory = new Map<string, Tombstone>()
  const key = (endpoint: string) => `cio-webpush:deleted:${endpoint}`
  const endpoint = (ctx: Context): string | undefined =>
    isDeviceEvent(ctx) ? ctx.event.context?.device?.token : undefined
  const timestamp = (ctx: Context) =>
    new Date(ctx.event.timestamp as string).getTime()
  const read = (token: string): Tombstone | undefined => {
    try {
      const saved = localStorage.getItem(key(token))
      if (saved) return JSON.parse(saved) as Tombstone
    } catch {
      // Persistence is optional in private browsing.
    }
    return memory.get(token)
  }
  const stale = (ctx: Context): boolean => {
    const token = endpoint(ctx)
    if (!token || ctx.event.event !== 'Device Created or Updated') return false
    const deleted = read(token)
    return (
      !!deleted &&
      (timestamp(ctx) < deleted.timestamp || deleted.cancelled.includes(ctx.id))
    )
  }
  const supersede = (
    ctx: Context,
    cancel: (predicate: (item: Context) => boolean) => Context[]
  ): void => {
    const token = endpoint(ctx)
    if (!token || ctx.event.event !== 'Device Deleted') return
    const time = timestamp(ctx)
    const previous = read(token)
    // Retrying an old delete must not cancel a subsequent registration.
    if (
      previous &&
      (time < previous.timestamp || previous.deletes.includes(ctx.id))
    )
      return
    const removed = cancel(
      (item) =>
        endpoint(item) === token &&
        item.event.event === 'Device Created or Updated' &&
        timestamp(item) <= time
    )
    const tied = previous?.timestamp === time ? previous : undefined
    const deleted: Tombstone = {
      timestamp: time,
      deletes: [...(tied?.deletes ?? []), ctx.id],
      cancelled: [
        ...(tied?.cancelled ?? []),
        ...removed.map((item) => item.id),
      ],
    }
    memory.set(token, deleted)
    try {
      localStorage.setItem(key(token), JSON.stringify(deleted))
    } catch {
      // The current page still cancels retries when storage is unavailable.
    }
  }
  return { stale, supersede }
}
