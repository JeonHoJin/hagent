/** The only Trusted Types policy: it can approve exactly this app's worker URL. */
export interface WorkerURLFactory {
  createPolicy(name: string, rules: { createScriptURL: (value: string) => string }): {
    createScriptURL(value: string): unknown
  }
}

export function workerScriptURL(url: string, factory?: WorkerURLFactory): unknown {
  if (!factory) return url
  const policy = factory.createPolicy('hagent-worker', {
    createScriptURL(value) {
      if (value !== url) throw new TypeError('Worker URL is not allowed')
      return url
    },
  })
  return policy.createScriptURL(url)
}
