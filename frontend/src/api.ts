export type ChatMode = "reflex" | "deliberate" | "deep_research";
export type ChatRole = "user" | "assistant";

export interface HistoryMessage {
  role: ChatRole;
  content: string;
}

export interface ChatSource {
  url?: string;
  title?: string;
  source: string;
  license?: string;
}

export interface ReasoningSummary {
  plan_summary?: string;
  risk_level?: string;
  estimated_seconds?: number;
  cost_estimate?: string;
  planned_tools?: string[];
  tools_used?: string[];
  sources?: string[];
  matched_notes?: string[];
  confidence?: string;
  critique_summary?: string;
  revision_count?: number;
}

export interface ChatResponse {
  reply: string;
  mode: ChatMode | "speed" | "deep";
  sources: ChatSource[];
  reasoning: ReasoningSummary | null;
}

export interface MemoryEntry {
  id: string | number;
  kind: "document" | "note";
  source: string;
  content: string;
}

export interface KnowledgeSource {
  id: string;
  name: string;
  enabled: boolean;
  language: string;
  license: string;
  indexed_chunks: number;
  indexed_bytes: number;
  last_updated: string | null;
  retrieval_count: number;
}

export interface ToolDescription {
  id: string;
  enabled: boolean;
}

export interface Reminder {
  id: string | number;
  task: string;
  due_at: string;
  completed: boolean;
}

export interface EmailDraft {
  recipient: string;
  subject: string;
  body: string;
}

export interface ToolActivity {
  kind: string;
  [key: string]: unknown;
}

export interface FileMatch {
  path: string;
  line?: number;
  snippet: string;
}

export interface WebResult {
  url: string;
  title?: string;
  snippet: string;
}

export interface VoiceStatus {
  installed: boolean;
}

export interface VisionStatus {
  object_detection: { installed: boolean };
  ocr: { installed: boolean };
  scene_description: { enabled: boolean };
}

export interface SettingsStatus {
  model: { name: string };
  knowledge: { indexed_chunks: number };
  tools: ToolDescription[];
  voice: { installed: boolean; model: string };
  vision: {
    object_detection: { installed: boolean };
    ocr: { installed: boolean };
    scene_description: { enabled: boolean };
  };
  authentication: boolean;
}

export interface VisionResult {
  width: number;
  height: number;
  objects: Array<{ label: string; confidence: number }>;
  ocr_text?: string;
  scene_description?: string;
  warnings: string[];
}

export interface ToolStatus {
  tools: ToolDescription[];
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (response.status === 204) return undefined as T;
  const data: unknown = await response.json();
  if (!response.ok) {
    const detail =
      typeof data === "object" && data !== null && "detail" in data && typeof data.detail === "string"
        ? data.detail
        : "Request failed.";
    throw new Error(detail);
  }
  return data as T;
}

export function jsonRequest(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function requestTool<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  return request<T>(`/api/tools${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
