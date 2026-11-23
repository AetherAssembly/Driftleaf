import type { BranchPersonalization } from "./ipc";

export const DEFAULT_BRANCH_PERSONALIZATION: BranchPersonalization = {
  displayName: "",
  greetingLines: [],
};

const DISPLAY_NAME_MAX_LENGTH = 80;
const GREETING_LINE_MAX_LENGTH = 160;
const GREETING_LINES_MAX_COUNT = 20;

export function normalizeBranchPersonalization(value: unknown): BranchPersonalization {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_BRANCH_PERSONALIZATION };
  }
  const candidate = value as Partial<BranchPersonalization>;
  const displayName =
    typeof candidate.displayName === "string" &&
    candidate.displayName.trim().length <= DISPLAY_NAME_MAX_LENGTH
      ? candidate.displayName.trim()
      : "";
  const greetingLines = Array.isArray(candidate.greetingLines)
    ? candidate.greetingLines
        .filter(
          (line): line is string =>
            typeof line === "string" && line.trim().length <= GREETING_LINE_MAX_LENGTH,
        )
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, GREETING_LINES_MAX_COUNT)
    : [];
  return { displayName, greetingLines };
}

export function validateBranchPersonalization(value: unknown): BranchPersonalization {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Personalization must be an object");
  }
  const candidate = value as Partial<BranchPersonalization>;
  if (typeof candidate.displayName !== "string") {
    throw new Error("Display name must be text");
  }
  if (candidate.displayName.trim().length > DISPLAY_NAME_MAX_LENGTH) {
    throw new Error(`Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or shorter`);
  }
  if (!Array.isArray(candidate.greetingLines)) {
    throw new Error("Greeting lines must be a list");
  }
  if (candidate.greetingLines.length > GREETING_LINES_MAX_COUNT) {
    throw new Error(`You can add up to ${GREETING_LINES_MAX_COUNT} custom greeting lines`);
  }
  const greetingLines = candidate.greetingLines.map((line) => {
    if (typeof line !== "string") throw new Error("Greeting lines must be text");
    const trimmed = line.trim();
    if (trimmed.length > GREETING_LINE_MAX_LENGTH) {
      throw new Error(
        `Each greeting line must be ${GREETING_LINE_MAX_LENGTH} characters or shorter`,
      );
    }
    return trimmed;
  });
  return {
    displayName: candidate.displayName.trim(),
    greetingLines: greetingLines.filter(Boolean),
  };
}
