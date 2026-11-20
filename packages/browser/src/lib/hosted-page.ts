const hostedPageHost = /^form(-[a-z0-9]+)?\.customer\.io$/

// Every workspace's hosted pages share these hosts, under the domain
// Customer.io's own apps set cookies on, so stored identity would cross
// between workspaces and those apps.
export function isHostedPage(hostname: string): boolean {
  return hostedPageHost.test(hostname)
}
