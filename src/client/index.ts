/**
 * oc2dsh — browser half. Registers the IP 池 page on the Plugins page
 * (设置 → 插件) through the `plugins.bundle.config` slot, which
 * @deepseek-ai/dsh-client-ui-plugin-manager owns, while the Host serves this
 * plugin's entry settings. The bundle detail page (插件 → oc2dsh) embeds the
 * configuration directly between the description and the rows; a Host without
 * that slot falls back to the `plugins.item` official-plugin page below.
 *
 * Unlike `plugins.item`/`plugins.row.config`, the bundle page's render site
 * hands the slot NO form — so the entry closes over the settings provider's
 * own controller (`configForms.get`) instead of a page-bound one; see
 * bundleConfigCard in IpPoolCard.tsx. Registration is gated on the Host
 * serving the `oc2dsh` namespace, so a deployment that serves no
 * oc2dsh settings shows no trace of the card.
 *
 * The form serves `ipPool` and the separate `requestHeaders` and
 * `modelContextWindows` volatile nodes. Pool writes stay under `ipPool`; Zen
 * headers and context windows have their own root paths.
 *
 * Export discipline: cross-plugin collaboration goes through cordis services
 * (`slots`, `locale`, `configForms`); the bundle purity gate forbids value
 * imports of other @deepseek-ai packages (type-only imports are erased).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge (whileServed / served entries).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.slots Context merge, which the renderer plugin declares
// (SlotRegistry: register / inject the list entry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' list entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: the sidebar's SlotMap merge (the 'sidebar.footer.action' entry the
// bottom-left stats button occupies — same contract usage-billing registers).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ExitStatsEntry } from './ExitStatsEntry.tsx'
import { IpPoolCard, bundleConfigCard } from './IpPoolCard.tsx'
import type { IpPoolKey } from './locales.ts'
import { en, zh } from './locales.ts'

export type { IpPoolCardProps, IpPoolSettingsValue } from './IpPoolCard.tsx'
export type { IpPoolKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The IP 池 page copy. */
    'settings.ip-pool': IpPoolKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.ip-pool'

/**
 * The Host settings entry this page edits: the Loader entry id, which is the
 * plugin name. The editable field inside it is `ipPool`.
 */
export const SETTINGS_NAMESPACE = 'oc2dsh'

/** Where this page sorts among the Plugins page's official entries. */
const ORDER = 20

/**
 * Required services (cordis fiber inject).
 *
 * Only stable services gate the main fiber. configForms is requested in a
 * separate fiber and owns the settings contribution's served lifetime.
 */
export const inject = ['slots', 'locale']

/**
 * Mount the IP 池 page whenever the Host serves this entry's settings.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'oc2dsh: copy dictionaries')
  const slots = ctx.slots as unknown as {
    inject(name: string, callback: () => () => void): () => void
    spec(name: string): unknown
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  // Request the version-specific service in its own fiber, so an older host
  // without configForms can still activate this plugin and its provider.
  ctx.inject(['configForms'], (formCtx) => { formCtx.effect(
    () => formCtx.configForms.whileServed(
      [SETTINGS_NAMESPACE],
      () => {
        // 0.2 embeds the configuration on the bundle's own detail page: one
        // click on the bundle card lands on the form. The keyed entry rides
        // the bundle's package name, and — unlike the row/item slots — its
        // render site supplies no form, so the entry binds the settings
        // provider's controller itself (bundleConfigCard).
        const bundle = slots.inject('plugins.bundle.config', () => {
          const card = bundleConfigCard(formCtx.configForms.get(SETTINGS_NAMESPACE))
          const disposers = ['dsh-opencode2free-provider', 'oc2dsh'].map((pkg) => slots.register({
            name: 'plugins.bundle.config',
            key: pkg,
            locale: NS,
          }, card))
          return () => { for (const dispose of disposers) dispose() }
        })
        const legacy = slots.inject('plugins.item', () => {
          if (slots.spec('plugins.bundle.config') !== undefined) return () => {}
          return slots.register({
            name: 'plugins.item',
            id: SETTINGS_NAMESPACE,
            order: ORDER,
            label: () => t('title'),
            locale: NS,
          }, IpPoolCard)
        })
        // Bottom-left footer button (sidebar footer, beside Settings): opens
        // the exit-stats modal. Mounted only while this entry's settings are
        // served — a deployment without the namespace shows no trace.
        const footer = slots.inject('sidebar.footer.action', () => slots.register({
          name: 'sidebar.footer.action',
          id: 'ip-pool-exits',
          order: 10,
          locale: NS,
        }, ExitStatsEntry))
        return () => { bundle(); legacy(); footer() }
      },
    ),
    'oc2dsh: settings page',
  ) })
}
