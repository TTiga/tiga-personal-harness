/** Native workspace boot facts using the shared Web authentication and RPC APIs. */

import { randomUUID } from 'node:crypto'

/** Facts the shell reads from Host settings while the workspace runs. */
export interface DesktopWorkspaceBootstrap {
  /** @returns The saved UI language without account or provider requests. */
  readLocalePreference(): Promise<string | null>
  /** @returns Whether any configurable model provider stores a credential; presence only, never values. */
  hasApiKey(): Promise<boolean>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Authenticate the native HTTP client through the Web application's launch URL.
 * @param authenticatedUrl - URL supplied by the running Desktop Host.
 * @param send - Electron session fetch, retaining the Web authentication cookie.
 * @returns language-preference and credential-presence reads over standard RPC.
 */
export async function connectWorkspaceBootstrap(
  authenticatedUrl: string,
  send: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<DesktopWorkspaceBootstrap> {
  const origin = new URL(authenticatedUrl).origin
  const authenticated = await send(authenticatedUrl, { credentials: 'include' })
  await authenticated.body?.cancel()
  if (!authenticated.ok) throw new Error('desktop workspace: Web authentication failed')
  const invoke = async (request: { namespace: string; method: string; args: Record<string, unknown> }): Promise<unknown> => {
    const rpcId = randomUUID()
    const method = `${request.namespace}/${request.method}`
    const response = await send(new URL(`/api/${method}`, origin).href, {
      method: 'POST', credentials: 'include', redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request.args } }),
    })
    if (!response.ok) throw new Error('desktop workspace: Web request failed')
    const envelope: unknown = await response.json()
    if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !record(envelope.result) || envelope.result.ok !== true) {
      throw new Error('desktop workspace: Web RPC failed')
    }
    return envelope.result.value
  }
  const describeSettings = async (): Promise<unknown[]> => {
    const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
    if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('desktop workspace: missing settings namespaces')
    return settings.namespaces as unknown[]
  }
  const findNamespace = (namespaces: unknown[], ns: string): unknown =>
    namespaces.find((item: unknown) => record(item) && item.ns === ns)
  const settingsAndReference = async (): Promise<{ namespaces: unknown[]; ref: string | undefined }> => {
    const namespaces = await describeSettings()
    const official: unknown = findNamespace(namespaces, 'llm-deepseek')
    if (official === undefined) return { namespaces, ref: undefined }
    if (!record(official) || !record(official.value) || typeof official.value.apiKeyEnv !== 'string') {
      throw new Error('desktop workspace: missing official DeepSeek credential reference')
    }
    return { namespaces, ref: official.value.apiKeyEnv }
  }
  const localePreference = (namespaces: unknown[]): string | null => {
    const locale: unknown = findNamespace(namespaces, 'locale')
    if (!record(locale) || !record(locale.value)
      || (locale.value.preference !== undefined && typeof locale.value.preference !== 'string')) {
      throw new Error('desktop workspace: invalid locale preference')
    }
    return locale.value.preference ?? null
  }
  const credentialReferences = async (): Promise<string[]> => {
    const { namespaces, ref } = await settingsAndReference()
    const providers = await invoke({ namespace: 'llm', method: 'listConfigurableProviders', args: {} })
    if (!Array.isArray(providers)) throw new Error('desktop workspace: invalid provider directory')
    const refs = providers.flatMap((provider: unknown) => {
      if (!record(provider) || typeof provider.settingsNs !== 'string' || !Array.isArray(provider.settingsPath)) {
        throw new Error('desktop workspace: invalid provider settings address')
      }
      const namespace: unknown = findNamespace(namespaces, provider.settingsNs)
      let value: unknown = record(namespace) ? namespace.value : undefined
      for (const key of provider.settingsPath) {
        if (typeof key !== 'string') throw new Error('desktop workspace: invalid provider settings path')
        value = record(value) ? value[key] : undefined
      }
      return record(value) && typeof value.apiKeyEnv === 'string' ? [value.apiKeyEnv] : []
    })
    return [...new Set([...(ref === undefined ? [] : [ref]), ...refs])]
  }
  return {
    async readLocalePreference() {
      return localePreference(await describeSettings())
    },
    async hasApiKey() {
      const unique = await credentialReferences()
      const states: Record<string, unknown> = {}
      // credentials.describe accepts at most 64 references per request.
      for (let offset = 0; offset < unique.length; offset += 64) {
        const batch = await invoke({ namespace: 'credentials', method: 'describe', args: { refs: unique.slice(offset, offset + 64) } })
        if (!record(batch)) throw new Error('desktop workspace: invalid credential metadata')
        Object.assign(states, batch)
      }
      return Object.values(states).some(value => record(value) && value.configured === true)
    },
  }
}
