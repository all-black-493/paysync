import { ApiKeysSection } from './api-keys-section'
import { TeamSection } from './team-section'

export function SettingsPanel() {
  return (
    <>
      <TeamSection />
      <ApiKeysSection />
    </>
  )
}
