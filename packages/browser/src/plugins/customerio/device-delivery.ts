import type { Context } from '../../core/context'

// track() can resolve while the destination has only queued a retry. Keep the
// HTTP acknowledgement off the event payload and out of persisted contexts.
// Symbol.for also bridges separately loaded analytics/plugin UMD bundles.
const accepted = Symbol.for('customerio.webpush.deviceAccepted')
type DeviceContext = Context & { [accepted]?: boolean }

export const deviceAccepted = (ctx: Context): boolean =>
  (ctx as DeviceContext)[accepted] === true
export const acceptDevice = (ctx: Context): void => {
  Object.defineProperty(ctx, accepted, { value: true, configurable: true })
}
export const isDeviceEvent = (ctx: Context): boolean =>
  ctx.event.type === 'track' &&
  ctx.event.context?.device?.type === 'web' &&
  (ctx.event.event === 'Device Created or Updated' ||
    ctx.event.event === 'Device Deleted')
