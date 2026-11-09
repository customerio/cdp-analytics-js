export function shouldPolyfill(): boolean {
  const browserVersionCompatList: { [browser: string]: number } = {
    Firefox: 46,
    Edge: 13,
  }

  // Unfortunately IE doesn't follow the same pattern as other browsers, so we
  // need to check `isIE11` differently.
  // @ts-expect-error
  const isIE11 = !!window.MSInputMethodContext && !!document.documentMode

  const userAgent = navigator.userAgent.split(' ')
  const [browser, version] = userAgent[userAgent.length - 1].split('/')

  return (
    isIE11 ||
    (browserVersionCompatList[browser] !== undefined &&
      browserVersionCompatList[browser] >= parseInt(version))
  )
}

// appName = Netscape IE / Edge
// edge 13 Edge/13... same as FF

// Loaded for old browsers before the SDK starts. The hash is of this exact
// cdnjs file (99343 bytes); cdnjs publishes the same file's sha512
// (sha512-0MJ3vHyX4nzRAMxZkX2duT/GG6HrzWiWBIdNALoYq7RvZREBFj9ofishn0RX3to15Kxdy5cPD3ZsUHoKvhlokw==).
// cdnjs answers with Access-Control-Allow-Origin: *, which crossorigin needs.
export const POLYFILL_URL =
  'https://cdnjs.cloudflare.com/ajax/libs/babel-polyfill/7.7.0/polyfill.min.js'
export const POLYFILL_INTEGRITY =
  'sha384-Fbe31ZqFxktD++WKw92rzNU9ROzGC0taO0LK7GrLloHkGRmL60n7Rp4gauiM2cfr'

export function createPolyfillScript(): HTMLScriptElement {
  const script = document.createElement('script')
  script.setAttribute('src', POLYFILL_URL)
  script.setAttribute('integrity', POLYFILL_INTEGRITY)
  script.setAttribute('crossorigin', 'anonymous')
  return script
}
