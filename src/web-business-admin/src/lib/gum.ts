/**
 * getUserMedia, one at a time. The Chilli Staff app shows the Business app in an Android WebView; two getUserMedia calls at once
 * (the mic guard and the voice order both ask on the POS page) make the native shell answer the same permission request twice
 * ("Either grant() or deny() has been already called") and the app crashes. Queueing them means the second call starts after the
 * first was answered (and then needs no prompt). Same behaviour in a normal browser, just ordered.
 */
let tail: Promise<unknown> = Promise.resolve();

export function getUserMediaQueued(constraints: MediaStreamConstraints): Promise<MediaStream> {
  const run = () => navigator.mediaDevices.getUserMedia(constraints);
  const p = tail.then(run, run);
  tail = p.then(() => undefined, () => undefined);
  return p;
}
