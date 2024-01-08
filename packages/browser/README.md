Customer.io Data Pipelines analytics client for browsers.

## Installation

```
npm install @customerio/cdp-analytics-browser
```

## Usage

```ts
import { AnalyticsBrowser } from '@customerio/cdp-analytics-browser'

const analytics = AnalyticsBrowser.load({ writeKey: '<YOUR_WRITE_KEY>' })

analytics.identify('hello world')

document.body?.addEventListener('click', () => {
  analytics.track('document body clicked!')
})
```

## Other Regions

If you're using a [different data center](https://customer.io/docs/accounts-and-workspaces/data-centers/) such as our EU region, you can specify an alternate endpoint:

```ts
import { AnalyticsBrowser } from '@customerio/cdp-analytics-browser'

const analytics = AnalyticsBrowser.load({
  cdnURL: 'https://cdp-eu.customer.io',
  writeKey: '<YOUR_WRITE_KEY>'
});

analytics.identify('hello world')
```
