import type { WizardState } from "./state.js";

export const STEP_ORDER = [
  "sourceRepo",
  "audience",
  "exampleQuestions",
  "focusAreas",
  "cadence",
  "crafting",
  "confirmed",
] as const;

export function nextStep(current: string): string {
  const idx = STEP_ORDER.indexOf(current as (typeof STEP_ORDER)[number]);
  if (idx === -1 || idx === STEP_ORDER.length - 1) return current;
  return STEP_ORDER[idx + 1];
}

export function questionFor(step: string, state: WizardState): string {
  const escape = " (say 'cancel' to stop)";
  switch (step) {
    case "audience":
      return `What audience is this knowledge base for — internal engineers, external customers, support, all of the above?${escape}`;
    case "exampleQuestions":
      return `Give 2-3 example questions you want this bot to be able to answer about ${state.sourceRepo}.${escape}`;
    case "focusAreas":
      return `Anything specific the knowledge base should prioritize covering?${escape}`;
    case "cadence":
      return `How often should this repo refresh — daily or weekly? (default weekly)${escape}`;
    default:
      return "";
  }
}

export function applyAnswer(state: WizardState, rawAnswerText: string): WizardState {
  const text = rawAnswerText.trim();
  if (text.toLowerCase() === "cancel") {
    return { ...state, active: false };
  }

  const answers = { ...state.answers };
  if (state.step === "cadence") {
    const normalized = text.toLowerCase();
    answers.cadence = normalized === "daily" ? "daily" : "weekly";
  } else {
    answers[state.step] = text;
  }

  return { ...state, answers, step: nextStep(state.step) };
}
