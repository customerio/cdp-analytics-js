import type { Context } from '../../core/context'
import { isDeviceEvent } from './device-delivery'

type Order = { timestamp: number; seq?: number }
type Tombstone = Order & { deletes: string[]; cancelled: string[] }

// Keep this outside event payloads. A persisted retry must remain cancelled even
// if another analytics instance (or an old pagehide listener) saves it again.
export function deviceSupersession() {
  const memory = new Map<string, Tombstone>()
  const key = (endpoint: string) => `cio-webpush:deleted:${endpoint}`
  const endpoint = (ctx: Context): string | undefined =>
    isDeviceEvent(ctx) ? ctx.event.context?.device?.token : undefined
  const order = (ctx: Context): Order => ({
    timestamp:
      ctx.event.context?.device?.webpush_event_ms ??
      new Date(ctx.event.timestamp as string).getTime(),
    seq: ctx.event.context?.device?.webpush_seq,
  })
  const compare = (a: Order, b: Order): number =>
    a.seq && b.seq && a.seq !== b.seq
      ? a.seq - b.seq
      : a.timestamp - b.timestamp
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
      (compare(order(ctx), deleted) < 0 || deleted.cancelled.includes(ctx.id))
    )
  }
  const supersede = (
    ctx: Context,
    cancel: (predicate: (item: Context) => boolean) => Context[]
  ): void => {
    const token = endpoint(ctx)
    if (!token || ctx.event.event !== 'Device Deleted') return
    const current = order(ctx)
    const previous = read(token)
    // Retrying an old delete must not cancel a subsequent registration.
    if (
      previous &&
      (compare(current, previous) < 0 || previous.deletes.includes(ctx.id))
    )
      return
    const removed = cancel(
      (item) =>
        endpoint(item) === token &&
        item.event.event === 'Device Created or Updated' &&
        compare(order(item), current) <= 0
    )
    const tied =
      previous && compare(previous, current) === 0 ? previous : undefined
    const deleted: Tombstone = {
      ...current,
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
