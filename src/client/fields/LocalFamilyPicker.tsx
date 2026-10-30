import { useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IpPoolCardLocale, LocalIpFamilyView } from '../types.ts'

const ORDER: readonly LocalIpFamilyView[] = ['auto', 'ipv4', 'ipv6']

/**
 * 本机出口协议族 picker: which IP family the LOCAL egress dials with. `auto`
 * prefers IPv6 where this machine has a routable address and keeps the
 * happy-eyeballs fallback to IPv4; `ipv4`/`ipv6` pin the family
 * (src/pool/local-family.ts).
 */
export function LocalFamilyPicker(props: {
  value: LocalIpFamilyView
  disabled?: boolean
  t: IpPoolCardLocale
  onChange: (next: LocalIpFamilyView) => void
}): ReactNode {
  const { value, disabled, t, onChange } = props
  const [open, setOpen] = useState(false)
  const label: Record<LocalIpFamilyView, string> = {
    auto: t('localIpFamilyAuto'),
    ipv4: t('localIpFamilyIpv4'),
    ipv6: t('localIpFamilyIpv6'),
  }
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      anchor={
        <Button
          variant="outline"
          size="sm"
          data-testid="local-ip-family-select"
          disabled={disabled === true}
          onClick={() => setOpen((current) => !current)}
        >
          {label[value]}
          <IconChevronDownOutlineRegular />
        </Button>
      }
      items={ORDER.map((id) => ({ id, label: label[id] }))}
      selectedIds={[value]}
      onSelect={(id) => {
        onChange(id as LocalIpFamilyView)
        setOpen(false)
      }}
      align="start"
      side="bottom"
      portal
    />
  )
}
