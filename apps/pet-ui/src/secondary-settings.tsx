import { HooksSettingsPanel } from './hooks-panel';
import { PresenceSettingsPanel } from './presence-panel';
import { VoiceSettingsPanel } from './voice-panel';
import { AsrSettingsPanel } from './asr-panel';
import { ReminderSettingsPanel } from './reminder-panel';
import { AutomationSettingsPanel } from './automation-panel';
import { CuaSettingsPanel } from './cua-panel';
import { AgentAuditSettingsPanel } from './agent-audit-panel';
import { DshSettingsPanel } from './dsh-panel';
import { LearningSettingsPanel } from './learning-panel';
import { GameSettingsPanel } from './game-panel';

export function SecondarySettingsPanels({ config }: { config: any }) {
  return <>
    <HooksSettingsPanel/>
    <PresenceSettingsPanel/>
    <VoiceSettingsPanel config={config}/>
    <AsrSettingsPanel/>
    <ReminderSettingsPanel config={config.reminders}/>
    <AutomationSettingsPanel config={config.automation}/>
    <CuaSettingsPanel config={config.cua}/>
    <AgentAuditSettingsPanel/>
    <DshSettingsPanel config={config.dsh}/>
    <LearningSettingsPanel config={config.learning}/>
    <GameSettingsPanel config={config.game}/>
  </>;
}
