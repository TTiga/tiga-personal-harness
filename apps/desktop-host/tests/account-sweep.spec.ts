/**
 * The Desktop profile's account sweep, verified at the composition seam: the
 * launcher's overlay retires exactly the four account rows when applied as the
 * last `--patch` layer over the Desktop bundle rosters (base + web-app — the
 * same bundles the web template ships, so the sweep is the Desktop
 * composition's only account difference), leaves every other row untouched,
 * and the Web e2e lane's fixture mirror stays byte-identical to the launcher
 * text its desktop-marked scenarios compose.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches, renderConfigDump, type ConfigDumpLayer } from '@deepseek-ai/dsh-app-boot'
import { ACCOUNT_SWEEP_PATCH } from '../src/index.ts'

const NAME = 'dsh'
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
/** The empty root entry list every profile tree patches over (see `apps/cli/src/profile-boot.ts`). */
const PROFILE_ROOT_CONFIG = '# dsh profile root — an empty entry list. The tree is composed as patches.\n[]\n'
/** The rows the sweep retires: the whole account login surface of the Desktop composition. */
const SWEPT_IDS = ['deepseek-account', 'llm-deepseek-account', 'ui-settings-account', 'account-controller'] as const
/** An account-adjacent row the sweep must leave mounted: the API-key provider the onboarding dialog guides to. */
const KEPT_ID = 'llm-deepseek'

const tempRoots: string[] = []
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One composed entry row. */
interface Entry {
  readonly id: string
  readonly disabled?: boolean
}

/**
 * Bundle patch files of the Desktop composition, in bundle order, read from
 * each bundle manifest exactly the way the profile boot resolves them.
 * @returns one layer per patch file, ready for {@link renderConfigDump}.
 */
function desktopBundleLayers(): ConfigDumpLayer[] {
  const layers: ConfigDumpLayer[] = []
  for (const bundle of ['base', 'web-app']) {
    const dir = join(REPO_ROOT, 'packages', 'bundle', bundle)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { bundle: { patch: string | readonly string[] } } }
    const patches = typeof manifest.dsh.bundle.patch === 'string' ? [manifest.dsh.bundle.patch] : manifest.dsh.bundle.patch
    for (const patch of patches) {
      const file = join(dir, patch)
      layers.push({ label: relative(REPO_ROOT, file), patches: loadOverlayPatches(NAME, file) })
    }
  }
  return layers
}

/**
 * Compose the Desktop tree with or without the sweep overlay and index it by row id.
 * @param sweep - whether the launcher overlay is applied as the last layer.
 * @returns the composed rows indexed by id, plus the collected skip warnings.
 */
function composeDesktopTree(sweep: boolean): { rows: Map<string, Entry>; warnings: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-account-sweep-'))
  tempRoots.push(root)
  const rootConfig = join(root, 'cordis.yml')
  writeFileSync(rootConfig, PROFILE_ROOT_CONFIG)
  const layers = desktopBundleLayers()
  if (sweep) {
    const sweepFile = join(root, 'account-sweep.patch.yml')
    writeFileSync(sweepFile, ACCOUNT_SWEEP_PATCH)
    layers.push({ label: 'account-sweep.patch.yml', patches: loadOverlayPatches(NAME, sweepFile) })
  }
  const warnings: string[] = []
  const dump = renderConfigDump(NAME, rootConfig, layers, line => void warnings.push(line))
  const entries = yaml.load(dump, { schema: entryListSchema }) as Entry[]
  return { rows: new Map(entries.map(entry => [entry.id, entry])), warnings }
}

describe('the Desktop account sweep overlay', () => {
  it('stays byte-identical to the Web e2e lane fixture that mirrors it', async () => {
    const mirror = await readFile(join(REPO_ROOT, 'apps', 'web', 'tests', 'fixtures', 'desktop-account-sweep.patch.yml'), 'utf8')
    expect(mirror).toBe(ACCOUNT_SWEEP_PATCH)
  })

  it('retires exactly the four account rows from the composed Desktop tree', () => {
    const { rows, warnings } = composeDesktopTree(true)
    expect(warnings).toEqual([])
    for (const id of SWEPT_IDS) {
      expect(rows.get(id), `${id} stays in the tree, switched off`).toMatchObject({ disabled: true })
    }
    expect(rows.get(KEPT_ID), 'the API-key provider row stays mounted').toBeDefined()
    expect(rows.get(KEPT_ID)?.disabled).not.toBe(true)
  })

  it('changes nothing until it is applied: the shipped tree keeps the rows mounted', () => {
    const { rows, warnings } = composeDesktopTree(false)
    expect(warnings).toEqual([])
    for (const id of SWEPT_IDS) {
      expect(rows.get(id), `${id} is a real row of the shipped rosters`).toBeDefined()
      expect(rows.get(id)?.disabled).not.toBe(true)
    }
  })
})
