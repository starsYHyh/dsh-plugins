//#region lib/index.js
/**
 * Node half of the `dsh-notify` plugin.
 *
 * Desktop notifications are raised by the browser half (`./client`) through the
 * page's own `Notification` API, so they carry the application's identity and
 * respect the system's Focus/Disturb rules. This entry exists so the package is
 * an ordinary Loader row: the client-modules node half scans enabled rows, reads
 * this package manifest, and serves `lib/client.js` as the row's browser bundle.
 * It deliberately does nothing else.
 *
 * @module dsh-notify
 */

/** Loader-visible no-op body; the browser half carries the feature. */
function apply() {}

/** Cordis plugin name used by loader diagnostics. */
const name = 'dsh-notify';
//#endregion

export { apply, name };
