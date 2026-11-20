import type { ChatMode } from "./api";

export interface Preferences {
  defaultMode: ChatMode;
  language: "auto" | "en" | "ta" | "hi";
  speakReplies: boolean;
  speechRate: number;
  voiceURI: string;
  showAvatar: boolean;
  showModelLabel: boolean;
  autoSummary: boolean;
}

export const preferenceDefaults: Preferences = {
  defaultMode: "reflex",
  language: "en",
  speakReplies: false,
  speechRate: 1,
  voiceURI: "",
  showAvatar: true,
  showModelLabel: false,
  autoSummary: false,
};

const preferenceKey = "chitti.dashboard.preferences.v1";

export function readPreferences(): Preferences {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(preferenceKey) || "{}");
    if (typeof stored !== "object" || stored === null) return { ...preferenceDefaults };
    const values = stored as Partial<Record<keyof Preferences, unknown>>;
    const savedMode = values.defaultMode === "speed"
      ? "reflex"
      : values.defaultMode === "deep"
        ? "deliberate"
        : values.defaultMode;
    return {
      defaultMode: savedMode === "reflex" || savedMode === "deliberate" || savedMode === "deep_research"
        ? savedMode
        : preferenceDefaults.defaultMode,
      language: values.language === "auto" || values.language === "en" || values.language === "ta" || values.language === "hi"
        ? values.language
        : preferenceDefaults.language,
      speakReplies: Boolean(values.speakReplies),
      speechRate: Math.min(1.3, Math.max(0.7, Number(values.speechRate) || 1)),
      voiceURI: typeof values.voiceURI === "string" ? values.voiceURI : "",
      showAvatar: values.showAvatar === undefined ? preferenceDefaults.showAvatar : Boolean(values.showAvatar),
      showModelLabel: Boolean(values.showModelLabel),
      autoSummary: Boolean(values.autoSummary),
    };
  } catch {
    return { ...preferenceDefaults };
  }
}

export function persistPreferences(preferences: Preferences): void {
  localStorage.setItem(preferenceKey, JSON.stringify(preferences));
}
