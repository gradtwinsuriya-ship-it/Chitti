const form = document.querySelector("#chat-form");
const input = document.querySelector("#message");
const conversation = document.querySelector("#conversation");
const sendButton = document.querySelector("#send-button");
const modeButtons = [...document.querySelectorAll(".mode-button")];
const memoryPanel = document.querySelector("#memory-panel");
const memoryStatus = document.querySelector("#memory-status");
const knowledgePanel = document.querySelector("#knowledge-panel");
const knowledgeStatus = document.querySelector("#knowledge-status");
const toolsPanel = document.querySelector("#tools-panel");
const voicePanel = document.querySelector("#voice-panel");
const voiceStatus = document.querySelector("#voice-status");
const settingsPanel = document.querySelector("#settings-panel");
const settingsStatus = document.querySelector("#settings-status");
let pendingHomeConfirmation = "";
let mediaRecorder = null;
let recordingStream = null;
let audioChunks = [];
let wakeRecognition = null;
let wakeEnabled = false;

const preferenceDefaults = { defaultMode: "reflex", language: "auto", speakReplies: false, speechRate: 1, voiceURI: "" };
const preferenceKey = "chitti.dashboard.preferences.v1";
function readPreferences() {
  try {
    const stored = JSON.parse(localStorage.getItem(preferenceKey) || "{}");
    const savedMode = stored.defaultMode === "speed"
      ? "reflex"
      : stored.defaultMode === "deep"
        ? "deliberate"
        : stored.defaultMode;
    return {
      defaultMode: ["reflex", "deliberate", "deep_research"].includes(savedMode)
        ? savedMode
        : preferenceDefaults.defaultMode,
      language: ["auto", "en", "ta", "hi"].includes(stored.language) ? stored.language : preferenceDefaults.language,
      speakReplies: Boolean(stored.speakReplies),
      speechRate: Math.min(1.3, Math.max(0.7, Number(stored.speechRate) || 1)),
      voiceURI: typeof stored.voiceURI === "string" ? stored.voiceURI : "",
    };
  } catch {
    return { ...preferenceDefaults };
  }
}
let preferences = readPreferences();
let mode = preferences.defaultMode;
const history = [];

function persistPreferences() {
  try {
    localStorage.setItem(preferenceKey, JSON.stringify(preferences));
    settingsStatus.textContent = "Preferences saved in this browser.";
  } catch {
    settingsStatus.textContent = "Browser storage is unavailable; preferences will reset when this tab closes.";
  }
}

function syncModeControls() {
  modeButtons.forEach((button) => {
    const selected = button.dataset.mode === mode;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelector("#settings-mode").value = mode;
}

function syncVoicePreferences() {
  document.querySelector("#voice-language").value = preferences.language;
  document.querySelector("#settings-language").value = preferences.language;
  document.querySelector("#speak-replies").checked = preferences.speakReplies;
  document.querySelector("#settings-speak").checked = preferences.speakReplies;
  document.querySelector("#speech-rate").value = String(preferences.speechRate);
  document.querySelector("#settings-rate").value = String(preferences.speechRate);
  document.querySelector("#speech-voice").value = preferences.voiceURI;
  document.querySelector("#settings-voice").value = preferences.voiceURI;
}

syncModeControls();
syncVoicePreferences();

function addMessage(role, content, sources = [], reasoning = null) {
  document.querySelector("#empty-state")?.remove();
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const label = document.createElement("p");
  label.className = "message-label";
  label.textContent = role === "user" ? "You" : "Chitti";
  const body = document.createElement("p");
  body.className = "message-content";
  body.textContent = content;
  article.append(label, body);
  if (sources.length) {
    const sourceList = document.createElement("p");
    sourceList.className = "source-list";
    sourceList.append(document.createTextNode("Retrieved from: "));
    sources.forEach((source, index) => {
      if (index) sourceList.append(document.createTextNode(", "));
      if (source.url && source.url.startsWith("https://")) {
        const link = document.createElement("a");
        link.href = source.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = source.title || source.source;
        sourceList.append(link);
      } else {
        sourceList.append(document.createTextNode(source.source));
      }
      if (source.license) sourceList.append(document.createTextNode(` (${source.license})`));
    });
    article.append(sourceList);
  }
  if (role === "assistant" && reasoning) {
    const whyButton = document.createElement("button");
    whyButton.className = "why-button";
    whyButton.type = "button";
    whyButton.textContent = "Why?";
    whyButton.setAttribute("aria-label", "Why did Chitti give this answer?");
    whyButton.setAttribute("aria-expanded", "false");
    const whyPanel = document.createElement("section");
    whyPanel.className = "why-panel";
    whyPanel.hidden = true;
    whyPanel.setAttribute("aria-label", "Answer summary");
    const details = [
      ["Plan", reasoning.plan_summary || "Not available."],
      ["Risk", reasoning.risk_level || "Unknown"],
      ["Estimated time", Number.isInteger(reasoning.estimated_seconds) ? `${reasoning.estimated_seconds}s` : "Unknown"],
      ["Estimated cost", reasoning.cost_estimate || "Unavailable"],
      ["Planned tools", Array.isArray(reasoning.planned_tools) && reasoning.planned_tools.length ? reasoning.planned_tools.join(", ") : "None"],
      ["Tools", Array.isArray(reasoning.tools_used) && reasoning.tools_used.length ? reasoning.tools_used.join(", ") : "None"],
      ["Sources", Array.isArray(reasoning.sources) && reasoning.sources.length ? reasoning.sources.join(", ") : "None"],
      ["Matched note", Array.isArray(reasoning.matched_notes) && reasoning.matched_notes.length ? reasoning.matched_notes.join("\n") : "None"],
      ["Model-estimated confidence", reasoning.confidence || "Unknown"],
      ["Review", reasoning.critique_summary || "Not available."],
      ["Revisions", String(reasoning.revision_count || 0)],
    ];
    const list = document.createElement("dl");
    details.forEach(([name, value]) => {
      const term = document.createElement("dt");
      term.textContent = name;
      const detail = document.createElement("dd");
      detail.textContent = value;
      list.append(term, detail);
    });
    whyPanel.append(list);
    whyButton.addEventListener("click", () => {
      whyPanel.hidden = !whyPanel.hidden;
      whyButton.setAttribute("aria-expanded", String(!whyPanel.hidden));
    });
    article.append(whyButton, whyPanel);
  }
  conversation.append(article);
  conversation.scrollTop = conversation.scrollHeight;
}

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    mode = button.dataset.mode;
    preferences.defaultMode = mode;
    syncModeControls();
    persistPreferences();
  });
});

function closeSettingsPanel() {
  settingsPanel.hidden = true;
  document.querySelector("#settings-toggle").setAttribute("aria-expanded", "false");
}

document.querySelector("#memory-toggle").addEventListener("click", async (event) => {
  closeSettingsPanel();
  memoryPanel.hidden = !memoryPanel.hidden;
  knowledgePanel.hidden = true;
  toolsPanel.hidden = true;
  document.querySelector("#knowledge-toggle").setAttribute("aria-expanded", "false");
  document.querySelector("#tools-toggle").setAttribute("aria-expanded", "false");
  event.currentTarget.setAttribute("aria-expanded", String(!memoryPanel.hidden));
  if (!memoryPanel.hidden) await refreshMemory();
});

document.querySelector("#knowledge-toggle").addEventListener("click", async (event) => {
  closeSettingsPanel();
  knowledgePanel.hidden = !knowledgePanel.hidden;
  memoryPanel.hidden = true;
  toolsPanel.hidden = true;
  document.querySelector("#memory-toggle").setAttribute("aria-expanded", "false");
  document.querySelector("#tools-toggle").setAttribute("aria-expanded", "false");
  event.currentTarget.setAttribute("aria-expanded", String(!knowledgePanel.hidden));
  if (!knowledgePanel.hidden) await refreshKnowledgeSources();
});

document.querySelector("#tools-toggle").addEventListener("click", async (event) => {
  closeSettingsPanel();
  toolsPanel.hidden = !toolsPanel.hidden;
  memoryPanel.hidden = true;
  knowledgePanel.hidden = true;
  document.querySelector("#memory-toggle").setAttribute("aria-expanded", "false");
  document.querySelector("#knowledge-toggle").setAttribute("aria-expanded", "false");
  event.currentTarget.setAttribute("aria-expanded", String(!toolsPanel.hidden));
  if (!toolsPanel.hidden) await refreshTools();
});

document.querySelector("#voice-toggle").addEventListener("click", async (event) => {
  closeSettingsPanel();
  voicePanel.hidden = !voicePanel.hidden;
  memoryPanel.hidden = true;
  knowledgePanel.hidden = true;
  toolsPanel.hidden = true;
  for (const id of ["memory-toggle", "knowledge-toggle", "tools-toggle"]) {
    document.querySelector(`#${id}`).setAttribute("aria-expanded", "false");
  }
  event.currentTarget.setAttribute("aria-expanded", String(!voicePanel.hidden));
  if (!voicePanel.hidden) await loadVoiceStatus();
});

for (const id of ["memory-toggle", "knowledge-toggle", "tools-toggle"]) {
  document.querySelector(`#${id}`).addEventListener("click", () => {
    voicePanel.hidden = true;
    document.querySelector("#voice-toggle").setAttribute("aria-expanded", "false");
  });
}

async function loadVoiceStatus() {
  try {
    const response = await fetch("/api/voice/status");
    const status = await response.json();
    if (!response.ok) throw new Error(status.detail || "Could not load voice status.");
    if (!status.installed) {
      voiceStatus.textContent = "Local Whisper is not installed. Install requirements-voice.txt to enable transcription.";
    }
  } catch (error) {
    voiceStatus.textContent = error.message;
  }
}

document.querySelector("#record-toggle").addEventListener("click", async (event) => {
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    event.currentTarget.querySelector("span").textContent = "Transcribing…";
    event.currentTarget.disabled = true;
    return;
  }
  await startRecording(event.currentTarget);
});

async function startRecording(button) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    voiceStatus.textContent = "This browser does not support microphone recording.";
    return;
  }
  try {
    stopWakeRecognition();
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(recordingStream);
    audioChunks = [];
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) audioChunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", async () => {
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      recordingStream?.getTracks().forEach((track) => track.stop());
      recordingStream = null;
      await transcribeRecording(blob);
      button.disabled = false;
      button.setAttribute("aria-pressed", "false");
      button.querySelector("span").textContent = "Start recording";
      if (wakeEnabled) startWakeRecognition();
    }, { once: true });
    mediaRecorder.start();
    button.setAttribute("aria-pressed", "true");
    button.querySelector("span").textContent = "Stop recording";
    voiceStatus.textContent = "Recording locally. Press stop when finished.";
  } catch (error) {
    recordingStream?.getTracks().forEach((track) => track.stop());
    recordingStream = null;
    voiceStatus.textContent = error.name === "NotAllowedError" ? "Microphone permission was denied." : error.message;
  }
}

async function transcribeRecording(blob) {
  if (!blob.size) {
    voiceStatus.textContent = "No audio was recorded.";
    return;
  }
  voiceStatus.textContent = "Transcribing with local Whisper…";
  try {
    const language = document.querySelector("#voice-language").value;
    const response = await fetch(`/api/voice/transcribe?language=${encodeURIComponent(language)}`, {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" },
      body: blob,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "Transcription failed.");
    if (!result.text) {
      voiceStatus.textContent = "No speech was detected.";
      return;
    }
    input.value = result.text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    voiceStatus.textContent = `Transcribed ${result.language.toUpperCase()}. Review the text, then send when ready.`;
  } catch (error) {
    voiceStatus.textContent = error.message;
  }
}

function startWakeRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    voiceStatus.textContent = "Wake-word recognition is not supported by this browser.";
    document.querySelector("#wake-toggle").checked = false;
    wakeEnabled = false;
    return;
  }
  if (!wakeEnabled || mediaRecorder?.state === "recording") return;
  try {
    wakeRecognition = new Recognition();
    wakeRecognition.continuous = true;
    wakeRecognition.interimResults = true;
    wakeRecognition.lang = "en-US";
    wakeRecognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index][0].transcript.toLowerCase();
        if (transcript.includes("hey chitti")) {
          voiceStatus.textContent = "Wake phrase detected. Listening for your request…";
          stopWakeRecognition();
          startRecording(document.querySelector("#record-toggle"));
          return;
        }
      }
    };
    wakeRecognition.onerror = () => {
      voiceStatus.textContent = "Wake-word recognition stopped by the browser.";
      wakeEnabled = false;
      document.querySelector("#wake-toggle").checked = false;
    };
    wakeRecognition.onend = () => {
      wakeRecognition = null;
      if (wakeEnabled && mediaRecorder?.state !== "recording") startWakeRecognition();
    };
    wakeRecognition.start();
    voiceStatus.textContent = "Wake phrase is listening through the browser speech provider.";
  } catch (error) {
    voiceStatus.textContent = error.message;
    wakeEnabled = false;
    document.querySelector("#wake-toggle").checked = false;
  }
}

function stopWakeRecognition() {
  if (wakeRecognition) {
    const recognition = wakeRecognition;
    wakeRecognition = null;
    recognition.onend = null;
    recognition.stop();
  }
}

document.querySelector("#wake-toggle").addEventListener("change", (event) => {
  wakeEnabled = event.currentTarget.checked;
  if (wakeEnabled) startWakeRecognition();
  else stopWakeRecognition();
});

function refreshSpeechVoices() {
  if (!window.speechSynthesis) return;
  const selects = [document.querySelector("#speech-voice"), document.querySelector("#settings-voice")];
  selects.forEach((select) => {
    select.replaceChildren();
    const systemDefault = document.createElement("option");
    systemDefault.value = "";
    systemDefault.textContent = "System default";
    select.append(systemDefault);
  });
  const supportedVoices = window.speechSynthesis.getVoices().filter((voice) => /^(en|ta|hi)(-|$)/i.test(voice.lang));
  const shownLanguages = new Set();
  supportedVoices.forEach((voice) => {
    if (shownLanguages.has(voice.lang)) return;
    shownLanguages.add(voice.lang);
    selects.forEach((select) => {
      const option = document.createElement("option");
      option.value = voice.voiceURI;
      option.textContent = `${voice.name} (${voice.lang})`;
      select.append(option);
    });
  });
  syncVoicePreferences();
}

if (window.speechSynthesis) {
  refreshSpeechVoices();
  window.speechSynthesis.addEventListener("voiceschanged", refreshSpeechVoices);
}

document.querySelector("#settings-voice").addEventListener("change", (event) => {
  preferences.voiceURI = event.currentTarget.value;
  syncVoicePreferences();
  persistPreferences();
});

document.querySelector("#speech-voice").addEventListener("change", (event) => {
  preferences.voiceURI = event.currentTarget.value;
  syncVoicePreferences();
  persistPreferences();
});

function speakReply(text) {
  if (!document.querySelector("#speak-replies").checked || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const selectedVoice = document.querySelector("#speech-voice").value;
  utterance.voice = window.speechSynthesis.getVoices().find((voice) => voice.voiceURI === selectedVoice) || null;
  utterance.rate = Number(document.querySelector("#speech-rate").value);
  window.speechSynthesis.speak(utterance);
}

document.querySelector("#stop-speech").addEventListener("click", () => {
  window.speechSynthesis?.cancel();
});

async function requestTool(path, method = "GET", body) {
  const response = await fetch(`/api/tools${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.detail || "Tool request failed.");
  return data;
}

function showToolError(element, error) {
  element.textContent = error.message;
}

async function refreshTools() {
  try {
    const [status, reminders, drafts, activity] = await Promise.all([
      requestTool(""),
      requestTool("/reminders"),
      requestTool("/email-drafts"),
      requestTool("/activity"),
    ]);
    const unavailable = status.tools.filter((tool) => !tool.enabled).map((tool) => tool.id);
    document.querySelector("#tools-capabilities").textContent = unavailable.length
      ? `Not configured: ${unavailable.join(", ")}.`
      : "All listed integrations are configured.";
    renderReminders(reminders);
    renderDrafts(drafts);
    renderActivity(activity);
  } catch (error) {
    document.querySelector("#tools-capabilities").textContent = error.message;
  }
}

document.querySelector("#calculate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = document.querySelector("#calculation-result");
  try {
    const result = await requestTool("/calculate", "POST", { expression: document.querySelector("#calculation").value });
    output.textContent = `${result.expression} = ${result.result}`;
    await refreshTools();
  } catch (error) { showToolError(output, error); }
});

document.querySelector("#file-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = document.querySelector("#file-results");
  try {
    const result = await requestTool("/file-search", "POST", { query: document.querySelector("#file-query").value });
    renderFileResults(result.matches);
    await refreshTools();
  } catch (error) { showToolError(output, error); }
});

document.querySelector("#weather-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = document.querySelector("#weather-result");
  output.textContent = "Looking up current conditions…";
  try {
    const result = await requestTool("/weather", "POST", { place: document.querySelector("#weather-place").value });
    output.textContent = `${result.place}: ${result.temperature_c} °C, humidity ${result.humidity_percent}%, wind ${result.wind_speed_kmh} km/h · ${result.provider}`;
    await refreshTools();
  } catch (error) { showToolError(output, error); }
});

document.querySelector("#web-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = document.querySelector("#web-results");
  try {
    const result = await requestTool("/web-search", "POST", { query: document.querySelector("#web-query").value });
    renderWebResults(result.results);
    await refreshTools();
  } catch (error) { showToolError(output, error); }
});

document.querySelector("#reminder-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const dueAt = new Date(document.querySelector("#reminder-due").value);
  try {
    await requestTool("/reminders", "POST", {
      task: document.querySelector("#reminder-task").value,
      due_at: dueAt.toISOString(),
    });
    document.querySelector("#reminder-task").value = "";
    await refreshTools();
  } catch (error) { document.querySelector("#reminder-list").textContent = error.message; }
});

document.querySelector("#email-draft-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await requestTool("/email-drafts", "POST", {
      recipient: document.querySelector("#draft-recipient").value,
      subject: document.querySelector("#draft-subject").value,
      body: document.querySelector("#draft-body").value,
    });
    document.querySelector("#draft-body").value = "";
    await refreshTools();
  } catch (error) { document.querySelector("#draft-list").textContent = error.message; }
});

document.querySelector("#home-preview-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("#home-status");
  try {
    const preview = await requestTool("/home/preview", "POST", {
      entity_id: document.querySelector("#home-entity").value,
      action: document.querySelector("#home-action").value,
    });
    pendingHomeConfirmation = preview.confirmation_token;
    document.querySelector("#home-confirm").disabled = false;
    status.textContent = `Pending confirmation: ${preview.action} ${preview.entity_id} (expires in ${preview.expires_in_seconds}s).`;
  } catch (error) {
    pendingHomeConfirmation = "";
    document.querySelector("#home-confirm").disabled = true;
    showToolError(status, error);
  }
});

document.querySelector("#home-confirm").addEventListener("click", async () => {
  if (!pendingHomeConfirmation || !window.confirm("Run this Home Assistant action now?")) return;
  const confirmationToken = pendingHomeConfirmation;
  pendingHomeConfirmation = "";
  document.querySelector("#home-confirm").disabled = true;
  try {
    const result = await requestTool("/home/execute", "POST", { confirmation_token: confirmationToken });
    document.querySelector("#home-status").textContent = `Completed: ${result.action} ${result.entity_id}.`;
    await refreshTools();
  } catch (error) { showToolError(document.querySelector("#home-status"), error); }
});

function renderReminders(reminders) {
  const list = document.querySelector("#reminder-list");
  list.replaceChildren();
  reminders.forEach((reminder) => {
    const row = document.createElement("div");
    row.className = "tool-list-row";
    const text = document.createElement("span");
    text.textContent = `${reminder.completed ? "Done" : new Date(reminder.due_at).toLocaleString()} · ${reminder.task}`;
    row.append(text);
    if (!reminder.completed) {
      const complete = document.createElement("button");
      complete.type = "button";
      complete.textContent = "Complete";
      complete.addEventListener("click", async () => {
        await requestTool(`/reminders/${reminder.id}/complete`, "PATCH", {});
        await refreshTools();
      });
      row.append(complete);
    }
    list.append(row);
  });
}

function renderDrafts(drafts) {
  const list = document.querySelector("#draft-list");
  list.replaceChildren();
  drafts.forEach((draft) => {
    const item = document.createElement("article");
    item.className = "tool-list-row draft-row";
    const text = document.createElement("p");
    text.textContent = `To: ${draft.recipient} · ${draft.subject}\n${draft.body}`;
    item.append(text);
    list.append(item);
  });
}

function renderFileResults(matches) {
  const list = document.querySelector("#file-results");
  list.replaceChildren();
  if (!matches.length) { list.textContent = "No matching files."; return; }
  matches.forEach((match) => {
    const row = document.createElement("p");
    row.className = "tool-list-row";
    row.textContent = `${match.path}${match.line ? `:${match.line}` : ""} · ${match.snippet}`;
    list.append(row);
  });
}

function renderWebResults(results) {
  const list = document.querySelector("#web-results");
  list.replaceChildren();
  if (!results.length) { list.textContent = "No results."; return; }
  results.forEach((result) => {
    const item = document.createElement("article");
    item.className = "tool-list-row web-result";
    const link = document.createElement("a");
    link.href = result.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = result.title || result.url;
    const snippet = document.createElement("p");
    snippet.textContent = result.snippet;
    item.append(link, snippet);
    list.append(item);
  });
}

function renderActivity(activity) {
  const list = document.querySelector("#tool-activity");
  list.replaceChildren();
  activity.forEach((entry) => {
    const row = document.createElement("p");
    row.className = "tool-activity-row";
    row.textContent = `${new Date(entry.created_at).toLocaleString()} · ${entry.tool} · ${entry.status} · ${entry.summary}`;
    list.append(row);
  });
}

async function refreshKnowledgeSources() {
  try {
    const response = await fetch("/api/knowledge/sources");
    if (!response.ok) throw new Error("Could not load source catalog.");
    const sources = await response.json();
    const list = document.querySelector("#knowledge-list");
    list.replaceChildren();
    sources.forEach((source) => {
      const item = document.createElement("article");
      item.className = "knowledge-source";
      const control = document.createElement("label");
      control.className = "source-control";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = Boolean(source.enabled);
      toggle.setAttribute("aria-label", `Enable ${source.name}`);
      toggle.addEventListener("change", async () => {
        try {
          const result = await fetch(`/api/knowledge/sources/${encodeURIComponent(source.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: toggle.checked }),
          });
          if (!result.ok) throw new Error("Could not update source.");
          await refreshKnowledgeSources();
        } catch (error) {
          knowledgeStatus.textContent = error.message;
          toggle.checked = !toggle.checked;
        }
      });
      const name = document.createElement("span");
      name.className = "knowledge-name";
      name.textContent = source.name;
      control.append(toggle, name);
      const details = document.createElement("p");
      details.className = "knowledge-meta";
      const lastUpdate = source.last_updated ? new Date(source.last_updated).toLocaleString() : "Not indexed";
      const size = source.indexed_bytes < 1024 * 1024
        ? `${(source.indexed_bytes / 1024).toFixed(1)} KB`
        : `${(source.indexed_bytes / (1024 * 1024)).toFixed(1)} MB`;
      details.textContent = `${source.language.toUpperCase()} · ${source.license} · ${source.indexed_chunks} chunks · ${size} · ${lastUpdate} · ${source.retrieval_count} retrievals`;
      item.append(control, details);
      list.append(item);
    });
  } catch (error) {
    knowledgeStatus.textContent = error.message;
  }
}

document.querySelector("#knowledge-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = document.querySelector("#knowledge-query").value.trim();
  const language = document.querySelector("#knowledge-language").value;
  if (!query) return;
  knowledgeStatus.textContent = "Searching Wikipedia and indexing selected extracts…";
  try {
    const response = await fetch("/api/knowledge/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, language, limit: 3 }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Could not index this search.");
    knowledgeStatus.textContent = `${data.source}: indexed ${data.pages} pages (${data.chunks} chunks).`;
    await refreshKnowledgeSources();
  } catch (error) {
    knowledgeStatus.textContent = error.message;
  }
});

async function refreshMemory() {
  try {
    const response = await fetch("/api/memory");
    if (!response.ok) throw new Error("Could not load memory.");
    const entries = await response.json();
    const list = document.querySelector("#memory-list");
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "memory-empty";
      empty.textContent = "No saved notes or documents.";
      list.append(empty);
      return;
    }
    entries.forEach((entry) => {
      const item = document.createElement("article");
      item.className = "memory-entry";
      const meta = document.createElement("p");
      meta.className = "memory-meta";
      meta.textContent = `${entry.kind === "document" ? "DOCUMENT" : "NOTE"} · ${entry.source}`;
      const text = document.createElement("p");
      text.className = "memory-content";
      text.textContent = entry.content;
      const remove = document.createElement("button");
      remove.className = "remove-entry";
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", async () => {
        const result = await fetch(`/api/memory/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
        if (result.ok) await refreshMemory();
      });
      item.append(meta, text, remove);
      list.append(item);
    });
  } catch (error) {
    memoryStatus.textContent = error.message;
  }
}

document.querySelector("#note-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#memory-note");
  const content = input.value.trim();
  if (!content) return;
  memoryStatus.textContent = "Saving note…";
  try {
    const response = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Could not save note.");
    input.value = "";
    memoryStatus.textContent = "Note saved locally.";
    await refreshMemory();
  } catch (error) {
    memoryStatus.textContent = error.message;
  }
});

document.querySelector("#document-file").addEventListener("change", async (event) => {
  const file = event.currentTarget.files[0];
  if (!file) return;
  memoryStatus.textContent = "Indexing document…";
  try {
    const content = await file.text();
    const response = await fetch("/api/memory/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: file.name, content }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Could not index document.");
    memoryStatus.textContent = `${data.source} added (${data.chunks} chunks).`;
    await refreshMemory();
  } catch (error) {
    memoryStatus.textContent = error.message;
  } finally {
    event.currentTarget.value = "";
  }
});

document.querySelector("#delete-all").addEventListener("click", async () => {
  if (!window.confirm("Permanently delete every saved note and indexed document?")) return;
  const response = await fetch("/api/memory?confirm=true", { method: "DELETE" });
  memoryStatus.textContent = response.ok ? "All local memory deleted." : "Could not delete memory.";
  if (response.ok) await refreshMemory();
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || sendButton.disabled) return;

  input.value = "";
  input.style.height = "auto";
  addMessage("user", message);
  sendButton.disabled = true;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history: history.slice(-20), mode }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Request failed.");
    addMessage("assistant", data.reply, data.sources || [], data.reasoning || null);
    speakReply(data.reply);
    history.push({ role: "user", content: message }, { role: "assistant", content: data.reply });
  } catch (error) {
    addMessage("assistant", `I couldn't reach the configured model. ${error.message}`);
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

const visionPanel = document.querySelector("#vision-panel");
const visionStatus = document.querySelector("#vision-status");
const visionPreview = document.querySelector("#vision-preview");
const cameraFeed = document.querySelector("#camera-feed");
const imagePreview = document.querySelector("#image-preview");
let cameraStream = null;
let selectedVisionImage = null;
let visionObjectUrl = "";

document.querySelector("#vision-toggle").addEventListener("click", async (event) => {
  closeSettingsPanel();
  visionPanel.hidden = !visionPanel.hidden;
  for (const id of ["memory", "knowledge", "tools", "voice"]) {
    document.querySelector(`#${id}-panel`).hidden = true;
    document.querySelector(`#${id}-toggle`).setAttribute("aria-expanded", "false");
  }
  event.currentTarget.setAttribute("aria-expanded", String(!visionPanel.hidden));
  if (!visionPanel.hidden) await loadVisionStatus();
  else stopVisionCamera();
});

for (const id of ["memory", "knowledge", "tools", "voice"]) {
  document.querySelector(`#${id}-toggle`).addEventListener("click", () => {
    visionPanel.hidden = true;
    document.querySelector("#vision-toggle").setAttribute("aria-expanded", "false");
    stopVisionCamera();
  });
}

async function loadVisionStatus() {
  try {
    const response = await fetch("/api/vision/status");
    const status = await response.json();
    if (!response.ok) throw new Error(status.detail || "Could not load vision status.");
    const missing = [];
    if (!status.object_detection.installed) missing.push("YOLO not installed");
    if (!status.ocr.installed) missing.push("OCR package not installed");
    if (!status.scene_description.enabled) missing.push("scene model not configured");
    document.querySelector("#vision-readiness").textContent =
      `${missing.join(" · ") || "Vision ready"}. Images are not saved. Face recognition is disabled.`;
  } catch (error) {
    document.querySelector("#vision-readiness").textContent = error.message;
  }
}

document.querySelector("#camera-start").addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    visionStatus.textContent = "This browser does not support camera access. Choose an image instead.";
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    cameraFeed.srcObject = cameraStream;
    cameraFeed.hidden = false;
    imagePreview.hidden = true;
    visionPreview.hidden = false;
    document.querySelector("#camera-start").disabled = true;
    document.querySelector("#camera-stop").disabled = false;
    document.querySelector("#camera-capture").disabled = false;
    visionStatus.textContent = "Camera is active. Capture a frame when ready.";
  } catch (error) {
    visionStatus.textContent = error.name === "NotAllowedError" ? "Camera permission was denied." : error.message;
  }
});

document.querySelector("#settings-toggle").addEventListener("click", async (event) => {
  settingsPanel.hidden = !settingsPanel.hidden;
  for (const id of ["memory", "knowledge", "tools", "voice", "vision"]) {
    document.querySelector(`#${id}-panel`).hidden = true;
    document.querySelector(`#${id}-toggle`).setAttribute("aria-expanded", "false");
  }
  event.currentTarget.setAttribute("aria-expanded", String(!settingsPanel.hidden));
  if (!settingsPanel.hidden) await refreshSettingsStatus();
});

async function refreshSettingsStatus() {
  try {
    const response = await fetch("/api/settings/status");
    const status = await response.json();
    if (!response.ok) throw new Error(status.detail || "Could not load system status.");
    const configuredTools = status.tools.filter((tool) => tool.enabled).length;
    const rows = [
      ["Chat model", status.model.name],
      ["Knowledge", `${status.knowledge.indexed_chunks} indexed chunks`],
      ["Tools", `${configuredTools}/${status.tools.length} available`],
      ["Voice transcription", status.voice.installed ? `Ready · ${status.voice.model}` : "Optional engine not installed"],
      ["Object detection", status.vision.object_detection.installed ? "Ready" : "Optional engine not installed"],
      ["OCR", status.vision.ocr.installed ? "Ready" : "Optional engine not installed"],
      ["Scene description", status.vision.scene_description.enabled ? "Configured" : "Not configured"],
      ["Authentication", status.authentication ? "Enabled" : "Disabled"],
    ];
    const summary = document.querySelector("#settings-summary");
    summary.replaceChildren();
    rows.forEach(([label, value]) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      summary.append(term, detail);
    });
    settingsStatus.textContent = "System status updated.";
  } catch (error) {
    settingsStatus.textContent = error.message;
  }
}

document.querySelector("#settings-mode").addEventListener("change", (event) => {
  mode = event.currentTarget.value;
  preferences.defaultMode = mode;
  syncModeControls();
  persistPreferences();
});

document.querySelector("#settings-language").addEventListener("change", (event) => {
  preferences.language = event.currentTarget.value;
  syncVoicePreferences();
  persistPreferences();
});

document.querySelector("#voice-language").addEventListener("change", (event) => {
  preferences.language = event.currentTarget.value;
  syncVoicePreferences();
  persistPreferences();
});

document.querySelector("#settings-speak").addEventListener("change", (event) => {
  preferences.speakReplies = event.currentTarget.checked;
  syncVoicePreferences();
  persistPreferences();
});

document.querySelector("#speak-replies").addEventListener("change", (event) => {
  preferences.speakReplies = event.currentTarget.checked;
  syncVoicePreferences();
  persistPreferences();
});

document.querySelector("#settings-rate").addEventListener("input", (event) => {
  preferences.speechRate = Number(event.currentTarget.value);
  syncVoicePreferences();
  persistPreferences();
});

document.querySelector("#speech-rate").addEventListener("input", (event) => {
  preferences.speechRate = Number(event.currentTarget.value);
  syncVoicePreferences();
  persistPreferences();
});

document.querySelector("#settings-reset").addEventListener("click", () => {
  preferences = { ...preferenceDefaults };
  mode = preferences.defaultMode;
  syncModeControls();
  syncVoicePreferences();
  persistPreferences();
});

function stopVisionCamera() {
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  cameraFeed.srcObject = null;
  cameraFeed.hidden = true;
  document.querySelector("#camera-start").disabled = false;
  document.querySelector("#camera-stop").disabled = true;
  document.querySelector("#camera-capture").disabled = true;
}

document.querySelector("#camera-stop").addEventListener("click", stopVisionCamera);

document.querySelector("#camera-capture").addEventListener("click", () => {
  const width = cameraFeed.videoWidth;
  const height = cameraFeed.videoHeight;
  if (!width || !height || width * height > 20_000_000) {
    visionStatus.textContent = "Camera frame is not ready or exceeds the 20 megapixel limit.";
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(cameraFeed, 0, 0, width, height);
  canvas.toBlob((blob) => {
    if (blob) setVisionImage(blob, "image/jpeg");
    else visionStatus.textContent = "Could not capture a camera frame.";
  }, "image/jpeg", 0.88);
});

document.querySelector("#vision-file").addEventListener("change", (event) => {
  const file = event.currentTarget.files[0];
  if (file) setVisionImage(file, file.type);
  event.currentTarget.value = "";
});

function setVisionImage(blob, contentType) {
  stopVisionCamera();
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    clearVisionImage();
    visionStatus.textContent = "Choose a JPEG, PNG, or WebP image.";
    return;
  }
  if (blob.size > 12 * 1024 * 1024) {
    clearVisionImage();
    visionStatus.textContent = "Image exceeds the 12 MB limit.";
    return;
  }
  clearVisionImage();
  document.querySelector("#vision-results").replaceChildren();
  if (visionObjectUrl) URL.revokeObjectURL(visionObjectUrl);
  selectedVisionImage = blob;
  visionObjectUrl = URL.createObjectURL(blob);
  imagePreview.src = visionObjectUrl;
  imagePreview.hidden = false;
  cameraFeed.hidden = true;
  visionPreview.hidden = false;
  document.querySelector("#vision-analyze").disabled = false;
  visionStatus.textContent = `Ready to analyze · ${(blob.size / 1024).toFixed(1)} KB · not saved`;
}

function clearVisionImage() {
  if (visionObjectUrl) URL.revokeObjectURL(visionObjectUrl);
  visionObjectUrl = "";
  selectedVisionImage = null;
  imagePreview.removeAttribute("src");
  imagePreview.hidden = true;
  document.querySelector("#vision-preview").hidden = true;
  document.querySelector("#vision-analyze").disabled = true;
}

document.querySelector("#vision-analyze").addEventListener("click", async () => {
  if (!selectedVisionImage) return;
  const button = document.querySelector("#vision-analyze");
  button.disabled = true;
  visionStatus.textContent = "Analyzing image…";
  try {
    const params = new URLSearchParams({
      include_ocr: String(document.querySelector("#vision-ocr").checked),
      include_description: String(document.querySelector("#vision-description").checked),
      ocr_language: document.querySelector("#vision-ocr-language").value,
    });
    const response = await fetch(`/api/vision/analyze?${params}`, {
      method: "POST",
      headers: { "Content-Type": selectedVisionImage.type },
      body: selectedVisionImage,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "Image analysis failed.");
    renderVisionResult(result);
    visionStatus.textContent = `Analysis complete · ${result.width} × ${result.height} · image not saved`;
  } catch (error) {
    visionStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

function renderVisionResult(result) {
  const container = document.querySelector("#vision-results");
  container.replaceChildren();
  const objectHeading = document.createElement("h3");
  objectHeading.textContent = "Objects";
  container.append(objectHeading);
  const objectList = document.createElement("ul");
  result.objects.forEach((object) => {
    const item = document.createElement("li");
    item.textContent = `${object.label} · ${Math.round(object.confidence * 100)}%`;
    objectList.append(item);
  });
  if (!result.objects.length) {
    const empty = document.createElement("li");
    empty.textContent = "No objects detected.";
    objectList.append(empty);
  }
  container.append(objectList);
  if (result.ocr_text) appendVisionText(container, "Text", result.ocr_text);
  if (result.scene_description) appendVisionText(container, "Scene", result.scene_description);
  result.warnings.forEach((warning) => appendVisionText(container, "Unavailable", warning));
}

function appendVisionText(container, headingText, content) {
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  heading.textContent = headingText;
  const text = document.createElement("p");
  text.textContent = content;
  section.append(heading, text);
  container.append(section);
}

(() => {
  const navMenu = document.querySelector(".nav-menu");
  const mobileLayout = window.matchMedia("(max-width: 880px)");
  navMenu.open = !mobileLayout.matches;
  mobileLayout.addEventListener("change", (event) => {
    navMenu.open = !event.matches;
  });

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion) return;

  const video = document.querySelector("#ambient-motion");
  video.addEventListener("loadeddata", () => {
    video.play().then(() => {
      const reveal = () => video.classList.add("ready");
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(reveal);
      } else {
        requestAnimationFrame(reveal);
      }
    }).catch(() => {});
  }, { once: true });
  video.src = video.dataset.src;
  video.load();

  const entrance = (selector, delay, duration, keyframes) => {
    document.querySelectorAll(selector).forEach((element) => {
      element.animate(keyframes, {
        delay,
        duration,
        easing: "cubic-bezier(.22, 1, .36, 1)",
        fill: "both"
      });
    });
  };

  entrance(".topbar", 0, 500, [
    { opacity: 0, transform: "translateY(-8px)" },
    { opacity: 1, transform: "translateY(0)" }
  ]);
  entrance(".workspace", 180, 650, [
    { opacity: 0, transform: "translateY(18px)" },
    { opacity: 1, transform: "translateY(0)" }
  ]);
  entrance(".composer", 650, 520, [
    { opacity: 0, transform: "translateY(14px)" },
    { opacity: 1, transform: "translateY(0)" }
  ]);
})();