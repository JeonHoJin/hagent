import { defineConfig, type Plugin } from 'vite'
import { mockApi } from './dev/mock-api.ts'

/** Pages origin; the CSP pins scripts and styles to this app's own folder on it. */
const ORIGIN = process.env.PAGES_ORIGIN ?? 'https://jeonhojin.github.io'
/** Where the page may connect; a local preview of the build (with the mock API) overrides it. */
const CONNECT = process.env.CSP_CONNECT ?? 'https://168-107-32-199.sslip.io'

const withSlashes = (p: string) => `/${p.replace(/^\/+|\/+$/g, '')}/`.replace('//', '/')

/**
 * The page's policy, added at build time only (the dev server needs its own scripts). The
 * origin is shared with other apps, so 'self' would let any of their files run here: scripts
 * and styles may come only from this app's assets folder, the service worker and manifest
 * only from this app's own files, nothing may be framed or posted, and Trusted Types refuse
 * every HTML/script sink except the exact worker URL (the app builds the DOM from text).
 */
function csp(base: string): Plugin {
  const app = `${ORIGIN}${base}`
  const assets = `${app}assets/`
  const policy = [
    "default-src 'none'",
    `script-src ${assets}`,
    `style-src ${assets}`,
    `img-src data: ${app}icons/`,
    `manifest-src ${app}manifest.webmanifest`,
    `worker-src ${app}sw.js`,
    `connect-src ${CONNECT}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types hagent-worker',
  ].join('; ')
  return {
    name: 'hagent-csp',
    apply: 'build',
    transformIndexHtml: html =>
      html.replace('<!-- csp -->', `<meta http-equiv="Content-Security-Policy" content="${policy}">`),
  }
}

export default defineConfig(({ mode }) => {
  const base = withSlashes(process.env.PAGES_BASE_PATH ?? '/hagent/')
  return {
    base,
    plugins: [csp(base), ...(mode === 'mock' ? [mockApi()] : [])],
    build: {
      // Everything ships as files under assets/, so the CSP above covers all of it.
      assetsInlineLimit: 0,
      modulePreload: { polyfill: false },
    },
  }
})
