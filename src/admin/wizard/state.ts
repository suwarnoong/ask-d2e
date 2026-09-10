export interface WizardState {
  active: boolean;
  step: string;
  sourceRepo: string;
  answers: Record<string, string>;
  editingRepoName?: string;
}

const STATE_MARKER = "ASK_D2E_WIZARD_STATE:";

export function encodeState(bodyText: string, state: WizardState): string {
  return `${bodyText}\n\n${STATE_MARKER} ${JSON.stringify(state)}`;
}

export function decodeState(messageText: string): WizardState | null {
  const idx = messageText.indexOf(STATE_MARKER);
  if (idx === -1) return null;
  const jsonText = messageText.slice(idx + STATE_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const state = parsed as Partial<WizardState>;
  if (!state.active) return null;
  return state as WizardState;
}
