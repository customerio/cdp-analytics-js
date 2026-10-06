import { test, expect } from '@playwright/test'
import path from 'path'

test('standalone web push UMD loads and attaches without subscribing', async ({
  page,
}) => {
  await page.goto('/')
  await page.addScriptTag({
    path: path.resolve(
      __dirname,
      '../../browser/dist/umd/webPushPlugin.min.js'
    ),
  })
  const result = await page.evaluate(async () => {
    const host = window as any
    let registrations = 0
    let prompts = 0
    navigator.serviceWorker.register = () => {
      registrations++
      throw new Error('Unexpected registration')
    }
    Notification.requestPermission = () => {
      prompts++
      throw new Error('Unexpected prompt')
    }
    const analytics: any = {
      user: () => ({ id: () => 'person' }),
      on: () => {},
      off: () => {},
    }
    const plugin = host.CustomerIOWebPush.WebPushPlugin({
      vapidPublicKey: 'public-key',
    })
    await plugin.load({}, analytics)
    const methods = Object.keys(analytics.webPush).sort()
    await analytics.webPush.subscription()
    await plugin.unload()
    return { methods, registrations, prompts }
  })
  expect(result).toEqual({
    methods: ['requestPermission', 'subscribe', 'subscription', 'unsubscribe'],
    registrations: 0,
    prompts: 0,
  })
})
