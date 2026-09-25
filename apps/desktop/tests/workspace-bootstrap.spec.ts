/** Workspace bootstrap reads reuse authenticated Web RPC and never read credential values. */
import { describe, expect, it, vi } from 'vitest'
import { connectWorkspaceBootstrap } from '../src/workspace-bootstrap.ts'

function transport(preference?: string) {
  const keys = new Map<string, string>()
  const namespaces = [
    { ns: 'llm-deepseek', value: { apiKeyEnv: 'CUSTOM_DEEPSEEK_KEY' } },
    { ns: 'llm-pi-ai', value: { profiles: { example: { apiKeyEnv: 'EXAMPLE_API_KEY' } } } },
    { ns: 'locale', value: preference === undefined ? {} : { preference } },
  ]
  const send = vi.fn<Parameters<typeof connectWorkspaceBootstrap>[1]>(async (_input, init) => {
    if (init?.method !== 'POST') return new Response('index')
    const { rpcId, method, payload } = JSON.parse(init.body as string) as {
      rpcId: string
      method: string
      payload: { args: { refs: string[] } }
    }
    let value: unknown
    if (method === 'settings/describe') value = { namespaces }
    else if (method === 'llm/listConfigurableProviders') value = [{ settingsNs: 'llm-pi-ai', settingsPath: ['profiles', 'example'] }]
    else value = Object.fromEntries(payload.args.refs.map(ref => [ref, { configured: keys.has(ref), writable: true }]))
    return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } })
  })
  return { send, keys, namespaces }
}

const url = 'http://127.0.0.1:19387/?token=fixture'

describe('desktop workspace bootstrap', () => {
  it('authenticates through Web and reports presence across providers', async () => {
    const host = transport()
    const bootstrap = await connectWorkspaceBootstrap(url, host.send)
    expect(host.send).toHaveBeenCalledExactlyOnceWith(url, { credentials: 'include' })
    expect(await bootstrap.hasApiKey()).toBe(false)
    host.keys.set('CUSTOM_DEEPSEEK_KEY', 'sk-example')
    expect(await bootstrap.hasApiKey()).toBe(true)
    for (const [input, init] of host.send.mock.calls.slice(1)) {
      expect(input).toMatch(/^http:\/\/127\.0\.0\.1:19387\/api\//u)
      expect(init).toMatchObject({ credentials: 'include', redirect: 'error' })
    }
  })

  it('recognizes another provider key when the official provider is absent', async () => {
    const host = transport()
    host.namespaces.splice(0, 1)
    const bootstrap = await connectWorkspaceBootstrap(url, host.send)
    expect(await bootstrap.hasApiKey()).toBe(false)
    host.keys.set('EXAMPLE_API_KEY', 'custom-key')
    expect(await bootstrap.hasApiKey()).toBe(true)
  })

  it('reads language without querying model providers', async () => {
    const host = transport('zh')
    const bootstrap = await connectWorkspaceBootstrap(url, host.send)
    host.send.mockClear()
    expect(await bootstrap.readLocalePreference()).toBe('zh')
    expect(host.send).toHaveBeenCalledOnce()
    expect(host.send.mock.calls[0]![0]).toContain('/api/settings/describe')
  })

  it('rejects unmatched RPC envelopes', async () => {
    const host = transport()
    const bootstrap = await connectWorkspaceBootstrap(url, host.send)
    host.send.mockResolvedValueOnce(Response.json({ type: 'server-response', rpcId: 'other', result: { ok: true } }))
    await expect(bootstrap.hasApiKey()).rejects.toThrow('Web RPC failed')
  })

  it('refuses an unauthenticated Web launch', async () => {
    const send = vi.fn<Parameters<typeof connectWorkspaceBootstrap>[1]>(async () => new Response(null, { status: 401 }))
    await expect(connectWorkspaceBootstrap(url, send)).rejects.toThrow('Web authentication failed')
  })
})
