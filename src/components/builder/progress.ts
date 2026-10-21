import type { BuilderState } from "@/lib/services/types";

/**
 * Where the owner is in the setup, derived from server state.
 *
 * One function decides this so the progress bar and each step's checkmark can
 * never disagree. The rules are deliberately about what has HAPPENED, not what
 * has been clicked: in particular "Install" is only done once the snippet is
 * actually seen on the site (or a verification succeeded) — generating a
 * configuration in Forge installs nothing, and the step used to show a
 * checkmark the moment one was generated.
 */

export type StepKey = "scan" | "choose" | "install" | "verify" | "test";
export type StepState = "done" | "current" | "upcoming";

export interface StepProgress {
  key: StepKey;
  label: string;
  anchor: string;
  state: StepState;
  /** Optional steps never block "current" from moving on. */
  optional: boolean;
}

const STEPS: ReadonlyArray<{ key: StepKey; label: string; anchor: string; optional: boolean }> = [
  { key: "scan", label: "Scan", anchor: "step-scan", optional: false },
  { key: "choose", label: "Choose", anchor: "step-choose", optional: false },
  { key: "install", label: "Install", anchor: "step-install", optional: false },
  { key: "verify", label: "Verify", anchor: "step-verify", optional: false },
  { key: "test", label: "Test", anchor: "step-test", optional: true },
];

export function isVerified(state: BuilderState): boolean {
  const status = state.verification?.status;
  return status === "success" || status === "partial";
}

/** True once the snippet is observably on the site, not merely generated. */
export function isInstalled(state: BuilderState): boolean {
  if (isVerified(state)) return true;
  return state.installation?.installedVersion != null;
}

function isDone(key: StepKey, state: BuilderState): boolean {
  switch (key) {
    case "scan":
      return state.discovery !== null;
    case "choose":
      return state.installation !== null;
    case "install":
      return isInstalled(state);
    case "verify":
      return isVerified(state);
    case "test":
      // Open-ended: there is no point at which testing is "finished".
      return false;
  }
}

export function deriveProgress(state: BuilderState): StepProgress[] {
  let currentAssigned = false;

  return STEPS.map((step) => {
    if (isDone(step.key, state)) return { ...step, state: "done" as const };
    if (!currentAssigned) {
      currentAssigned = true;
      return { ...step, state: "current" as const };
    }
    return { ...step, state: "upcoming" as const };
  });
}

/** The progress state of one step — what its card uses to decide emphasis. */
export function stepStateFor(state: BuilderState, key: StepKey): StepState {
  return deriveProgress(state).find((step) => step.key === key)?.state ?? "upcoming";
}
