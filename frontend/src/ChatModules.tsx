import { ChangeEvent, FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import {
  EmailDraft,
  FileMatch,
  KnowledgeSource,
  MemoryEntry,
  Reminder,
  SettingsStatus,
  ToolActivity,
  ToolStatus,
  VisionResult,
  VisionStatus,
  VoiceStatus,
  WebResult,
  errorMessage,
  jsonRequest,
  request,
  requestTool,
} from "./api";
import { PanelName } from "./Navigation";
import { preferenceDefaults, Preferences } from "./preferences";

interface ChatModulesProps {
  panel: PanelName;
  onClose: () => void;
  preferences: Preferences;
  setPreferences: (preferences: Preferences) => void;
  mode: Preferences["defaultMode"];
  setMode: (mode: Preferences["defaultMode"]) => void;
  onTranscription: (text: string) => void;
  onVoiceRecordingChange: (recording: boolean) => void;
}

const fieldClass = "min-w-0 rounded-xl border border-white/20 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/45";
const actionClass = "rounded-full border border-white/25 bg-white/10 px-4 py-2 text-sm text-white transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass = "rounded-full bg-white px-4 py-2 text-sm text-black transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50";

function PanelShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={`${title} controls`}>
      <div className="mb-4 flex shrink-0 items-center justify-between border-b border-white/15 pb-3">
        <h2 className="m-0 text-xl font-normal">{title}</h2>
        <button type="button" className={actionClass} onClick={onClose}>Back to chat</button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">{children}</div>
    </section>
  );
}

function Status({ children }: { children: ReactNode }) {
  return <p className="min-h-5 text-sm text-white/65" role="status">{children}</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl border border-white/15 bg-black/35 p-4">
      <h3 className="m-0 text-base font-normal">{title}</h3>
      {children}
    </section>
  );
}

function MemoryPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("");

  async function refreshMemory() {
    try {
      setEntries(await request<MemoryEntry[]>("/api/memory"));
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  useEffect(() => { void refreshMemory(); }, []);

  async function saveNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = note.trim();
    if (!content) return;
    setStatus("Saving note…");
    try {
      await request("/api/memory", jsonRequest({ content }));
      setNote("");
      setStatus("Note saved locally.");
      await refreshMemory();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function addDocument(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setStatus("Indexing document…");
    try {
      const content = await file.text();
      const result = await request<{ source: string; chunks: number }>("/api/memory/documents", jsonRequest({ source: file.name, content }));
      setStatus(`${result.source} added (${result.chunks} chunks).`);
      await refreshMemory();
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      input.value = "";
    }
  }

  async function removeEntry(id: MemoryEntry["id"]) {
    try {
      await request(`/api/memory/${encodeURIComponent(String(id))}`, { method: "DELETE" });
      await refreshMemory();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function deleteAll() {
    if (!window.confirm("Permanently delete every saved note and indexed document?")) return;
    try {
      await request("/api/memory?confirm=true", { method: "DELETE" });
      setStatus("All local memory deleted.");
      await refreshMemory();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  return (
    <PanelShell title="Memory" onClose={onClose}>
      <Section title="Save a note">
        <form onSubmit={saveNote} className="flex flex-wrap gap-2">
          <input className={`${fieldClass} flex-1`} maxLength={8000} required value={note} onChange={(event) => setNote(event.target.value)} placeholder="Save a note for later…" />
          <button className={primaryClass} type="submit">Save note</button>
        </form>
        <div className="flex flex-wrap items-center gap-3">
          <label className={`${actionClass} cursor-pointer`}>
            Add .txt or .md
            <input className="sr-only" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={addDocument} />
          </label>
          <button className={actionClass} type="button" onClick={() => window.location.assign("/api/memory/export")}>Export JSON</button>
          <button className="rounded-full border border-red-300/40 px-4 py-2 text-sm text-red-100 hover:bg-red-500/15" type="button" onClick={deleteAll}>Delete all</button>
        </div>
      </Section>
      <Status>{status}</Status>
      <div className="space-y-3">
        {!entries.length && <p className="text-sm text-white/60">No saved notes or documents.</p>}
        {entries.map((entry) => (
          <article key={String(entry.id)} className="rounded-2xl border border-white/15 bg-black/35 p-4">
            <p className="mb-2 text-[10px] tracking-wider text-white/55">{entry.kind === "document" ? "DOCUMENT" : "NOTE"} · {entry.source}</p>
            <p className="whitespace-pre-wrap break-words text-sm">{entry.content}</p>
            <button type="button" className={`${actionClass} mt-3`} onClick={() => void removeEntry(entry.id)}>Delete</button>
          </article>
        ))}
      </div>
    </PanelShell>
  );
}

function SourcesPanel({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState("en");
  const [status, setStatus] = useState("");

  async function refreshSources() {
    try {
      setSources(await request<KnowledgeSource[]>("/api/knowledge/sources"));
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }
  useEffect(() => { void refreshSources(); }, []);

  async function toggleSource(source: KnowledgeSource, enabled: boolean) {
    try {
      await request(`/api/knowledge/sources/${encodeURIComponent(source.id)}`, jsonRequest({ enabled }, "PATCH"));
      await refreshSources();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function ingest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;
    setStatus("Searching Wikipedia and indexing selected extracts…");
    try {
      const result = await request<{ source: string; pages: number; chunks: number }>("/api/knowledge/ingest", jsonRequest({ query: trimmedQuery, language, limit: 3 }));
      setStatus(`${result.source}: indexed ${result.pages} pages (${result.chunks} chunks).`);
      await refreshSources();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  return (
    <PanelShell title="Sources" onClose={onClose}>
      <Section title="Index open knowledge">
        <form onSubmit={ingest} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <input className={fieldClass} value={query} onChange={(event) => setQuery(event.target.value)} maxLength={300} required placeholder="Search a topic to index…" />
          <select className={fieldClass} value={language} onChange={(event) => setLanguage(event.target.value)} aria-label="Wikipedia language">
            <option value="en">English</option><option value="ta">Tamil</option><option value="hi">Hindi</option>
          </select>
          <button className={primaryClass} type="submit">Index</button>
        </form>
        <p className="m-0 text-xs text-white/55">Fetches up to 5 short extracts per request from Wikipedia. Nothing is indexed until you submit a search.</p>
      </Section>
      <Status>{status}</Status>
      <div className="space-y-3">
        {sources.map((source) => (
          <article key={source.id} className="rounded-2xl border border-white/15 bg-black/35 p-4">
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={Boolean(source.enabled)} onChange={(event) => void toggleSource(source, event.target.checked)} />
              <span>{source.name}</span>
            </label>
            <p className="mb-0 mt-2 text-xs text-white/55">
              {source.language.toUpperCase()} · {source.license} · {source.indexed_chunks} chunks · {source.indexed_bytes < 1024 * 1024
                ? `${(source.indexed_bytes / 1024).toFixed(1)} KB`
                : `${(source.indexed_bytes / (1024 * 1024)).toFixed(1)} MB`} · {source.last_updated ? new Date(source.last_updated).toLocaleString() : "Not indexed"} · {source.retrieval_count} retrievals
            </p>
          </article>
        ))}
      </div>
    </PanelShell>
  );
}

interface PreviewResponse {
  confirmation_token: string;
  action: string;
  entity_id: string;
  expires_in_seconds: number;
}

function ToolsPanel({ onClose }: { onClose: () => void }) {
  const [capabilities, setCapabilities] = useState("Loading configured tools…");
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [activity, setActivity] = useState<ToolActivity[]>([]);
  const [calculation, setCalculation] = useState("");
  const [calculationResult, setCalculationResult] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [fileMatches, setFileMatches] = useState<FileMatch[]>([]);
  const [weatherPlace, setWeatherPlace] = useState("");
  const [weatherResult, setWeatherResult] = useState("");
  const [webQuery, setWebQuery] = useState("");
  const [webResults, setWebResults] = useState<WebResult[]>([]);
  const [reminderTask, setReminderTask] = useState("");
  const [reminderDue, setReminderDue] = useState("");
  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [entity, setEntity] = useState("");
  const [homeAction, setHomeAction] = useState("turn_on");
  const [homeStatus, setHomeStatus] = useState("");
  const [confirmation, setConfirmation] = useState("");

  async function refreshTools() {
    try {
      const [status, nextReminders, nextDrafts, nextActivity] = await Promise.all([
        requestTool<ToolStatus>(""),
        requestTool<Reminder[]>("/reminders"),
        requestTool<EmailDraft[]>("/email-drafts"),
        requestTool<ToolActivity[]>("/activity"),
      ]);
      const unavailable = status.tools.filter((tool) => !tool.enabled).map((tool) => tool.id);
      setCapabilities(unavailable.length ? `Not configured: ${unavailable.join(", ")}.` : "All listed integrations are configured.");
      setReminders(nextReminders);
      setDrafts(nextDrafts);
      setActivity(nextActivity);
    } catch (error) {
      setCapabilities(errorMessage(error));
    }
  }
  useEffect(() => { void refreshTools(); }, []);

  async function submitTool(event: FormEvent<HTMLFormElement>, action: () => Promise<void>) {
    event.preventDefault();
    await action();
    await refreshTools();
  }

  async function calculate(event: FormEvent<HTMLFormElement>) {
    await submitTool(event, async () => {
      try {
        const result = await requestTool<{ expression: string; result: string | number }>("/calculate", "POST", { expression: calculation });
        setCalculationResult(`${result.expression} = ${result.result}`);
      } catch (error) { setCalculationResult(errorMessage(error)); }
    });
  }

  async function searchFiles(event: FormEvent<HTMLFormElement>) {
    await submitTool(event, async () => {
      try {
        const result = await requestTool<{ matches: FileMatch[] }>("/file-search", "POST", { query: fileQuery });
        setFileMatches(result.matches);
      } catch (error) { setFileMatches([]); setCapabilities(errorMessage(error)); }
    });
  }

  async function getWeather(event: FormEvent<HTMLFormElement>) {
    await submitTool(event, async () => {
      setWeatherResult("Looking up current conditions…");
      try {
        const result = await requestTool<{ place: string; temperature_c: number; humidity_percent: number; wind_speed_kmh: number; provider: string }>("/weather", "POST", { place: weatherPlace });
        setWeatherResult(`${result.place}: ${result.temperature_c} °C, humidity ${result.humidity_percent}%, wind ${result.wind_speed_kmh} km/h · ${result.provider}`);
      } catch (error) { setWeatherResult(errorMessage(error)); }
    });
  }

  async function searchWeb(event: FormEvent<HTMLFormElement>) {
    await submitTool(event, async () => {
      try {
        const result = await requestTool<{ results: WebResult[] }>("/web-search", "POST", { query: webQuery });
        setWebResults(result.results);
      } catch (error) { setWebResults([]); setCapabilities(errorMessage(error)); }
    });
  }

  async function createReminder(event: FormEvent<HTMLFormElement>) {
    await submitTool(event, async () => {
      try {
        await requestTool("/reminders", "POST", { task: reminderTask, due_at: new Date(reminderDue).toISOString() });
        setReminderTask("");
      } catch (error) { setCapabilities(errorMessage(error)); }
    });
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    await submitTool(event, async () => {
      try {
        await requestTool("/email-drafts", "POST", { recipient, subject, body: draftBody });
        setDraftBody("");
      } catch (error) { setCapabilities(errorMessage(error)); }
    });
  }

  async function previewHomeAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const preview = await requestTool<PreviewResponse>("/home/preview", "POST", { entity_id: entity, action: homeAction });
      setConfirmation(preview.confirmation_token);
      setHomeStatus(`Pending confirmation: ${preview.action} ${preview.entity_id} (expires in ${preview.expires_in_seconds}s).`);
    } catch (error) {
      setConfirmation("");
      setHomeStatus(errorMessage(error));
    }
  }

  async function executeHomeAction() {
    if (!confirmation || !window.confirm("Run this Home Assistant action now?")) return;
    const token = confirmation;
    setConfirmation("");
    try {
      const result = await requestTool<{ action: string; entity_id: string }>("/home/execute", "POST", { confirmation_token: token });
      setHomeStatus(`Completed: ${result.action} ${result.entity_id}.`);
      await refreshTools();
    } catch (error) { setHomeStatus(errorMessage(error)); }
  }

  async function completeReminder(reminder: Reminder) {
    try {
      await requestTool(`/reminders/${reminder.id}/complete`, "PATCH", {});
      await refreshTools();
    } catch (error) { setCapabilities(errorMessage(error)); }
  }

  return (
    <PanelShell title="Tools" onClose={onClose}>
      <Status>{capabilities}</Status>
      <Section title="Calculator">
        <form onSubmit={calculate} className="flex flex-wrap gap-2">
          <input className={`${fieldClass} flex-1`} value={calculation} onChange={(event) => setCalculation(event.target.value)} maxLength={500} required placeholder="(18 * 24) / 3" />
          <button className={primaryClass} type="submit">Calculate</button>
        </form>
        <Status>{calculationResult}</Status>
      </Section>
      <Section title="File search">
        <form onSubmit={searchFiles} className="flex flex-wrap gap-2">
          <input className={`${fieldClass} flex-1`} value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} maxLength={200} minLength={2} required placeholder="Search your configured documents…" />
          <button className={primaryClass} type="submit">Search</button>
        </form>
        {!fileMatches.length && <p className="m-0 text-sm text-white/55">No matching files.</p>}
        {fileMatches.map((match, index) => <p key={`${match.path}-${index}`} className="m-0 text-sm">{match.path}{match.line ? `:${match.line}` : ""} · {match.snippet}</p>)}
      </Section>
      <Section title="Weather">
        <form onSubmit={getWeather} className="flex flex-wrap gap-2">
          <input className={`${fieldClass} flex-1`} value={weatherPlace} onChange={(event) => setWeatherPlace(event.target.value)} maxLength={100} required placeholder="City or place" />
          <button className={primaryClass} type="submit">Get weather</button>
        </form>
        <Status>{weatherResult}</Status>
      </Section>
      <Section title="Web search">
        <form onSubmit={searchWeb} className="flex flex-wrap gap-2">
          <input className={`${fieldClass} flex-1`} value={webQuery} onChange={(event) => setWebQuery(event.target.value)} maxLength={300} minLength={2} required placeholder="Search the web (SearXNG required)" />
          <button className={primaryClass} type="submit">Search</button>
        </form>
        {!webResults.length && <p className="m-0 text-sm text-white/55">No results.</p>}
        {webResults.map((result, index) => (
          <article key={`${result.url}-${index}`} className="text-sm">
            <a href={result.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{result.title || result.url}</a>
            <p className="mb-0 mt-1 text-white/65">{result.snippet}</p>
          </article>
        ))}
      </Section>
      <Section title="Reminders">
        <form onSubmit={createReminder} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <input className={fieldClass} value={reminderTask} onChange={(event) => setReminderTask(event.target.value)} maxLength={500} required placeholder="What should I remind you about?" />
          <input className={fieldClass} value={reminderDue} onChange={(event) => setReminderDue(event.target.value)} type="datetime-local" required />
          <button className={primaryClass} type="submit">Add reminder</button>
        </form>
        <p className="m-0 text-xs text-white/55">Stored locally; no notification service is configured yet.</p>
        {reminders.map((reminder) => (
          <div key={String(reminder.id)} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{reminder.completed ? "Done" : new Date(reminder.due_at).toLocaleString()} · {reminder.task}</span>
            {!reminder.completed && <button className={actionClass} type="button" onClick={() => void completeReminder(reminder)}>Complete</button>}
          </div>
        ))}
      </Section>
      <Section title="Email drafts">
        <form onSubmit={saveDraft} className="grid gap-2">
          <input className={fieldClass} type="email" value={recipient} onChange={(event) => setRecipient(event.target.value)} maxLength={320} required placeholder="Recipient email" />
          <input className={fieldClass} value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={300} required placeholder="Subject" />
          <textarea className={fieldClass} value={draftBody} onChange={(event) => setDraftBody(event.target.value)} maxLength={20000} rows={3} required placeholder="Draft body" />
          <button className={`${primaryClass} justify-self-start`} type="submit">Save draft</button>
        </form>
        <p className="m-0 text-xs text-white/55">Drafts are never sent by Chitti.</p>
        {drafts.map((draft, index) => <p key={`${draft.recipient}-${index}`} className="whitespace-pre-wrap text-sm">To: {draft.recipient} · {draft.subject}{"\n"}{draft.body}</p>)}
      </Section>
      <Section title="Home Assistant">
        <form onSubmit={previewHomeAction} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <input className={fieldClass} value={entity} onChange={(event) => setEntity(event.target.value)} maxLength={255} required placeholder="light.kitchen" />
          <select className={fieldClass} value={homeAction} onChange={(event) => setHomeAction(event.target.value)} aria-label="Home Assistant action">
            <option value="turn_on">Turn on</option><option value="turn_off">Turn off</option>
          </select>
          <button className={primaryClass} type="submit">Preview action</button>
        </form>
        <Status>{homeStatus}</Status>
        <button className={actionClass} type="button" disabled={!confirmation} onClick={() => void executeHomeAction()}>Confirm action</button>
      </Section>
      <Section title="Recent activity">
        {activity.map((entry, index) => (
          <p key={`${String(entry.created_at)}-${index}`} className="m-0 text-sm text-white/70">
            {typeof entry.created_at === "string" ? new Date(entry.created_at).toLocaleString() : ""} · {String(entry.tool || "")} · {String(entry.status || "")} · {String(entry.summary || "")}
          </p>
        ))}
      </Section>
    </PanelShell>
  );
}

interface RecognitionResult {
  0: { transcript: string };
}

interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}

interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionWindow extends Window {
  SpeechRecognition?: new () => RecognitionLike;
  webkitSpeechRecognition?: new () => RecognitionLike;
}

function VoicePanel({
  onClose,
  preferences,
  setPreferences,
  onTranscription,
  onVoiceRecordingChange,
}: {
  onClose: () => void;
  preferences: Preferences;
  setPreferences: (preferences: Preferences) => void;
  onTranscription: (text: string) => void;
  onVoiceRecordingChange: (recording: boolean) => void;
}) {
  const [status, setStatus] = useState("Microphone starts only when you press the button.");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [wakeEnabled, setWakeEnabled] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const recognition = useRef<RecognitionLike | null>(null);
  const wakeEnabledRef = useRef(false);
  const transcriptionLanguage = useRef(preferences.language);
  transcriptionLanguage.current = preferences.language;

  useEffect(() => {
    let active = true;
    void request<VoiceStatus>("/api/voice/status")
      .then((result) => {
        if (active && !result.installed) {
          setStatus("Local Whisper is not installed. Install requirements-voice.txt to enable transcription.");
        }
      })
      .catch((error: unknown) => { if (active) setStatus(errorMessage(error)); });
    const refreshVoices = () => {
      if (!window.speechSynthesis) return;
      setVoices(window.speechSynthesis.getVoices().filter((voice) => /^(en|ta|hi)(-|$)/i.test(voice.lang)));
    };
    refreshVoices();
    window.speechSynthesis?.addEventListener("voiceschanged", refreshVoices);
    return () => {
      active = false;
      window.speechSynthesis?.removeEventListener("voiceschanged", refreshVoices);
    };
  }, [onTranscription]);

  useEffect(() => () => {
    stream.current?.getTracks().forEach((track) => track.stop());
    if (recognition.current) {
      recognition.current.onend = null;
      recognition.current.stop();
    }
    onVoiceRecordingChange(false);
  }, [onVoiceRecordingChange]);

  useEffect(() => {
    if (recording) onVoiceRecordingChange(true);
  }, [onVoiceRecordingChange, recording]);

  function updatePreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPreferences({ ...preferences, [key]: value });
  }

  function stopWakeRecognition() {
    if (!recognition.current) return;
    const active = recognition.current;
    recognition.current = null;
    active.onend = null;
    active.stop();
    onVoiceRecordingChange(false);
  }

  function startWakeRecognition() {
    const windowWithRecognition = window as SpeechRecognitionWindow;
    const Recognition = windowWithRecognition.SpeechRecognition || windowWithRecognition.webkitSpeechRecognition;
    if (!Recognition) {
      setStatus("Wake-word recognition is not supported by this browser.");
      setWakeEnabled(false);
      wakeEnabledRef.current = false;
      return;
    }
    if (!wakeEnabledRef.current || recorder.current?.state === "recording") return;
    try {
      const instance = new Recognition();
      recognition.current = instance;
      instance.continuous = true;
      instance.interimResults = true;
      instance.lang = transcriptionLanguage.current === "ta"
        ? "ta-IN"
        : transcriptionLanguage.current === "hi"
          ? "hi-IN"
          : transcriptionLanguage.current === "auto"
            ? navigator.language || "en-US"
            : "en-US";
      instance.onresult = (event) => {
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          if (event.results[index][0].transcript.toLowerCase().includes("hey chitti")) {
            setStatus("Wake phrase detected. Listening for your request…");
            stopWakeRecognition();
            void startRecording();
            return;
          }
        }
      };
      instance.onerror = () => {
        onVoiceRecordingChange(false);
        setStatus("Wake-word recognition stopped by the browser.");
        setWakeEnabled(false);
        wakeEnabledRef.current = false;
      };
      instance.onend = () => {
        recognition.current = null;
        onVoiceRecordingChange(false);
        if (wakeEnabledRef.current && recorder.current?.state !== "recording") startWakeRecognition();
      };
      instance.start();
      onVoiceRecordingChange(true);
      setStatus("Wake phrase is listening through the browser speech provider.");
    } catch (error) {
      setStatus(errorMessage(error));
      setWakeEnabled(false);
      wakeEnabledRef.current = false;
    }
  }

  async function transcribe(blob: Blob) {
    if (!blob.size) {
      setStatus("No audio was recorded.");
      return;
    }
    setTranscribing(true);
    setStatus("Transcribing with local Whisper…");
    try {
      const language = preferences.language;
      const response = await request<{ text: string; language: string }>(
        `/api/voice/transcribe?language=${encodeURIComponent(language)}`,
        { method: "POST", headers: { "Content-Type": blob.type || "audio/webm" }, body: blob },
      );
      if (!response.text) {
        setStatus("No speech was detected.");
        return;
      }
      onTranscription(response.text);
      setStatus(`Transcribed ${response.language.toUpperCase()}. Review the text, then send when ready.`);
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setTranscribing(false);
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setStatus("This browser does not support microphone recording.");
      return;
    }
    try {
      stopWakeRecognition();
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      const activeRecorder = new MediaRecorder(stream.current);
      recorder.current = activeRecorder;
      chunks.current = [];
      activeRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) chunks.current.push(event.data);
      });
      activeRecorder.addEventListener("stop", () => {
        const blob = new Blob(chunks.current, { type: activeRecorder.mimeType || "audio/webm" });
        stream.current?.getTracks().forEach((track) => track.stop());
        stream.current = null;
        setRecording(false);
        onVoiceRecordingChange(false);
        void transcribe(blob).finally(() => {
          if (wakeEnabledRef.current) startWakeRecognition();
        });
      }, { once: true });
      activeRecorder.start();
      setRecording(true);
      setStatus("Recording locally. Press stop when finished.");
    } catch (error) {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      onVoiceRecordingChange(false);
      const reason = error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microphone permission was denied."
        : errorMessage(error);
      setStatus(reason);
    }
  }

  function stopRecording() {
    if (!recorder.current || recorder.current.state !== "recording") return;
    setTranscribing(true);
    recorder.current.stop();
  }

  return (
    <PanelShell title="Voice" onClose={onClose}>
      <Section title="Audio input">
        <label className="grid gap-2 text-sm text-white/75">
          Transcription language
          <select className={fieldClass} value={preferences.language} onChange={(event) => updatePreference("language", event.target.value as Preferences["language"])}>
            <option value="auto">Auto detect</option><option value="en">English</option><option value="ta">Tamil</option><option value="hi">Hindi</option>
          </select>
        </label>
        <button className={actionClass} type="button" aria-pressed={recording} disabled={transcribing} onClick={() => recording ? stopRecording() : void startRecording()}>
          {recording ? "Stop recording" : transcribing ? "Transcribing…" : "Start recording"}
        </button>
        <Status>{status}</Status>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={wakeEnabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              setWakeEnabled(enabled);
              wakeEnabledRef.current = enabled;
              if (enabled) startWakeRecognition();
              else stopWakeRecognition();
            }}
          />
          Enable “Hey Chitti” wake phrase
        </label>
        <p className="m-0 text-xs text-white/55">Wake phrase is off by default. Browser speech recognition may send audio to the browser provider; push-to-talk transcription is sent to your local Whisper service.</p>
      </Section>
      <Section title="Audio output">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={preferences.speakReplies} onChange={(event) => updatePreference("speakReplies", event.target.checked)} />
          Speak assistant replies
        </label>
        <label className="grid gap-2 text-sm text-white/75">
          System voice
          <select className={fieldClass} value={preferences.voiceURI} onChange={(event) => updatePreference("voiceURI", event.target.value)}>
            <option value="">English default</option>
            {voices.filter((voice, index) => voices.findIndex((item) => item.lang === voice.lang) === index).map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>
            ))}
          </select>
        </label>
        <label className="grid grid-cols-[auto_1fr] items-center gap-3 text-sm">
          Rate
          <input type="range" min="0.7" max="1.3" step="0.1" value={preferences.speechRate} onChange={(event) => updatePreference("speechRate", Number(event.target.value))} />
        </label>
        <button className={actionClass} type="button" onClick={() => window.speechSynthesis?.cancel()}>Stop speaking</button>
      </Section>
    </PanelShell>
  );
}

function VisionPanel({ onClose }: { onClose: () => void }) {
  const [readiness, setReadiness] = useState("Camera stays off until you start it. Images are analyzed on request and are not saved.");
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<VisionResult | null>(null);
  const [image, setImage] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [cameraActive, setCameraActive] = useState(false);
  const [includeOcr, setIncludeOcr] = useState(false);
  const [includeDescription, setIncludeDescription] = useState(false);
  const [ocrLanguage, setOcrLanguage] = useState("eng");
  const [analyzing, setAnalyzing] = useState(false);
  const cameraVideo = useRef<HTMLVideoElement>(null);
  const cameraStream = useRef<MediaStream | null>(null);
  const previewUrlRef = useRef("");

  useEffect(() => {
    let active = true;
    void request<VisionStatus>("/api/vision/status")
      .then((value) => {
        if (!active) return;
        const missing = [];
        if (!value.object_detection.installed) missing.push("YOLO not installed");
        if (!value.ocr.installed) missing.push("OCR package not installed");
        if (!value.scene_description.enabled) missing.push("scene model not configured");
        setReadiness(`${missing.join(" · ") || "Vision ready"}. Images are not saved. Face recognition is disabled.`);
      })
      .catch((error: unknown) => { if (active) setReadiness(errorMessage(error)); });
    return () => {
      active = false;
      cameraStream.current?.getTracks().forEach((track) => track.stop());
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  function clearImage() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrlRef.current = "";
    setPreviewUrl("");
    setImage(null);
    setResult(null);
  }

  function selectImage(file: File | null) {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      clearImage();
      setStatus("Image exceeds the 12 MB limit.");
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setImage(file);
    const objectUrl = URL.createObjectURL(file);
    previewUrlRef.current = objectUrl;
    setPreviewUrl(objectUrl);
    setResult(null);
    setStatus(`Ready to analyze · ${(file.size / 1024).toFixed(1)} KB · not saved`);
    stopCamera();
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("This browser does not support camera access. Choose an image instead.");
      return;
    }
    try {
      const activeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      cameraStream.current = activeStream;
      if (cameraVideo.current) {
        cameraVideo.current.srcObject = activeStream;
        await cameraVideo.current.play();
      }
      setCameraActive(true);
      setStatus("Camera is active. Capture a frame when ready.");
    } catch (error) {
      setStatus(error instanceof DOMException && error.name === "NotAllowedError" ? "Camera permission was denied." : errorMessage(error));
    }
  }

  function stopCamera() {
    cameraStream.current?.getTracks().forEach((track) => track.stop());
    cameraStream.current = null;
    if (cameraVideo.current) cameraVideo.current.srcObject = null;
    setCameraActive(false);
  }

  function captureFrame() {
    const video = cameraVideo.current;
    const width = video?.videoWidth || 0;
    const height = video?.videoHeight || 0;
    if (!video || !width || !height || width * height > 20_000_000) {
      setStatus("Camera frame is not ready or exceeds the 20 megapixel limit.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(video, 0, 0, width, height);
    canvas.toBlob((blob) => {
      if (blob) selectImage(new File([blob], "camera-capture.jpg", { type: "image/jpeg" }));
      else setStatus("Could not capture a frame from the camera.");
    }, "image/jpeg");
  }

  async function analyze() {
    if (!image) return;
    setAnalyzing(true);
    setStatus("Analyzing image…");
    try {
      const params = new URLSearchParams({
        include_ocr: String(includeOcr),
        include_description: String(includeDescription),
        ocr_language: ocrLanguage,
      });
      const analyzed = await request<VisionResult>(`/api/vision/analyze?${params}`, {
        method: "POST",
        headers: { "Content-Type": image.type },
        body: image,
      });
      setResult(analyzed);
      setStatus(`Analysis complete · ${analyzed.width} × ${analyzed.height} · image not saved`);
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <PanelShell title="Vision" onClose={onClose}>
      <p className="m-0 text-sm text-white/60">{readiness}</p>
      <Section title="Camera or image">
        <div className="flex flex-wrap gap-2">
          <button className={primaryClass} type="button" disabled={cameraActive} onClick={() => void startCamera()}>Start camera</button>
          <button className={actionClass} type="button" disabled={!cameraActive} onClick={stopCamera}>Stop camera</button>
          <button className={actionClass} type="button" disabled={!cameraActive} onClick={captureFrame}>Capture frame</button>
          <label className={`${actionClass} cursor-pointer`}>
            Choose image
            <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => selectImage(event.target.files?.[0] || null)} />
          </label>
        </div>
        {cameraActive && <video ref={cameraVideo} autoPlay playsInline muted className="max-h-64 max-w-full rounded-2xl border border-white/15" />}
        {previewUrl && <img src={previewUrl} alt="Selected image preview" className="max-h-64 max-w-full rounded-2xl border border-white/15 object-contain" />}
        {image && <button type="button" className={actionClass} onClick={clearImage}>Clear image</button>}
      </Section>
      <Section title="Analysis options">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeOcr} onChange={(event) => setIncludeOcr(event.target.checked)} />Read text (OCR)</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeDescription} onChange={(event) => setIncludeDescription(event.target.checked)} />Describe scene</label>
        <label className="grid max-w-xs gap-2 text-sm text-white/75">
          OCR language
          <select className={fieldClass} value={ocrLanguage} onChange={(event) => setOcrLanguage(event.target.value)}>
            <option value="eng">English</option><option value="tam">Tamil</option><option value="hin">Hindi</option>
          </select>
        </label>
        <button type="button" className={primaryClass} disabled={!image || analyzing} onClick={() => void analyze()}>{analyzing ? "Analyzing…" : "Analyze image"}</button>
        <Status>{status}</Status>
        {result && (
          <div className="space-y-3 text-sm">
            <section><h3 className="mb-1 mt-0 font-normal">Objects</h3>
              <ul className="my-0 list-disc pl-5">
                {result.objects.length
                  ? result.objects.map((object, index) => <li key={`${object.label}-${index}`}>{object.label} · {Math.round(object.confidence * 100)}%</li>)
                  : <li>No objects detected.</li>}
              </ul>
            </section>
            {result.ocr_text && <section><h3 className="mb-1 mt-0 font-normal">Text</h3><p className="my-0 whitespace-pre-wrap">{result.ocr_text}</p></section>}
            {result.scene_description && <section><h3 className="mb-1 mt-0 font-normal">Scene</h3><p className="my-0">{result.scene_description}</p></section>}
            {result.warnings.map((warning, index) => <p key={index} className="my-0">Unavailable · {warning}</p>)}
          </div>
        )}
      </Section>
      <p className="m-0 text-xs text-white/55">Face recognition is disabled. Encrypted, opt-in family enrollment is not implemented.</p>
    </PanelShell>
  );
}

function SettingsPanel({
  onClose,
  preferences,
  setPreferences,
  mode,
  setMode,
}: {
  onClose: () => void;
  preferences: Preferences;
  setPreferences: (preferences: Preferences) => void;
  mode: Preferences["defaultMode"];
  setMode: (mode: Preferences["defaultMode"]) => void;
}) {
  const [status, setStatus] = useState("");
  const [systemRows, setSystemRows] = useState<Array<[string, string]>>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    let active = true;
    void request<SettingsStatus>("/api/settings/status")
      .then((value) => {
        if (!active) return;
        const configuredTools = value.tools.filter((tool) => tool.enabled).length;
        setSystemRows([
          ["Chat model", value.model.name],
          ["Knowledge", `${value.knowledge.indexed_chunks} indexed chunks`],
          ["Tools", `${configuredTools}/${value.tools.length} available`],
          ["Voice transcription", value.voice.installed ? `Ready · ${value.voice.model}` : "Optional engine not installed"],
          ["Object detection", value.vision.object_detection.installed ? "Ready" : "Optional engine not installed"],
          ["OCR", value.vision.ocr.installed ? "Ready" : "Optional engine not installed"],
          ["Scene description", value.vision.scene_description.enabled ? "Configured" : "Not configured"],
          ["Authentication", value.authentication ? "Enabled" : "Disabled"],
        ]);
        setStatus("System status updated.");
      })
      .catch((error: unknown) => { if (active) setStatus(errorMessage(error)); });
    const refreshVoices = () => {
      if (window.speechSynthesis) {
        setVoices(window.speechSynthesis.getVoices().filter((voice) => /^(en|ta|hi)(-|$)/i.test(voice.lang)));
      }
    };
    refreshVoices();
    window.speechSynthesis?.addEventListener("voiceschanged", refreshVoices);
    return () => {
      active = false;
      window.speechSynthesis?.removeEventListener("voiceschanged", refreshVoices);
    };
  }, []);

  function changePreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPreferences({ ...preferences, [key]: value });
  }

  function resetPreferences() {
    setMode(preferenceDefaults.defaultMode);
    setPreferences({ ...preferenceDefaults });
    setStatus("Preferences reset.");
  }

  return (
    <PanelShell title="Settings" onClose={onClose}>
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Assistant preferences">
          <label className="grid gap-2 text-sm text-white/70">
            Default response mode
            <select className={fieldClass} value={mode} onChange={(event) => setMode(event.target.value as Preferences["defaultMode"])}>
              <option value="reflex">Reflex</option><option value="deliberate">Deliberate</option><option value="deep_research">Deep Research</option>
            </select>
          </label>
          <label className="grid gap-2 text-sm text-white/70">
            Voice transcription language
            <select className={fieldClass} value={preferences.language} onChange={(event) => changePreference("language", event.target.value as Preferences["language"])}>
              <option value="auto">Auto detect</option><option value="en">English</option><option value="ta">Tamil</option><option value="hi">Hindi</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={preferences.speakReplies} onChange={(event) => changePreference("speakReplies", event.target.checked)} />Speak replies</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={preferences.showAvatar} onChange={(event) => changePreference("showAvatar", event.target.checked)} />Show avatar</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={preferences.showModelLabel} onChange={(event) => changePreference("showModelLabel", event.target.checked)} />Show model used on replies</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={preferences.autoSummary} onChange={(event) => changePreference("autoSummary", event.target.checked)} />Summarize older conversation (requires AUTO_SUMMARY=true on the server)</label>
          <label className="grid gap-2 text-sm text-white/70">
            System voice
            <select className={fieldClass} value={preferences.voiceURI} onChange={(event) => changePreference("voiceURI", event.target.value)}>
              <option value="">English default</option>
              {voices.filter((voice, index) => voices.findIndex((item) => item.lang === voice.lang) === index).map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm text-white/70">
            Speech rate
            <input type="range" min="0.7" max="1.3" step="0.1" value={preferences.speechRate} onChange={(event) => changePreference("speechRate", Number(event.target.value))} />
          </label>
          <button className={actionClass} type="button" onClick={resetPreferences}>Reset preferences</button>
        </Section>
        <Section title="System status">
          <dl className="grid grid-cols-[minmax(110px,.55fr)_1fr] gap-x-3 gap-y-2 text-sm">
            {systemRows.map(([label, value]) => <div key={label} className="contents"><dt className="text-white/55">{label}</dt><dd className="m-0 break-words">{value}</dd></div>)}
          </dl>
          <p className="m-0 text-xs text-white/55">Provider credentials and endpoint URLs are not shown here.</p>
          <p className="m-0 text-xs text-white/55">Local SQLite data is not encrypted. This service has no authentication; do not expose it publicly.</p>
        </Section>
      </div>
      <Status>{status}</Status>
    </PanelShell>
  );
}

interface DailyHeadline {
  title: string;
  source: string;
  link: string;
  published_at: string;
}

interface DailyResponse {
  date: string;
  weekday: string;
  time: string;
  timezone: string;
  news: {
    india: DailyHeadline[];
    world: DailyHeadline[];
    tech: DailyHeadline[];
  };
  updated_at: string;
  error?: string;
}

function TodayPanel({ onClose }: { onClose: () => void }) {
  const [today, setToday] = useState<DailyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setToday(await request<DailyResponse>("/api/today"));
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const groups: Array<{ key: keyof DailyResponse["news"]; title: string }> = [
    { key: "india", title: "India" },
    { key: "world", title: "World" },
    { key: "tech", title: "Tech" },
  ];

  function publishedTime(value: string) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: today?.timezone,
    }).format(date);
  }

  const updatedTime = today?.updated_at
    ? new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: today.timezone,
      }).format(new Date(today.updated_at))
    : "—";

  return (
    <PanelShell title="Today" onClose={onClose}>
      <Section title="Date and time">
        <p className="m-0 text-lg">{today ? `${today.weekday}, ${today.date}` : "Today's updates"}</p>
        {today && <p className="m-0 text-sm text-white/65">{today.time} · {today.timezone}</p>}
      </Section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-xs text-white/55">Updated at {updatedTime}</p>
        <button className={actionClass} type="button" disabled={loading} onClick={() => void refresh()}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {loading && <Status>Loading today's updates…</Status>}
      {error && <Status>Couldn't load today's updates. {error}</Status>}
      {today?.error && <Status>News is unavailable right now. {today.error}</Status>}
      {today && groups.map((group) => (
        <Section key={group.key} title={group.title}>
          {!today.news[group.key].length && (
            <p className="m-0 text-sm text-white/60">No headlines are available for this category right now.</p>
          )}
          {today.news[group.key].map((headline, index) => (
            <article key={`${headline.link}-${index}`} className="space-y-1 border-b border-white/10 pb-3 last:border-0 last:pb-0">
              <p className="m-0 text-xs text-white/55">{headline.source}</p>
              <a href={headline.link} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-2">
                {headline.title}
              </a>
              {publishedTime(headline.published_at) && (
                <p className="m-0 text-xs text-white/50">{publishedTime(headline.published_at)}</p>
              )}
            </article>
          ))}
        </Section>
      ))}
    </PanelShell>
  );
}

export default function ChatModules(props: ChatModulesProps) {
  switch (props.panel) {
    case "memory": return <MemoryPanel onClose={props.onClose} />;
    case "sources": return <SourcesPanel onClose={props.onClose} />;
    case "tools": return <ToolsPanel onClose={props.onClose} />;
    case "today": return <TodayPanel onClose={props.onClose} />;
    case "voice": return <VoicePanel onClose={props.onClose} preferences={props.preferences} setPreferences={props.setPreferences} onTranscription={props.onTranscription} onVoiceRecordingChange={props.onVoiceRecordingChange} />;
    case "vision": return <VisionPanel onClose={props.onClose} />;
    case "settings": return <SettingsPanel onClose={props.onClose} preferences={props.preferences} setPreferences={props.setPreferences} mode={props.mode} setMode={props.setMode} />;
  }
}
