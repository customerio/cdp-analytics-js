Customer.io Data Pipelines analytics client for Node.js.

## Installation

```
npm install @customerio/cdp-analytics-node
```

## Usage

```ts
import { Analytics } from '@customerio/cdp-analytics-node'

// instantiation
const analytics = new Analytics({ writeKey: '<MY_WRITE_KEY>' });

analytics.identify({
  userId: '4'
});
```

## Other Regions

If you're using a [different data center](https://customer.io/docs/accounts-and-workspaces/data-centers/) such as our EU region, you can specify an alternate endpoint:

```ts
import { Analytics } from '@customerio/cdp-analytics-node'

// instantiation
const analytics = new Analytics({
  host: 'https://cdp-eu.customer.io',
  writeKey: '<MY_WRITE_KEY>'
});

analytics.identify({
  userId: '4'
});
```
