import { FormEvent, KeyboardEvent, memo, useCallback, useEffect, useRef, useState } from "react";
import { ChatMode, ChatResponse, ChatSource, HistoryMessage, ReasoningSummary, errorMessage, jsonRequest, request } from "./api";
import Background from "./Background";
import ChatModules from "./ChatModules";
import Navigation, { PanelName } from "./Navigation";
import Avatar from "./components/Avatar";
import { persistPreferences, Preferences, readPreferences } from "./preferences";
import { cleanSpeechText, extractCompleteSentences, mouthForLetter, MouthShape, speechWords, splitSpeechText } from "./speechPlan";

interface ChatEntry {
  id: number;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  reasoning?: ReasoningSummary | null;
  modelUsed?: string;
}

interface ConversationSummary {
  summary: string;
  coveredCount: number;
  fingerprint: string;
}

const summaryStorageKey = "chitti.conversation.summary.v1";
const summaryRequestPrefix = "__CHITTI_AUTO_SUMMARY_V1__";
const summaryThreshold = 12;
const summaryRecentMessages = 6;

function historyFingerprint(history: HistoryMessage[]): string {
  let hash = 2166136261;
  const text = JSON.stringify(history);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function readConversationSummary(): ConversationSummary | null {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(summaryStorageKey) || "null");
    if (
      typeof stored === "object"
      && stored !== null
      && "summary" in stored
      && typeof stored.summary === "string"
      && "coveredCount" in stored
      && typeof stored.coveredCount === "number"
      && Number.isInteger(stored.coveredCount)
      && "fingerprint" in stored
      && typeof stored.fingerprint === "string"
    ) {
      return stored as ConversationSummary;
    }
  } catch {
    return null;
  }
  return null;
}

function validConversationSummary(
  history: HistoryMessage[],
  summary: ConversationSummary | null,
): ConversationSummary | null {
  if (!summary || summary.coveredCount <= 0 || summary.coveredCount > history.length) return null;
  return historyFingerprint(history.slice(0, summary.coveredCount)) === summary.fingerprint ? summary : null;
}

const modeLabels: Array<{ value: ChatMode; label: string }> = [
  { value: "reflex", label: "Reflex" },
  { value: "deliberate", label: "Deliberate" },
  { value: "deep_research", label: "Research" },
];

function queryMode(): ChatMode | null {
  const value = new URLSearchParams(window.location.search).get("mode");
  if (value === "research") return "deep_research";
  return value === "reflex" || value === "deliberate" || value === "deep_research" ? value : null;
}

function SourceList({ sources }: { sources: ChatSource[] }) {
  if (!sources.length) return null;
  return (
    <p className="mt-2 text-xs text-white/65">
      Retrieved from:{" "}
      {sources.map((source, index) => (
        <span key={`${source.source}-${index}`}>
          {index > 0 && ", "}
          {source.url?.startsWith("https://") ? (
            <a href={source.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              {source.title || source.source}
            </a>
          ) : source.source}
          {source.license && ` (${source.license})`}
        </span>
      ))}
    </p>
  );
}

function Reasoning({ reasoning }: { reasoning: ReasoningSummary }) {
  const [open, setOpen] = useState(false);
  const rows: Array<[string, string]> = [
    ["Plan", reasoning.plan_summary || "Not available."],
    ["Risk", reasoning.risk_level || "Unknown"],
    ["Estimated time", Number.isInteger(reasoning.estimated_seconds) ? `${reasoning.estimated_seconds}s` : "Unknown"],
    ["Estimated cost", reasoning.cost_estimate || "Unavailable"],
    ["Planned tools", reasoning.planned_tools?.length ? reasoning.planned_tools.join(", ") : "None"],
    ["Tools", reasoning.tools_used?.length ? reasoning.tools_used.join(", ") : "None"],
    ["Sources", reasoning.sources?.length ? reasoning.sources.join(", ") : "None"],
    ["Matched note", reasoning.matched_notes?.length ? reasoning.matched_notes.join("\n") : "None"],
    ["Model-estimated confidence", reasoning.confidence || "Unknown"],
    ["Review", reasoning.critique_summary || "Not available."],
    ["Revisions", String(reasoning.revision_count || 0)],
  ];
  return (
    <div className="mt-2">
      <button type="button" className="rounded-full border border-white/20 px-3 py-1 text-xs hover:bg-white/10" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        Why?
      </button>
      {open && (
        <dl className="mt-2 grid grid-cols-[minmax(90px,.3fr)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-2xl border border-white/15 bg-black/45 p-3 text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-white/55">{label}</dt>
              <dd className="m-0 whitespace-pre-line break-words">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

const ChatMessage = memo(function ChatMessage({ entry, showModelLabel }: { entry: ChatEntry; showModelLabel: boolean }) {
  if (entry.role === "assistant" && !entry.content && !entry.sources && !entry.reasoning) return null;
  return (
    <article className={`animate-fade-rise max-w-[min(88%,760px)] ${entry.role === "user" ? "ml-auto text-right" : "mr-auto text-left"}`}>
      <p className="mb-1 text-[10px] uppercase tracking-[.1em] text-white/55">{entry.role === "user" ? "YOU" : "CHITTI"}</p>
      <p className={`m-0 whitespace-pre-wrap break-words px-4 py-3 text-sm leading-relaxed ${
        entry.role === "user"
          ? "inline-block rounded-[22px] bg-white text-black"
          : "rounded-[22px] border border-white/20 bg-black/65 text-white"
      }`}>
        {entry.content}
      </p>
      {entry.role === "assistant" && showModelLabel && entry.modelUsed && (
        <p className="mt-1 mb-0 text-[10px] text-white/40">{entry.modelUsed}</p>
      )}
      {entry.role === "assistant" && entry.sources && <SourceList sources={entry.sources} />}
      {entry.role === "assistant" && entry.reasoning && <Reasoning reasoning={entry.reasoning} />}
    </article>
  );
});

async function streamChat(
  body: unknown,
  onToken: (token: string) => void,
): Promise<{ response: ChatResponse; model: string | null; route: string | null }> {
  const response = await fetch("/api/chat/stream", jsonRequest(body));
  if (!response.ok || !response.body) {
    let detail = "Streaming is unavailable.";
    try {
      const payload: unknown = await response.json();
      if (typeof payload === "object" && payload !== null && "detail" in payload && typeof payload.detail === "string") {
        detail = payload.detail;
      }
    } catch {
      // Fall back to the existing non-streaming route below.
    }
    throw new Error(detail);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ChatResponse | null = null;
  const handleEvent = (rawEvent: string) => {
    const data = rawEvent.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data) return;
    const event: unknown = JSON.parse(data);
    if (typeof event !== "object" || event === null || !("type" in event)) {
      throw new Error("The streaming response was invalid.");
    }
    if (event.type === "token" && "token" in event && typeof event.token === "string") {
      onToken(event.token);
    } else if (event.type === "complete" && "response" in event) {
      result = event.response as ChatResponse;
    } else if (event.type === "error" && "detail" in event && typeof event.detail === "string") {
      throw new Error(event.detail);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const eventText = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || "\n\n";
        buffer = buffer.slice(boundary + separator.length);
        handleEvent(eventText);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (!result) throw new Error("The streaming response ended before the reply was complete.");
  return {
    response: result,
    model: response.headers.get("X-CHITTI-Model"),
    route: response.headers.get("X-CHITTI-Route"),
  };
}

export default function ChatPage() {
  const [preferences, setPreferences] = useState<Preferences>(() => readPreferences());
  const [mode, setMode] = useState<ChatMode>(() => queryMode() || readPreferences().defaultMode);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [history, setHistory] = useState<HistoryMessage[]>([]);
  const [conversationSummary, setConversationSummary] = useState<ConversationSummary | null>(() => readConversationSummary());
  const [panel, setPanel] = useState<PanelName | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [preferenceError, setPreferenceError] = useState("");
  const [inputHeight, setInputHeight] = useState(44);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [avatarSpeaking, setAvatarSpeaking] = useState(false);
  const [avatarMouth, setAvatarMouth] = useState<MouthShape>("neutral");
  const [avatarWordTick, setAvatarWordTick] = useState(0);
  const conversationRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(0);
  const conversationSummaryRef = useRef(conversationSummary);
  const summaryTaskRunning = useRef(false);
  const avatarGreeted = useRef(false);
  const lastReplyRef = useRef("");
  const speechGeneration = useRef(0);
  const speechSessionActive = useRef(false);
  const speechWarmed = useRef(false);
  const speechQueue = useRef<Array<{
    text: string;
    voice: SpeechSynthesisVoice | null;
    lang: string;
    rate: number;
  }>>([]);
  const speechQueueRunning = useRef(false);
  const speechQueueComplete = useRef(false);
  const speechPump = useRef<() => void>(() => undefined);
  const speechCompletedText = useRef("");
  const mouthTimer = useRef<number | null>(null);
  const speechSafetyTimer = useRef<number | null>(null);
  const lastEntry = entries[entries.length - 1];
  const avatarThinking = loading && lastEntry?.role === "assistant" && !lastEntry.content;

  const clearMouthTimer = useCallback(() => {
    if (mouthTimer.current !== null) window.clearTimeout(mouthTimer.current);
    mouthTimer.current = null;
  }, []);

  const clearSpeechSafetyTimer = useCallback(() => {
    if (speechSafetyTimer.current !== null) window.clearTimeout(speechSafetyTimer.current);
    speechSafetyTimer.current = null;
  }, []);

  const warmSpeech = useCallback(() => {
    if (speechWarmed.current || !("speechSynthesis" in window)) return;
    speechWarmed.current = true;
    const voices = window.speechSynthesis.getVoices();
    const selectedVoice = voices.find((voice) => voice.voiceURI === preferences.voiceURI);
    const englishVoice = voices.find((voice) => /^en-IN(?:-|$)/iu.test(voice.lang))
      || voices.find((voice) => /^en-US(?:-|$)/iu.test(voice.lang))
      || voices.find((voice) => /^en(?:-|$)/iu.test(voice.lang));
    const utterance = new SpeechSynthesisUtterance(" ");
    utterance.voice = selectedVoice || englishVoice || null;
    utterance.lang = utterance.voice?.lang || "en-US";
    utterance.volume = 0;
    window.speechSynthesis.speak(utterance);
  }, [preferences.voiceURI]);

  const stopSpeech = useCallback((resetCompletedText = true) => {
    speechGeneration.current += 1;
    speechSessionActive.current = false;
    speechQueue.current = [];
    speechQueueRunning.current = false;
    speechQueueComplete.current = false;
    speechPump.current = () => undefined;
    if (resetCompletedText) speechCompletedText.current = "";
    clearMouthTimer();
    clearSpeechSafetyTimer();
    setAvatarSpeaking(false);
    setAvatarMouth("neutral");
    window.speechSynthesis?.cancel();
  }, [clearMouthTimer, clearSpeechSafetyTimer]);

  const speakText = useCallback((displayText: string, append = false, complete = true) => {
    const text = cleanSpeechText(displayText);
    if (!("speechSynthesis" in window)) return;
    if (!text) {
      if (append && complete) {
        speechQueueComplete.current = true;
        speechPump.current();
      }
      return;
    }

    if (!append) {
      stopSpeech();
      warmSpeech();
    }
    const generation = speechGeneration.current;
    const chunks = splitSpeechText(text).map((chunk) => chunk.text.trim()).filter(Boolean);
    if (!chunks.length) return;
    const voices = window.speechSynthesis.getVoices();
    const selectedVoice = voices.find((voice) => voice.voiceURI === preferences.voiceURI);
    const containsTamil = /[\u0B80-\u0BFF]/u.test(text);
    const selectedTamilVoice = selectedVoice && /^ta(?:-|$)/iu.test(selectedVoice.lang) ? selectedVoice : undefined;
    const selectedEnglishVoice = selectedVoice && /^en(?:-|$)/iu.test(selectedVoice.lang) ? selectedVoice : undefined;
    const tamilVoice = voices.find((voice) => /^ta(?:-|$)/iu.test(voice.lang));
    const englishVoice = voices.find((voice) => /^en-IN(?:-|$)/iu.test(voice.lang))
      || voices.find((voice) => /^en-US(?:-|$)/iu.test(voice.lang))
      || voices.find((voice) => /^en(?:-|$)/iu.test(voice.lang));
    const voice = containsTamil
      ? selectedTamilVoice || tamilVoice || englishVoice
      : selectedEnglishVoice || englishVoice;
    speechQueue.current.push(...chunks.map((chunkText) => ({
      text: chunkText,
      voice: voice || null,
      lang: voice?.lang || "en-US",
      rate: preferences.speechRate,
    })));
    speechQueueComplete.current = complete;
    speechSessionActive.current = true;

    const pump = () => {
      if (generation !== speechGeneration.current || speechQueueRunning.current) return;
      const chunk = speechQueue.current.shift();
      if (!chunk) {
        if (speechQueueComplete.current) {
          speechSessionActive.current = false;
          clearSpeechSafetyTimer();
          clearMouthTimer();
          setAvatarMouth("neutral");
          setAvatarSpeaking(false);
        }
        return;
      }

      speechQueueRunning.current = true;
      clearMouthTimer();
      clearSpeechSafetyTimer();
      const utterance = new SpeechSynthesisUtterance(chunk.text);
      utterance.voice = chunk.voice;
      utterance.lang = chunk.lang;
      utterance.rate = chunk.rate;
      let receivedBoundary = false;
      const words = speechWords(chunk.text);

      utterance.onstart = () => {
        if (generation !== speechGeneration.current) return;
        clearSpeechSafetyTimer();
        setAvatarSpeaking(true);
        let cycle = 0;
        const cycleMouth = () => {
          if (generation !== speechGeneration.current || receivedBoundary) return;
          setAvatarMouth((["talk", "open", "ah", "neutral"] as MouthShape[])[cycle % 4]);
          cycle += 1;
          mouthTimer.current = window.setTimeout(cycleMouth, 75 + Math.random() * 65);
        };
        cycleMouth();
      };

      utterance.onboundary = (event) => {
        if (generation !== speechGeneration.current) return;
        const word = words.find((candidate) => (
          event.charIndex >= candidate.start && event.charIndex < candidate.end
        ));
        if (!word) return;
        receivedBoundary = true;
        setAvatarWordTick((current) => current + 1);
        clearMouthTimer();
        const letters = Array.from(word.text);
        const duration = Math.max(130, (letters.length * 75) / Math.max(0.7, utterance.rate));
        const stepDuration = Math.max(50, duration / Math.max(1, letters.length));
        const wordStartedAt = Date.now();
        const animateWord = () => {
          if (generation !== speechGeneration.current) return;
          const letterIndex = Math.min(letters.length - 1, Math.floor((Date.now() - wordStartedAt) / stepDuration));
          setAvatarMouth(mouthForLetter(word.text, letterIndex));
          if (Date.now() - wordStartedAt >= duration) {
            clearMouthTimer();
            setAvatarMouth("neutral");
          }
        };
        setAvatarMouth("neutral");
        mouthTimer.current = window.setTimeout(() => {
          animateWord();
          mouthTimer.current = window.setInterval(animateWord, 50);
        }, 25);
      };

      utterance.onend = () => {
        if (generation !== speechGeneration.current) return;
        speechQueueRunning.current = false;
        speechCompletedText.current = cleanSpeechText(`${speechCompletedText.current} ${chunk.text}`);
        clearMouthTimer();
        setAvatarMouth("neutral");
        pump();
      };

      utterance.onerror = () => {
        if (generation !== speechGeneration.current) return;
        speechGeneration.current += 1;
        speechSessionActive.current = false;
        speechQueue.current = [];
        speechQueueRunning.current = false;
        clearMouthTimer();
        clearSpeechSafetyTimer();
        setAvatarMouth("neutral");
        setAvatarSpeaking(false);
      };

      window.speechSynthesis.speak(utterance);
    };

    speechPump.current = pump;
    pump();
  }, [clearMouthTimer, clearSpeechSafetyTimer, preferences.speechRate, preferences.voiceURI, stopSpeech, warmSpeech]);

  useEffect(() => {
    const poll = window.setInterval(() => {
      if (!("speechSynthesis" in window)) return;
      const synthesis = window.speechSynthesis;
      if (synthesis.speaking) {
        clearSpeechSafetyTimer();
        return;
      }
      if (synthesis.pending && speechSessionActive.current) {
        clearMouthTimer();
        clearSpeechSafetyTimer();
        setAvatarMouth("neutral");
        setAvatarSpeaking(true);
        return;
      }
      if (!speechSessionActive.current || synthesis.pending || speechSafetyTimer.current !== null) return;
      speechSafetyTimer.current = window.setTimeout(() => {
        speechSafetyTimer.current = null;
        if (window.speechSynthesis.speaking || window.speechSynthesis.pending || !speechSessionActive.current) return;
        speechQueueRunning.current = false;
        if (speechQueue.current.length) {
          speechPump.current();
          return;
        }
        clearMouthTimer();
        setAvatarMouth("neutral");
        setAvatarSpeaking(false);
        if (speechQueueComplete.current) {
          speechGeneration.current += 1;
          speechSessionActive.current = false;
        }
      }, 450);
    }, 150);
    return () => {
      window.clearInterval(poll);
      speechGeneration.current += 1;
      speechSessionActive.current = false;
      clearSpeechSafetyTimer();
      clearMouthTimer();
      window.speechSynthesis?.cancel();
    };
  }, [clearMouthTimer, clearSpeechSafetyTimer]);

  const activateAvatar = useCallback(() => {
    if (speechSessionActive.current || window.speechSynthesis?.speaking) {
      stopSpeech();
    } else if (!avatarGreeted.current) {
      avatarGreeted.current = true;
      speakText("Hi, I'm CHITTI. How can I help?");
    } else if (lastReplyRef.current) {
      speakText(lastReplyRef.current);
    }
  }, [speakText, stopSpeech]);

  const renderAvatar = (placement: "desktop" | "mobile") => (
    <Avatar
      placement={placement}
      thinking={avatarThinking}
      listening={voiceRecording}
      speaking={avatarSpeaking}
      mouthShape={avatarMouth}
      wordTick={avatarWordTick}
      onActivate={activateAvatar}
    />
  );

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const validPanels: PanelName[] = ["memory", "sources", "tools", "today", "voice", "vision", "settings"];
    if (validPanels.includes(hash as PanelName)) setPanel(hash as PanelName);
  }, []);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }, [entries, loading]);

  useEffect(() => {
    conversationSummaryRef.current = conversationSummary;
  }, [conversationSummary]);

  function updatePreferences(next: Preferences) {
    setPreferences(next);
    try {
      persistPreferences(next);
      setPreferenceError("");
    } catch {
      setPreferenceError("Browser storage is unavailable; preferences will reset when this tab closes.");
    }
  }

  function selectMode(nextMode: ChatMode) {
    setMode(nextMode);
    updatePreferences({ ...preferences, defaultMode: nextMode });
  }

  function openPanel(nextPanel: PanelName) {
    const next = panel === nextPanel ? null : nextPanel;
    setPanel(next);
    window.history.replaceState(null, "", next ? `/chat#${next}` : "/chat");
  }

  function addEntry(entry: Omit<ChatEntry, "id">) {
    nextId.current += 1;
    setEntries((current) => [...current, { ...entry, id: nextId.current }]);
  }

  async function refreshConversationSummary(fullHistory: HistoryMessage[]) {
    if (!preferences.autoSummary || summaryTaskRunning.current || fullHistory.length < summaryThreshold) return;
    const targetCount = fullHistory.length - summaryRecentMessages;
    const previous = validConversationSummary(fullHistory, conversationSummaryRef.current);
    if (previous && targetCount - previous.coveredCount < summaryRecentMessages) return;

    const messagesToSummarize = previous
      ? fullHistory.slice(previous.coveredCount, targetCount)
      : fullHistory.slice(0, targetCount);
    const source = [
      previous ? `Existing summary:\n${previous.summary}` : "",
      ...messagesToSummarize.map((item) => `${item.role}: ${item.content}`),
    ].filter(Boolean).join("\n");
    const summaryInput = source.slice(0, 7_800);
    summaryTaskRunning.current = true;
    try {
      const result = await request<ChatResponse>("/api/chat", jsonRequest({
        message: `${summaryRequestPrefix} Summarize the supplied conversation faithfully in at most 140 words.`,
        history: [{ role: "user", content: summaryInput }],
        mode: "reflex",
      }));
      const summaryText = result.reply.trim();
      if (!summaryText || summaryText.split(/\s+/u).length > 150) {
        console.warn("Conversation summary was unavailable; it will be rebuilt on a later turn.");
        return;
      }
      const nextSummary: ConversationSummary = {
        summary: summaryText,
        coveredCount: targetCount,
        fingerprint: historyFingerprint(fullHistory.slice(0, targetCount)),
      };
      conversationSummaryRef.current = nextSummary;
      setConversationSummary(nextSummary);
      try {
        sessionStorage.setItem(summaryStorageKey, JSON.stringify(nextSummary));
      } catch (error) {
        console.warn("Conversation summary could not be saved in this tab.", error);
      }
    } catch (error) {
      console.warn("Conversation summary failed; it will be rebuilt on a later turn.", error);
    } finally {
      summaryTaskRunning.current = false;
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = message.trim();
    if (!content || loading) return;
    stopSpeech();
    if (preferences.speakReplies) warmSpeech();
    setMessage("");
    setInputHeight(44);
    addEntry({ role: "user", content });
    const assistantId = ++nextId.current;
    setEntries((current) => [...current, { id: assistantId, role: "assistant", content: "" }]);
    const normalizedMessage = content.toLowerCase().replace(/[.!?\s]+$/gu, "");
    const isMemoryCommand = normalizedMessage.startsWith("remember this:")
      || normalizedMessage === "forget this"
      || normalizedMessage === "forget that";
    const explicitReplyLanguage = /\b(?:reply|respond|answer)\s+(?:in|using)\s+(?:english|tamil|hindi)\b/iu.test(content);
    const selectedReplyLanguage = preferences.language === "ta"
      ? "Tamil"
      : preferences.language === "hi"
        ? "Hindi"
        : "";
    const requestMessage = selectedReplyLanguage && !isMemoryCommand && !explicitReplyLanguage
      ? `Reply in ${selectedReplyLanguage}: ${content}`
      : content;
    const storedSummary = preferences.autoSummary
      ? validConversationSummary(history, conversationSummaryRef.current)
      : null;
    if (preferences.autoSummary && conversationSummaryRef.current && !storedSummary) {
      conversationSummaryRef.current = null;
      setConversationSummary(null);
      try {
        sessionStorage.removeItem(summaryStorageKey);
      } catch {
        console.warn("A stale conversation summary could not be cleared from this tab.");
      }
    }
    const requestHistory = storedSummary
      ? [
        { role: "user" as const, content: `Conversation summary (earlier messages): ${storedSummary.summary}` },
        ...history.slice(storedSummary.coveredCount).slice(-19),
      ]
      : history.slice(-20);
    const requestBody = {
      message: requestMessage,
      history: requestHistory,
      mode,
    };
    const updateAssistant = (update: Partial<ChatEntry>) => {
      setEntries((current) => {
        const index = current.length - 1;
        if (index < 0 || current[index].id !== assistantId || current[index].role !== "assistant") return current;
        const next = [...current];
        next[index] = { ...next[index], ...update };
        return next;
      });
    };
    setLoading(true);
    let streamedReply = "";
    let speechScanOffset = 0;
    let queuedSpeechText = "";
    let streamFailed = false;
    let modelUsed: string | null = null;
    try {
      let data: ChatResponse;
      try {
        const streamed = await streamChat(requestBody, (token) => {
          streamedReply += token;
          setEntries((current) => {
            const index = current.length - 1;
            if (index < 0 || current[index].id !== assistantId || current[index].role !== "assistant") return current;
            const next = [...current];
            next[index] = { ...next[index], content: next[index].content + token };
            return next;
          });
          if (preferences.speakReplies) {
            const completed = extractCompleteSentences(streamedReply, speechScanOffset);
            speechScanOffset = completed.nextOffset;
            completed.sentences.forEach((sentence) => {
              const speechText = cleanSpeechText(sentence);
              if (!speechText) return;
              queuedSpeechText = cleanSpeechText(`${queuedSpeechText} ${speechText}`);
              speakText(speechText, true, false);
            });
          }
        });
        data = streamed.response;
        if (streamed.model) {
          modelUsed = `${streamed.route === "fast" ? "Fast" : "Main"} · ${streamed.model}`;
        }
      } catch {
        streamFailed = true;
        if (preferences.speakReplies) stopSpeech(false);
        updateAssistant({ content: "", sources: undefined, reasoning: undefined });
        data = await request<ChatResponse>("/api/chat", jsonRequest(requestBody));
      }
      updateAssistant({
        content: data.reply,
        sources: data.sources || [],
        reasoning: data.reasoning || null,
        modelUsed: modelUsed || undefined,
      });
      const nextHistory: HistoryMessage[] = [
        ...history,
        { role: "user", content },
        { role: "assistant", content: data.reply },
      ];
      setHistory(nextHistory);
      void refreshConversationSummary(nextHistory);
      lastReplyRef.current = data.reply;
      if (preferences.speakReplies) {
        const finalSpeechText = cleanSpeechText(data.reply);
        if (streamFailed) {
          queuedSpeechText = speechCompletedText.current;
        } else if (!finalSpeechText.startsWith(queuedSpeechText)) {
          stopSpeech(false);
          queuedSpeechText = speechCompletedText.current;
        }
        const remainingSpeechText = finalSpeechText.startsWith(queuedSpeechText)
          ? finalSpeechText.slice(queuedSpeechText.length).trim()
          : finalSpeechText;
        speakText(remainingSpeechText, true, true);
      }
    } catch (error) {
      updateAssistant({ content: `I couldn't reach the configured model. ${errorMessage(error)}` });
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function onMessageKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function onMessageChange(value: string, element: HTMLTextAreaElement) {
    setMessage(value);
    element.style.height = "auto";
    const height = Math.min(element.scrollHeight, 150);
    element.style.height = `${height}px`;
    setInputHeight(height);
  }

  const fillTranscription = useCallback((text: string) => {
    setMessage(text);
    if (inputRef.current) {
      inputRef.current.value = text;
      inputRef.current.style.height = "auto";
      const height = Math.min(inputRef.current.scrollHeight, 150);
      inputRef.current.style.height = `${height}px`;
      setInputHeight(height);
    }
    inputRef.current?.focus();
  }, []);

  return (
    <main className="relative flex h-[100svh] min-h-[560px] flex-col overflow-hidden bg-black text-white">
      <Background darken />
      <Navigation chat onOpenPanel={openPanel} />
      <section className="relative z-10 mx-auto mt-[82px] flex min-h-0 w-full max-w-5xl flex-1 flex-col px-3 pb-3 sm:px-6 sm:pb-5">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-white/15 bg-black/50 p-4 shadow-2xl backdrop-blur-md sm:p-7 md:p-9">
          <div className="mb-5 flex shrink-0 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-4">
              {preferences.showAvatar && renderAvatar("desktop")}
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-[.18em] text-white/55">Your assistant</p>
                <h1 className="m-0 font-normal text-[clamp(24px,3vw,34px)] leading-tight">At your service.</h1>
              </div>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[10px] tracking-[.1em] text-white/80">
              <span className="h-1.5 w-1.5 rounded-full bg-white" />
              LOCAL SESSION
            </span>
          </div>

          {panel ? (
            <ChatModules
              key={panel}
              panel={panel}
              onClose={() => {
                setPanel(null);
                window.history.replaceState(null, "", "/chat");
              }}
              preferences={preferences}
              setPreferences={updatePreferences}
              mode={mode}
              setMode={selectMode}
              onTranscription={fillTranscription}
              onVoiceRecordingChange={setVoiceRecording}
            />
          ) : (
            <>
              <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/15 pb-4">
                <span className="text-[10px] uppercase tracking-[.16em] text-white/55">Response mode</span>
                <div className="flex gap-2 rounded-full border border-white/20 bg-white/5 p-1" role="group" aria-label="Response mode">
                  {modeLabels.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      aria-pressed={mode === item.value}
                      onClick={() => selectMode(item.value)}
                      className={`rounded-full border px-3 py-1.5 text-xs transition-colors sm:px-4 ${
                        mode === item.value ? "border-white bg-white text-black" : "border-white/30 bg-transparent text-white hover:bg-white/10"
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div ref={conversationRef} className="min-h-[90px] flex-1 space-y-4 overflow-y-auto py-3 pr-1" aria-live="polite" aria-label="Conversation">
                {!entries.length && (
                  <div className="grid h-full min-h-[120px] place-content-center justify-items-center text-white/65">
                    <span className="text-4xl text-white/75" aria-hidden="true">✳</span>
                    <p className="mt-2">Ready when you are.</p>
                  </div>
                )}
                {entries.map((entry) => <ChatMessage key={entry.id} entry={entry} showModelLabel={preferences.showModelLabel} />)}
                {loading && (
                  <div className="animate-fade-rise w-fit rounded-[22px] border border-white/20 bg-black/65 px-4 py-3 text-sm text-white/70" role="status">
                    Thinking...
                  </div>
                )}
                {preferenceError && <p className="mb-0 mt-2 shrink-0 text-center text-xs text-white/65" role="status">{preferenceError}</p>}
              </div>

              {preferences.showAvatar && renderAvatar("mobile")}
              <form onSubmit={submitMessage} className="mt-3 flex min-h-[58px] shrink-0 items-end gap-2 rounded-full border border-white/20 bg-white/10 p-2 pl-4 backdrop-blur-md transition-shadow focus-within:border-white/45 focus-within:shadow-[0_0_20px_rgba(255,255,255,0.18)]">
                <label className="sr-only" htmlFor="chat-message">Message Chitti</label>
                <textarea
                  ref={inputRef}
                  id="chat-message"
                  name="message"
                  rows={1}
                  required
                  maxLength={8000}
                  value={message}
                  onChange={(event) => onMessageChange(event.target.value, event.currentTarget)}
                  onKeyDown={onMessageKeyDown}
                  placeholder="Ask Chitti anything…"
                  style={{ height: inputHeight }}
                  className="chat-message-input max-h-[150px] min-h-[44px] flex-1 resize-none self-center bg-transparent py-3 text-sm text-white outline-none placeholder:text-white/55"
                />
                <button
                  type="submit"
                  aria-label="Send message"
                  title="Send message"
                  disabled={loading}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white text-black transition-shadow hover:shadow-[0_0_24px_rgba(255,255,255,.5)] disabled:cursor-wait disabled:opacity-55"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M4 12 20 4l-5 16-3-7-8-1Zm8 1 8-9" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                  </svg>
                </button>
              </form>
              <p className="mb-0 mt-2 shrink-0 text-center text-[10px] text-white/50">
                Answers are generated by your configured model and may need verification.
              </p>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
