/**
 * Client-bundle build check (dsh-llm-proxy's client-build.test.js adapted):
 * verifies lib/client.js exists (run `pnpm build:client` first) and carries
 * the loader handoff, the plugin id, the Plugins page (`plugins.item`)
 * registration gated on the Host serving the entry, the apply/inject exports
 * the shell expects, and that the bridge URL is baked in.
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
  // Live request 2026-10-14: the 固定/删除 text buttons became ICON buttons,
  // and 删除 was renamed — nothing is deleted, the row is rotated (a reserve
  // takes its slot, or it sinks to the pool tail). The icons are inline SVG
  // paths, so their geometry is the cheapest thing to pin here.
  const source = code(bundle())
  assert.ok(source.includes('M5.6 7V5.2'), 'the 固定 padlock path is in the bundle')
  assert.ok(source.includes('M12.8 8A4.8'), 'the 轮换 circular-arrow path is in the bundle')
  assert.ok(source.includes('轮换'), 'the rotated-out action is named 轮换, not 删除')
  assert.ok(!source.includes('已删除'), 'no user-visible string still says 已删除')
  assert.ok(source.includes('statsRotateHint'), 'the icon buttons carry their explanation in a tooltip')
  // 固定 + 轮换 are one segmented group, not two buttons with a gap (live
  // request 2026-10-14): the shared edge collapses to a single border via the
  // -1px pull, and only the group's outer corners keep their radius.
  assert.ok(source.includes('actionGroup>button+button{margin-left:-1px'), 'the shared edge is collapsed, not gapped')
  assert.ok(source.includes('actionGroup>button:not(:first-child){border-top-left-radius:0'), 'the inner corners are squared')
  assert.ok(source.includes('actionGroup>button:not(:last-child){border-top-right-radius:0'), 'and the outer ones keep their radius')
})

test('client bundle is built and well-formed', () => {
  const source = bundle()
  assert.ok(source.includes('window.__ModuleLoader__.load'), 'loader handoff present')
  assert.ok(source.includes('"@opencode2dsh/dsh-plugin"'), 'scoped bundle id stamped')
  assert.ok(source.includes('plugins.item'), 'plugins.item registration present')
  assert.ok(source.includes('/api/opencode2dsh/ip-pool'), 'bridge prefix baked in')
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
  // The entry id is the Loader entry id (the plugin name), not the old
  // `ip-pool` namespace the Host registered.
  assert.ok(source.includes('"opencode2dsh"'), 'the served entry id is the plugin name')

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
  assert.ok(/\[\s*IP_POOL_FIELD\s*,\s*"pinnedExitId"\s*\]/.test(source), 'pinned-exit write nests under ipPool too')
  // The save control belongs to the shared form chrome, not this page.
  assert.ok(source.includes('SettingsForm'), 'the page renders inside the shared form chrome')

  const stripped = code(source)
  assert.ok(!stripped.includes('settingsScope'), 'no runtime reference to the removed settingsScope service')
  assert.ok(!stripped.includes('useSnapshot'), 'no injected snapshot hook remains')
  assert.ok(!stripped.includes('.bind({ namespace'), 'no settingsScope.bind({ namespace }) call shape remains')
})

test('the probe-content field ships in the bundle', () => {
  const source = bundle()
  // Live request 2026-10-14: the probe's user turn became a configurable pool
  // (default 'hello'). The field is a plain string list next to the probe-model
  // picker; this pins that the section is actually mounted in the shipped half.
  assert.ok(source.includes('field-probeContents'), 'the 探测文案 list editor is mounted')
  assert.ok(source.includes('探测文案（probeContents）'), 'with its zh label')
  assert.ok(source.includes('probeContentsHint'), 'and its hint (留空 = 默认 hello)')
})

test('the 清空 control ships in the bundle', () => {
  const source = bundle()
  // Live request 2026-10-14: 总量统计保留 90 天自然过期，增加一个清空的功能按钮.
  // The armed state is a separate control, so a stray click on the first button
  // can never delete anything by itself.
  assert.ok(source.includes('usage-clear'), 'the clear button is mounted in the 流量 tab')
  assert.ok(source.includes('usage-clear-confirm'), 'with its own confirm control')
  assert.ok(source.includes('清空统计'), 'and its zh label')
  assert.ok(source.includes('统计已清空'), 'plus the success note')
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
