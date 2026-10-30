/**
 * Client-bundle build check: verifies lib/client.js exists (run
 * `pnpm build:client` first) and carries the loader handoff, the plugin id,
 * the Plugins page (`plugins.item`) registration gated on the Host serving
 * the entry, the apply/inject exports the shell expects, and that the bridge
 * URL is baked in.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

/** The built client bundle, with a clear failure when it is missing. */
const bundle = (): string => {
  const path = new URL('../lib/client.js', import.meta.url)
  assert.ok(existsSync(path), 'lib/client.js missing — run `pnpm build:client` first')
  return readFileSync(path, 'utf8')
}

/** The bundle with prose (comments) stripped, so prose cannot satisfy an assertion. */
const code = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('/*'))
    .join('\n')

test('the exit tables ship icon actions and the 轮换 vocabulary', () => {
  // The row's action buttons are ICONs (a padlock and a circular arrow): the
  // old 删除 action is named 轮换 — nothing is deleted, the row is rotated (a
  // reserve takes its slot, or it sinks to the pool tail). The icons are
  // inline SVG paths, so their geometry is the cheapest thing to pin here.
  const source = code(bundle())
  assert.ok(source.includes('M5.6 7V5.2'), 'the 固定 padlock path is in the bundle')
  assert.ok(source.includes('M12.8 8A4.8'), 'the 轮换 circular-arrow path is in the bundle')
  assert.ok(source.includes('轮换'), 'the rotated-out action is named 轮换, not 删除')
  assert.ok(!source.includes('已删除'), 'no user-visible string still says 已删除')
  assert.ok(source.includes('statsRotateHint'), 'the icon buttons carry their explanation in a tooltip')
  // 固定 + 轮换 are one segmented group, not two buttons with a gap: the
  // shared edge collapses to a single border via the -1px pull, and only the
  // group's outer corners keep their radius.
  assert.ok(source.includes('actionGroup>button+button{margin-left:-1px'), 'the shared edge is collapsed, not gapped')
  assert.ok(source.includes('actionGroup>button:not(:first-child){border-top-left-radius:0'), 'the inner corners are squared')
  assert.ok(source.includes('actionGroup>button:not(:last-child){border-top-right-radius:0'), 'and the outer ones keep their radius')
})

test('client bundle is built and well-formed', () => {
  const source = bundle()
  assert.ok(source.includes('window.__ModuleLoader__.load'), 'loader handoff present')
  assert.ok(source.includes('"dsh-opencode2free-provider"'), 'scoped bundle id stamped')
  assert.ok(source.includes('plugins.item'), 'plugins.item registration present')
  assert.ok(source.includes('/api/oc2dsh/ip-pool'), 'bridge prefix baked in')
  assert.ok(/exports\.apply\s*=/.test(source), 'apply exported')
  assert.ok(/exports\.inject\s*=/.test(source), 'inject exported')
})

test('client mounts on the Plugins page while the Host serves the entry', () => {
  const source = bundle()
  // DSH 0.2: the configuration rides the `plugins.bundle.config` KEYED slot,
  // so clicking the bundle card lands straight on the form. The pre-0.2
  // `plugins.item` LIST entry remains as the fallback for hosts that
  // declaratively lack the bundle slot (checked via slots.spec).
  assert.ok(/name:\s*"plugins\.bundle\.config"/.test(source), 'registers the plugins.bundle.config keyed entry')
  assert.ok(/key:\s*pkg/.test(source), 'the keyed entry rides the bundle package name')
  assert.ok(/name:\s*"plugins\.item"/.test(source), 'the legacy plugins.item list entry stays as fallback')
  assert.ok(/id:\s*SETTINGS_NAMESPACE/.test(source), 'legacy entry is keyed by the settings entry id')
  // The gate: without it the page would show even where the Host serves no
  // settings, so the page mounts only while the namespace is served.
  assert.ok(source.includes('whileServed'), 'registration is gated on whileServed')
  assert.ok(/whileServed\(\[SETTINGS_NAMESPACE\]/.test(source), 'gated on this entry\'s namespace')
  // The entry id is the Loader entry id (the plugin name), not the `ip-pool`
  // namespace.
  assert.ok(source.includes('"oc2dsh"'), 'the served entry id is the plugin name')

  const stripped = code(source)
  assert.ok(!stripped.includes('settings.plugin.item'), 'the removed card slot is not registered')
  assert.ok(!/key:\s*SETTINGS_NAMESPACE/.test(stripped), 'no keyed-era registration shape remains')
})

test('client reads and writes settings through the page-supplied ConfigPageForm', () => {
  const source = bundle()
  // DSH 0.1.7 removed `settingsScope` and the injected `scope/useSnapshot`
  // pair. The Plugins page now hands the page a ConfigPageForm
  // (`{ state, mutate }`) for the served entry.
  assert.ok(source.includes('configForms'), 'the configForms service is used')
  assert.ok(/state\.status/.test(source) || /status === "ready"/.test(source), 'reads the served form state')
  assert.ok(source.includes('.mutate('), 'writes through mutate(ops, revision)')
  // The served value is the whole entry: the editable section is the `ipPool`
  // volatile node, so every write path keeps that field in front.
  assert.ok(/\[\s*"ipPool"\s*,\s*write\.field\s*\]/.test(source), 'write paths nest under the ipPool field')
  // The save control belongs to the shared form chrome, not this page.
  assert.ok(source.includes('SettingsForm'), 'the page renders inside the shared form chrome')

  const stripped = code(source)
  // Pins ride the bridge's /exit action (listener probe, protocol relabel,
  // exit-unreachable refusal, revive), never a direct settings write.
  assert.ok(!/"pinnedExitId"\s*\]/.test(stripped), 'no direct pinned-exit settings write remains')
  assert.ok(/exitAction\(\s*"pin"\s*,/.test(stripped), 'the card pins through the bridge exit action')
  assert.ok(stripped.includes('"/exit"'), 'the exit action posts the /exit route')
  assert.ok(!stripped.includes('settingsScope'), 'no runtime reference to the removed settingsScope service')
  assert.ok(!stripped.includes('useSnapshot'), 'no injected snapshot hook remains')
  assert.ok(!stripped.includes('.bind({ namespace'), 'no settingsScope.bind({ namespace }) call shape remains')
})

test('the probe-content field ships in the bundle', () => {
  const source = bundle()
  // The probe's user turn is a configurable pool (default 'hello'): a plain
  // string list next to the probe-model picker. This pins that the section is
  // mounted in the shipped half.
  assert.ok(source.includes('field-probeContents'), 'the 探测文案 list editor is mounted')
  assert.ok(source.includes('探测文案'), 'with its zh label')
  assert.ok(source.includes('probeContentsHint'), 'and its hint (留空 = 默认 hello)')
})

test('the 本地出口兜底 switch ships in the bundle', () => {
  const source = bundle()
  // 本地出口兜底 ships OFF by default: with no usable exit in the pool, the
  // request does not fall through to this machine's egress.
  assert.ok(source.includes('field-localFallback'), 'the switch is mounted in the pool card')
  assert.ok(source.includes('本地出口兜底'), 'with its zh label')
  assert.ok(source.includes('localFallbackHint'), 'and the hint that spells out both positions')
})

test('the 清空 control ships in the bundle', () => {
  const source = bundle()
  // Totals age out after 90 days (USAGE_RETENTION_DAYS), so the 流量 tab ships
  // a 清空 button. The armed state is a separate control, so a stray click on
  // the first button can never delete anything by itself.
  assert.ok(source.includes('usage-clear'), 'the clear button is mounted in the 流量 tab')
  assert.ok(source.includes('usage-clear-confirm'), 'with its own confirm control')
  assert.ok(source.includes('清空统计'), 'and its zh label')
  assert.ok(source.includes('统计已清空'), 'plus the success note')
})

test('the 订阅 refresh action ships in the stats modal', () => {
  // The stats modal can re-pull the subscriptions without opening the settings
  // card: same /probe scope the 立即刷新 button sends. The button is rendered
  // only while subscriptions are configured, so what ships is the test id, the
  // probe scope and the success note.
  const source = code(bundle())
  assert.ok(source.includes('stats-refresh-subscriptions'), 'the refresh button is mounted on the modal tab bar')
  assert.ok(source.includes('订阅已刷新'), 'with its zh success note')
  assert.ok(/"scope":\s*"subscription"/.test(source) || /scope:\s*"subscription"/.test(source), 'it posts the subscription probe scope')
})

test('the summary chip row keeps one pill height', () => {
  // The chip row must show ONE pill height: align-items:center stops the
  // 清空 button's 32px stretching every chip, and the pinned line box keeps a
  // Chinese label (a fallback face ~3px taller than the Latin one) from
  // showing a second height in a mixed row.
  const source = code(bundle())
  assert.ok(/statsSummary\{[^}]*align-items:center/.test(source), 'the chip row centres its items instead of stretching them')
  assert.ok(/statsChip\{[^}]*line-height:18px/.test(source), 'and every chip has the same pinned line box')
})

test('client externals stay inside the host platform table', () => {
  const source = bundle()
  const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]!)
  const allowed = new Set([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ])
  for (const specifier of required) {
    assert.ok(
      allowed.has(specifier),
      `bundle requires "${specifier}" which is not in the host module table — it would miss at runtime`,
    )
  }
})

test('client manifest is declared in package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.dsh?.client, 'dsh.client manifest missing')
  assert.equal(pkg.dsh.client.platform, 'web')
  // `dsh.client.inject` names PACKAGE ROWS, not services: client-modules
  // resolves each entry as a row id and uses the edges for factory arrival and
  // plugin composition. A service name is not a row, so the edge silently
  // resolves to nothing and the bundle loads before the services it needs.
  // The service list is the client ENTRY's own `inject` instead.
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
  ])
  for (const entry of pkg.dsh.client.inject) {
    assert.ok(entry.startsWith('@deepseek-ai/'), `manifest inject entry "${entry}" is a package name, not a service`)
  }
  // `settingsScope` was removed in 0.1.7; `configForms` replaced it.
  assert.ok(!pkg.dsh.client.inject.some((e: string) => e.includes('settingsScope')), 'the service DSH removed is not requested')

  const entry = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.match(entry, /export const inject = \['slots', 'locale'\]/, 'only stable services gate the main client fiber')
  assert.ok(bundle().includes('plugins.bundle.config'), 'the DSH 0.2 bundle-page configuration is registered')
  assert.deepEqual(pkg.exports?.['./client'], './lib/client.js')
})

test('the switch rows lead with their control', () => {
  // The master switch leads the row: the control is the row's first child, and
  // the row must not push it away with space-between. A type check sees
  // neither the order nor the layout, hence this bundle-level guard.
  const source = code(bundle())
  for (const id of ['field-enabled']) {
    const at = source.indexOf(id)
    assert.ok(at > 0, `${id} is in the bundle`)
    const row = source.slice(at, at + 2000)
    const text = row.indexOf('settingRowText')
    assert.ok(text > 0, `${id}'s row still renders its title/hint block`)
    assert.ok(row.indexOf('settingRowTitle') > text, `${id}'s switch precedes the text block`)
  }
  const rule = source.match(/_settingRow\{[^}]*\}/)?.[0] ?? ''
  assert.ok(rule !== '', 'the settingRow rule is in the bundle')
  assert.ok(!rule.includes('justify-content:space-between'), 'the row does not push its control to the trailing edge')
})

test('the 本机出口协议族 dropdown ships in the bundle', () => {
  const source = bundle()
  // The dropdown picks which family the 本机 egress dials with; the default
  // prefers IPv6 when this machine has it.
  assert.ok(source.includes('field-localIpFamily'), 'the dropdown is mounted in the pool card')
  assert.ok(source.includes('本机出口协议族'), 'with its zh label')
  assert.ok(source.includes('localIpFamilyHint'), 'and the hint that spells out the three positions')
  assert.ok(source.includes('localIpFamilyAuto'), 'plus the option labels')
})

test('the model context-window editor ships and writes its own root node', () => {
  const source = bundle()
  // The Zen endpoint serves 1M while models.dev may declare only 200K: the
  // settings page gives a per-model override.
  assert.ok(source.includes('field-modelContextWindows'), 'the context editor is mounted in the pool card')
  assert.ok(source.includes('模型上下文'), 'with its zh group title')
  assert.ok(source.includes('modelContextHint'), 'and its syntax hint')
  assert.ok(source.includes('modelContextInvalid'), 'plus the localised validation message')
  assert.ok(/path:\s*\[\s*"modelContextWindows"\s*\]/.test(source), 'the write lands on its own root node, not inside ipPool')
})
