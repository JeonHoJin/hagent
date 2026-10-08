/**
 * Pages cannot send X-Frame-Options or frame-ancestors, so the page refuses to run inside a
 * frame: it blanks itself and takes the top window to its own address.
 */
if (window.top !== window.self) {
  document.documentElement.replaceChildren()
  try {
    window.top!.location.href = window.location.href
  } catch {
    // A sandboxed frame may not navigate the top window; the page stays blank.
  }
  throw new Error('framed')
}
