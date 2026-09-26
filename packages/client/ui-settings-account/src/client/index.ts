/**
 * Account settings registration, retired from the Desktop shell. The package tree
 * stays compiled (components, locale dictionaries, and their specs), so the locale
 * namespace typing below remains for those files; this entry now contributes no
 * seats and no runtime of its own — every owning shell falls back to its
 * non-account default.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AccountKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.account': AccountKey }
}

export type { AccountKey } from './locales.ts'

/** Register nothing: the Desktop account surfaces are gone and no renderer mounts them. @param _ctx - client plugin context. */
export function apply(_ctx: Context): void {}
