/**
 * The user JWT a page handed over before the in-app plugin loaded, per
 * Analytics instance. The in-app plugin takes it and gives it to gist-web
 * before gist-web's first request. It's a credential, so it's kept here rather
 * than on the instance, where it would be part of the published types and of
 * `window.cioanalytics`. A stored null means the page withdrew its JWT.
 */
export const pendingUserJwts = new WeakMap<object, string | null>()
