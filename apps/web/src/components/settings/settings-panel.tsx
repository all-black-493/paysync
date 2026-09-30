import { ApiKeysSection } from './api-keys-section'
import { MembersSection } from './members-section'
import { RolesSection } from './roles-section'
import { TeamSection } from './team-section'

export function SettingsPanel({ viewerId }: { viewerId: string }) {
  return (
    <>
      <TeamSection />
      <MembersSection viewerId={viewerId} />
      <RolesSection />
      <ApiKeysSection />
    </>
  )
}
