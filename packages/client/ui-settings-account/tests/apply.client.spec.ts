// @vitest-environment jsdom
/** The account composition is retired from every renderer: no seats and no account traffic. */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'

const it = createClientTest({ roster: webApp })
const SELF = '@deepseek-ai/dsh-client-ui-settings-account'

/** Every account-owned seat the Desktop sweep retired; each owning shell keeps its own fallback. */
function expectNoAccountSeats(c: TestClient): void {
  expect(c.ctx.slots.entries('settings.launcher')).toHaveLength(0)
  expect(c.ctx.slots.entries('settings.models.sign-in')).toHaveLength(0)
  expect(c.ctx.slots.entries('settings.section').some(entry => entry.options.id === 'account')).toBe(false)
  expect(c.ctx.slots.entries('shell.quota-notice')).toHaveLength(0)
  expect(c.ctx.slots.entries('shell.overlay')
    .some(entry => entry.options.id === 'desktop-onboarding' || entry.options.id === 'account.platform-page')).toBe(false)
}

/** No account Remote call or stream may leave the composition, live or on a reload. */
function expectNoAccountTraffic(c: TestClient): void {
  expect(c.mock.log.calls().filter(call => call.endpoint.startsWith('account/'))).toEqual([])
  expect(c.mock.log.streams().filter(stream => stream.endpoint.startsWith('account/'))).toEqual([])
}

beforeEach(() => { vi.stubEnv('DSH_CLIENT_VERSION', '0.0.0-test') })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

it('registers no account seats and no account traffic in a plain browser, including after reload', async ({ start }) => {
  const c = await start()
  for (const reload of [false, true]) {
    if (reload) await c.reload(SELF)
    await c.flush()
    expectNoAccountSeats(c)
    expectNoAccountTraffic(c)
  }
}, 60_000)

it('registers no account seats and no account traffic in the Desktop renderer either', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  // The retired native Platform bridge presence changes nothing either.
  vi.stubGlobal('dshPlatform', { open: vi.fn(), setBounds: vi.fn(), close: vi.fn() })
  const c = await start()
  for (const reload of [false, true]) {
    if (reload) await c.reload(SELF)
    await c.flush()
    expectNoAccountSeats(c)
    expectNoAccountTraffic(c)
  }
  await c.unload(SELF)
  expectNoAccountSeats(c)
}, 60_000)
