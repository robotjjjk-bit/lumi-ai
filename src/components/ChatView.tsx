import { For, Show, createEffect, createSignal, onCleanup, untrack } from "solid-js";
import {
  messages,
  activeConversationId,
  isStreaming,
  isViewingActiveStream,
  streamingText,
  streamingThinking,
  streamingImages,
  streamingCodeBlocks,
  streamingCodeResults,
  chatError,
  sendMessage,
  stopStreaming,
  selectConversation,
  activeConversation,
  retryMessage,
  editMessage,
  branchToNewChat,
  navigateBranch,
  branchState,
  selectedModel,
  setSelectedModel,
  searchEnabled,
  setSearchEnabled,
  urlContextEnabled,
  setUrlContextEnabled,
  codeExecutionEnabled,
  setCodeExecutionEnabled,
  fileUploadError,
  setFileUploadError,
  pendingAttachments,
  hasPendingUploads,
  addAttachment,
  removeAttachment,
  clearAttachments,
  loadAttachmentsFromParts,
  restoreAttachments,
  recoveryText,
  recoveryAttachments,
  setRecoveryText,
  setRecoveryAttachments,
  clampUrlContextForModel,
} from "../lib/stores/chat";
import type { Message, MessagePart } from "../lib/db";
import { AVAILABLE_MODELS, modelSupportsCodeExecution, modelSupportsUrlContext } from "../lib/api/types";
import { renderMarkdown, renderMarkdownStream, renderPlainText } from "../lib/markdown";
import {
  customInstructions,
  activeInstructionIds,
  createCustomInstruction,
  updateCustomInstruction,
  deleteCustomInstruction,
  toggleInstructionActive,
} from "../lib/stores/custom-instructions";
import {
  thinkingEnabled, setThinkingEnabled,
  thinkingLevel, setThinkingLevel,
  usesLevelBasedThinking, modelSupportsThinking,
  modelAlwaysThinking, getModelThinkingLevels,
  clampThinkingLevelForModel,
} from "../lib/stores/thinking";
import { sidebarOpen, setSidebarOpen } from "../App";
import { isTauri, isAndroid } from "../lib/platform";
import type { AndroidFsUri } from "tauri-plugin-android-fs-api";
import "./ChatView.css";

// === Greetings and Suggestions ===

import {
  SUGGESTIONS,
  MORNING_GROUPS,
  AFTERNOON_GROUPS,
  EVENING_GROUPS,
  NIGHT_GROUPS,
  type ContextGroup,
} from "./chat-constants";

// === Subagent 3/5: identitas & bentuk row stabil ===
//
// - formatTimeCached: memo toLocaleTimeString per createdAt (Map ≤500 entri,
//   evict FIFO). Dipakai MessageTime + wrapper formatTime di dalam ChatView.
// - MessageTime / BranchNav: child kecil murni (hanya butuh createdAt /
//   groupId+index+total) agar timestamp & branch-nav tidak ikut evaluasi
//   per token streaming.
// - Skeleton streaming stabil ada di StreamingBubble (di dalam ChatView):
//   satu .message-bubble dengan slot thinking/code/images/text/typing yang
//   show/hide via `hidden` (bukan mount-unmount root berbeda). Wrapper slot
//   adalah div polos tanpa display CSS sehingga atribut `hidden` UA
//   (display:none) selalu berlaku; inner content (yang punya display:flex
//   seperti .typing-indicator) tidak diberi `hidden` langsung.
//   Strategi renderMarkdown tidak diubah (milik subagent lain).

const _formatTimeCache = new Map<number, string>();
function formatTimeCached(ts: number): string {
  const hit = _formatTimeCache.get(ts);
  if (hit !== undefined) return hit;
  const s = new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  _formatTimeCache.set(ts, s);
  if (_formatTimeCache.size > 500) {
    const oldest = _formatTimeCache.keys().next().value;
    if (oldest !== undefined) _formatTimeCache.delete(oldest);
  }
  return s;
}

function MessageTime(props: { createdAt: number }) {
  return <span class="message-time md-typescale-label-small">{formatTimeCached(props.createdAt)}</span>;
}

function BranchNav(props: { groupId: string; activeIndex: number; total: number }) {
  return (
    <div class="branch-nav">
      <md-icon-button
        class="action-btn"
        type="button"
        aria-label="Previous branch"
        disabled={props.activeIndex <= 0}
        onClick={() => navigateBranch(props.groupId, props.activeIndex - 1)}
      >
        <md-icon>chevron_left</md-icon>
      </md-icon-button>
      <span class="branch-indicator md-typescale-label-small numeric-tnum">
        {/* contentTransition(.numericText): inner me-remount via <Show keyed>
            agar animation numeric-swap-in jalan per perubahan angka;
            outer stabil (min-width + tabular-nums) agar tidak jitter. */}
        <Show when={`${props.activeIndex + 1}/${props.total}`} keyed>
          {(v) => <span class="numeric-swap" data-key={v}>{v}</span>}
        </Show>
      </span>
      <md-icon-button
        class="action-btn"
        type="button"
        aria-label="Next branch"
        disabled={props.activeIndex >= props.total - 1}
        onClick={() => navigateBranch(props.groupId, props.activeIndex + 1)}
      >
        <md-icon>chevron_right</md-icon>
      </md-icon-button>
    </div>
  );
}

// === Subagent 1/5: streaming markdown throttled (leaf isolation) ===
//
// Hipotesis: renderMarkdown penuh per token (markdown-it + hljs.highlightAuto
// + KaTeX + innerHTML replace seluruh bubble) adalah biaya terbesar.
// Perbaikan minimal tanpa mengubah logika chat/store:
// - ThrottledMarkdown: leaf kecil. Signal streamingText()/streamingThinking()
//   hanya dibaca di dalam createEffect milik komponen ini, sehingga token baru
//   hanya menginvalidasi subtree ini (html()), bukan ChatView / StreamingBubble.
// - Throttle rAF ~30fps (FRAME_MS=33): token di antara frame diakumulasi di
//   `latest` tanpa render; paling banyak 1 render per 33ms.
// - Fast path: saat token mengalir deras (≥2 update coalesced dalam 1 frame,
//   atau teks > PLAIN_THRESHOLD) render teks polos (escape + <br>) tanpa
//   markdown-it/highlight/KaTeX. Selain itu renderMarkdownStream (highlight
//   bahasa eksplisit saja, tanpa highlightAuto/KaTeX).
// - Settle: jeda ≥300ms tanpa token baru, atau isViewingActiveStream() false
//   (streaming selesai / pindah branch) → renderMarkdown penuh. Tampilan akhir
//   identik dengan render penuh karena settled selalu memakai renderMarkdown.
// - StreamingCodeBlocks/Images/Results: wrapper leaf agar <For> hanya
//   subscribe ke store-nya sendiri, tidak ke streamingText per token.

const STREAM_FRAME_MS = 33; // ~30fps
const STREAM_SETTLE_MS = 300;
const STREAM_PLAIN_THRESHOLD = 2000;

function ThrottledMarkdown(props: { text: () => string; cls: string }) {
  const [html, setHtml] = createSignal("");
  let rafId = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRender = 0;
  let latest = "";
  let coalesced = false;

  const clearRaf = () => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };
  const clearSettle = () => {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
  };

  const renderSettled = (t: string) => {
    if (!t) {
      setHtml("");
    } else {
      try {
        setHtml(renderMarkdown(t));
      } catch {
        setHtml(renderPlainText(t));
      }
    }
    lastRender = performance.now();
    coalesced = false;
  };

  const renderIntermediate = (t: string) => {
    if (!t) {
      setHtml("");
      lastRender = performance.now();
      coalesced = false;
      return;
    }
    try {
      if (coalesced || t.length > STREAM_PLAIN_THRESHOLD) {
        setHtml(renderPlainText(t));
      } else {
        setHtml(renderMarkdownStream(t));
      }
    } catch {
      setHtml(renderPlainText(t));
    }
    lastRender = performance.now();
    coalesced = false;
  };

  const onFrame = () => {
    rafId = 0;
    const now = performance.now();
    const wait = STREAM_FRAME_MS - (now - lastRender);
    if (wait > 0) {
      rafId = requestAnimationFrame(onFrame);
      return;
    }
    if (!isViewingActiveStream()) {
      renderSettled(latest);
      return;
    }
    renderIntermediate(latest);
  };

  const schedule = () => {
    if (rafId) {
      coalesced = true;
      return;
    }
    rafId = requestAnimationFrame(onFrame);
  };

  createEffect(() => {
    const t = props.text();
    latest = t;
    if (!t) {
      clearRaf();
      clearSettle();
      setHtml("");
      lastRender = performance.now();
      coalesced = false;
      return;
    }
    if (rafId) coalesced = true;
    schedule();
    clearSettle();
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      clearRaf();
      renderSettled(latest);
    }, STREAM_SETTLE_MS);
  });

  createEffect(() => {
    if (!isViewingActiveStream() && latest) {
      clearRaf();
      clearSettle();
      renderSettled(latest);
    }
  });

  onCleanup(() => {
    clearRaf();
    clearSettle();
  });

  return <div class={props.cls} innerHTML={html()} />;
}

function StreamingCodeBlocksView() {
  return (
    <For each={streamingCodeBlocks}>
      {(block) => (
        <div class="exec-code-block">
          <div class="exec-code-header md-typescale-label-small">
            <md-icon>terminal</md-icon>
            <span>{block.language || "Code"}</span>
          </div>
          <pre class="exec-code-pre"><code>{block.code}</code></pre>
        </div>
      )}
    </For>
  );
}

function StreamingCodeResultsView() {
  return (
    <For each={streamingCodeResults}>
      {(result) => (
        <div class={`code-exec-result ${result.outcome === "OUTCOME_OK" ? "result-ok" : "result-error"}`}>
          <div class="code-exec-result-header md-typescale-label-small">
            <md-icon>{result.outcome === "OUTCOME_OK" ? "check_circle" : "error_outline"}</md-icon>
            <span>
              {result.outcome === "OUTCOME_OK"
                ? "Output"
                : result.outcome === "OUTCOME_DEADLINE_EXCEEDED"
                ? "Timed Out"
                : "Error"}
            </span>
          </div>
          <Show when={result.output}>
            <pre class="code-exec-output">{result.output}</pre>
          </Show>
        </div>
      )}
    </For>
  );
}

function StreamingImagesView(props: { onDownload: (mimeType: string, data: string) => void }) {
  return (
    <For each={streamingImages}>
      {(img) => (
        <div class="message-image-container">
          <img src={`data:${img.mimeType};base64,${img.data}`} alt="Generated" class="message-image" loading="lazy" decoding="async" />
          <div class="image-overlay-actions">
            <button
              class="image-download-btn"
              type="button"
              aria-label="Download image"
              onClick={() => props.onDownload(img.mimeType, img.data)}
            >
              <md-icon>download</md-icon>
            </button>
          </div>
        </div>
      )}
    </For>
  );
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function getGreetingAndSubtitle(): { greeting: string; subtitle: string } {
  const hour = new Date().getHours();
  let pool: ContextGroup[];
  if (hour < 5) pool = NIGHT_GROUPS;
  else if (hour < 12) pool = MORNING_GROUPS;
  else if (hour < 17) pool = AFTERNOON_GROUPS;
  else if (hour < 22) pool = EVENING_GROUPS;
  else pool = NIGHT_GROUPS;
  // Picking from the same group guarantees tonal coherence between the two strings.
  const group = pickRandom(pool);
  return { greeting: pickRandom(group.greetings), subtitle: pickRandom(group.subtitles) };
}

// Haptics ringan iOS: no-op aman di desktop (try/catch + feature check).
function tapHaptic(ms = 10): void {
  try {
    (navigator as any)?.vibrate?.(ms);
  } catch (_) {}
}

export default function ChatView() {
  let chatMessagesRef: HTMLDivElement | undefined;
  let inputRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;

  // ScrollPosition edge-bottom + isPositionedByUser equivalent.
  // stickToBottom=false berarti user sedang baca atas → jangan paksa scroll.
  const BOTTOM_THRESHOLD = 120;
  const [showScrollBtn, setShowScrollBtn] = createSignal(false);
  let stickToBottom = true;
  let scrollRaf = 0;

  const distanceFromBottom = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight;

  // rAF-throttled onScroll: hanya baca scrollTop/scrollHeight/clientHeight
  // (tanpa getBoundingClientRect per frame agar tidak memicu layout sync berat).
  const handleScroll = () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const el = chatMessagesRef;
      if (!el) return;
      const dist = distanceFromBottom(el);
      stickToBottom = dist <= BOTTOM_THRESHOLD;
      setShowScrollBtn(dist > BOTTOM_THRESHOLD);
      // Soft top edge fade hanya saat sudah scroll dari atas.
      el.classList.toggle("is-scrolled", el.scrollTop > 8);
    });
  };

  onCleanup(() => {
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
  });

  // Collapse rapid reactive updates into a single scroll.
  // INVARIANT anti-jank: baca layout (scrollHeight) HANYA di dalam rAF di bawah.
  // Jangan baca scrollHeight/scrollTop/clientHeight/getBoundingClientRect per token
  // di luar rAF — itu forced sync layout per token.
  // smooth=true HANYA untuk klik tombol user; follow-streaming selalu instant
  // (smooth berulang = antre animasi scroll → jank).
  let scrollPending = false;
  const scrollToBottom = (smooth = false) => {
    stickToBottom = true;
    setShowScrollBtn(false);
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => {
      scrollPending = false;
      const el = chatMessagesRef;
      if (!el) return;
      if (smooth) {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      } else {
        el.scrollTop = el.scrollHeight;
      }
    });
  };

  const handleScrollBottomClick = () => {
    tapHaptic();
    scrollToBottom(true);
  };

  createEffect(() => {
    messages.length;
    streamingText();
    // Hanya auto-scroll bila user masih di edge bottom (ala ScrollPosition).
    // stickToBottom adalah plain let (bukan signal) jadi tidak ikut tracked.
    // Follow-streaming pakai instant (scrollToBottom() tanpa smooth) agar tidak
    // antre animasi scroll per token.
    if (stickToBottom) scrollToBottom();
  });

  // Ganti conversation → reset ke edge bottom (scrollTarget equivalent).
  createEffect(() => {
    activeConversationId();
    stickToBottom = true;
    setShowScrollBtn(false);
    chatMessagesRef?.classList.remove("is-scrolled");
    scrollToBottom();
  });

  const [toolsMenuOpen, setToolsMenuOpen] = createSignal(false);
  const [modelMenuOpen, setModelMenuOpen] = createSignal(false);
  const [instructionsMenuOpen, setInstructionsMenuOpen] = createSignal(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = createSignal(false);

  // Overlay ala SwiftUI .overlay: hanya satu toolbar popup dalam satu waktu.
  // Buka satu menutup yang lain (minimal, tanpa sistem modal baru).
  const openToolsOnly = (next: boolean) => {
    setModelMenuOpen(false);
    setInstructionsMenuOpen(false);
    setThinkingMenuOpen(false);
    setToolsMenuOpen(next);
  };
  const openModelOnly = (next: boolean) => {
    setToolsMenuOpen(false);
    setInstructionsMenuOpen(false);
    setThinkingMenuOpen(false);
    setModelMenuOpen(next);
  };
  const openInstructionsOnly = (next: boolean) => {
    setToolsMenuOpen(false);
    setModelMenuOpen(false);
    setThinkingMenuOpen(false);
    setInstructionsMenuOpen(next);
  };
  const openThinkingOnly = (next: boolean) => {
    setToolsMenuOpen(false);
    setModelMenuOpen(false);
    setInstructionsMenuOpen(false);
    setThinkingMenuOpen(next);
  };

  // Escape menutup SATU popup aktif (topmost-first, satu per tekan).
  // Listener dipasang hanya saat ada popup terbuka; cleanup via onCleanup effect.
  createEffect(() => {
    const anyOpen = toolsMenuOpen() || modelMenuOpen() || instructionsMenuOpen() || thinkingMenuOpen();
    if (!anyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (modelMenuOpen()) setModelMenuOpen(false);
      else if (thinkingMenuOpen()) setThinkingMenuOpen(false);
      else if (instructionsMenuOpen()) setInstructionsMenuOpen(false);
      else if (toolsMenuOpen()) setToolsMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  // Custom instruction editor state
  const [editingInstruction, setEditingInstruction] = createSignal<{ id?: string; name: string; content: string } | null>(null);

  // Edit mode state: message id being edited, text populates the main input
  const [editingMessageId, setEditingMessageId] = createSignal<string | null>(null);

  // Stable greeting/subtitle/suggestions per mount
  const { greeting, subtitle } = getGreetingAndSubtitle();
  const suggestions = pickN(SUGGESTIONS, 4);

  // Clear edit mode on conversation change so the stale ID doesn't leak
  // into the new context.
  createEffect(() => {
    activeConversationId(); // reactive: re-run on every conversation change
    if (untrack(editingMessageId)) {
      setEditingMessageId(null);
      clearAttachments();
      if (inputRef) {
        inputRef.value = "";
        inputRef.style.height = "auto";
      }
    }
  });

  // Repopulate input when error recovery data is available
  createEffect(() => {
    const text = recoveryText();
    if (text !== null) {
      if (inputRef) {
        inputRef.value = text;
        inputRef.style.height = "auto";
        inputRef.style.height = Math.min(inputRef.scrollHeight, 200) + "px";
      }
      // Restore attachments without re-uploading; their Files API URIs are still valid.
      restoreAttachments([...recoveryAttachments]);
      // Clear recovery data
      setRecoveryText(null);
      setRecoveryAttachments([]);
    }
  });

  // FocusState equivalent: keep a single helper so submit / cancel / edit
  // always return focus to the composer the same way.
  const focusComposer = () => inputRef?.focus();

  // scrollDismissesKeyboard equivalent: user drag on messages dismisses keyboard.
  const dismissComposerKeyboard = () => {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae === inputRef) ae.blur();
  };

  const doSubmit = async () => {
    const input = inputRef;
    const value = input?.value?.trim();
    if (!value && pendingAttachments.length === 0) return;
    if (isStreaming()) return;
    if (hasPendingUploads()) return; // wait for file uploads to finish
    tapHaptic();

    const editId = editingMessageId();
    const text = value || "";
    // Pesan sendiri → ikuti ke bottom (edge bottom re-anchor).
    stickToBottom = true;
    setShowScrollBtn(false);
    input!.value = "";
    input!.style.height = "auto";

    if (editId) {
      setEditingMessageId(null);
      const atts = [...pendingAttachments];
      clearAttachments();
      await editMessage(editId, text, atts);
    } else {
      await sendMessage(text);
    }
    // FocusState equivalent: focus returns to input after submit (keyboard stays up).
    focusComposer();
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    doSubmit();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSubmit();
    }
    if (e.key === "Escape" && editingMessageId()) {
      cancelEdit();
    }
  };

  const handleFileSelect = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      await addAttachment(file);
    }
    input.value = "";
  };

  const handleSuggestionClick = (label: string) => {
    if (inputRef) {
      inputRef.value = label;
      inputRef.focus();
    }
  };

  const activeToolCount = () => {
    let count = 0;
    if (searchEnabled()) count++;
    if (urlContextEnabled()) count++;
    if (codeExecutionEnabled()) count++;
    return count;
  };

  const activeInstructionCount = () => activeInstructionIds.length;

  const handleInstructionSave = async () => {
    const ep = editingInstruction();
    if (!ep || !ep.name.trim() || !ep.content.trim()) return;
    if (ep.id) {
      await updateCustomInstruction(ep.id, { name: ep.name.trim(), content: ep.content.trim() });
    } else {
      await createCustomInstruction(ep.name.trim(), ep.content.trim(), false);
    }
    setEditingInstruction(null);
  };

  const handleInstructionCancel = () => setEditingInstruction(null);

  const thinkingLabel = () => {
    if (!modelSupportsThinking(selectedModel())) return "";
    if (modelAlwaysThinking(selectedModel())) {
      const lvl = thinkingLevel();
      return lvl.charAt(0).toUpperCase() + lvl.slice(1);
    }
    if (!thinkingEnabled()) return "Off";
    if (usesLevelBasedThinking(selectedModel())) {
      const lvl = thinkingLevel();
      return lvl.charAt(0).toUpperCase() + lvl.slice(1);
    }
    return "";
  };

  const currentModelName = () => {
    return AVAILABLE_MODELS.find((m) => m.id === selectedModel())?.name ?? selectedModel();
  };

  // === Edit Mode Helpers ===

  const startEdit = (msg: Message) => {
    const text = msg.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("\n");

    // Load existing file attachments into pending attachments strip
    loadAttachmentsFromParts(msg.parts);

    setEditingMessageId(msg.id);
    if (inputRef) {
      inputRef.value = text;
      inputRef.style.height = "auto";
      inputRef.style.height = Math.min(inputRef.scrollHeight, 200) + "px";
      inputRef.focus();
    }
  };

  const cancelEdit = () => {
    setEditingMessageId(null);
    clearAttachments();
    if (inputRef) {
      inputRef.value = "";
      inputRef.style.height = "auto";
    }
  };

  // === File Type Mapping ===

  const getFileTypeInfo = (mimeType: string): { icon: string; label: string } => {
    if (mimeType.startsWith("image/")) return { icon: "image", label: mimeType.split("/")[1]?.toUpperCase() || "IMG" };
    if (mimeType.startsWith("video/")) return { icon: "videocam", label: "Video" };
    if (mimeType.startsWith("audio/")) return { icon: "audio_file", label: "Audio" };
    if (mimeType === "application/pdf") return { icon: "picture_as_pdf", label: "PDF" };
    if (mimeType.startsWith("text/")) return { icon: "description", label: "TXT" };
    return { icon: "attach_file", label: "File" };
  };

  // === Part Renderers ===

  const renderPart = (part: MessagePart, isUser: boolean) => {
    switch (part.type) {
      case "text":
        return <div class="message-text" innerHTML={renderMarkdown(part.text)} />;

      case "thinking":
        return (
          <details class="message-thinking">
            <summary class="md-typescale-label-medium thinking-label">
              <md-icon class="thinking-icon">psychology</md-icon>
              Thinking
            </summary>
            <div class="thinking-content md-typescale-body-small message-text" innerHTML={renderMarkdown(part.text)} />
          </details>
        );

      case "inlineData":
        // User inlineData is rendered in the attachment row by renderMessage
        if (isUser) return null;
        if (part.mimeType.startsWith("image/")) {
          return (
            <div class="message-image-container">
              <img
                src={`data:${part.mimeType};base64,${part.data}`}
                alt={part.label || "Image"}
                class="message-image"
                loading="lazy"
                decoding="async"
              />
              <div class="image-overlay-actions">
                <button
                  class="image-download-btn"
                  type="button"
                  aria-label="Download image"
                  onClick={() => downloadInlineImage(part.mimeType, part.data, part.label)}
                >
                  <md-icon>download</md-icon>
                </button>
              </div>
            </div>
          );
        }
        return (
          <div class="message-file-chip">
            <md-icon>description</md-icon>
            <span class="md-typescale-label-medium">{part.label || "File"}</span>
          </div>
        );

      case "fileData":
        // User fileData is rendered in the attachment row by renderMessage
        if (isUser) return null;
        // Model-generated fileData is rare but handled.
        return (
          <div class="message-file-chip">
            <md-icon>description</md-icon>
            <span class="md-typescale-label-medium">{part.fileName || "File"}</span>
          </div>
        );

      case "searchGrounding":
        if (!part.sources || part.sources.length === 0) return null;
        return (
          <div class="search-grounding">
            <div class="search-grounding-header md-typescale-label-medium">
              <md-icon>travel_explore</md-icon>
              Sources
            </div>
            <div class="search-sources">
              <For each={part.sources}>
                {(source) => (
                  <a
                    class="search-source-chip"
                    href={source.uri}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <md-icon>open_in_new</md-icon>
                    <span class="md-typescale-label-small">{source.title || new URL(source.uri).hostname}</span>
                  </a>
                )}
              </For>
            </div>
          </div>
        );

      case "functionCall":
        return (
          <div class="function-call-chip">
            <md-icon>functions</md-icon>
            <span class="md-typescale-label-medium">{part.name}</span>
          </div>
        );

      case "functionResponse":
        return null;

      case "executableCode":
        return (
          <div class="exec-code-block">
            <div class="exec-code-header md-typescale-label-small">
              <md-icon>terminal</md-icon>
              <span>{part.language || "Code"}</span>
            </div>
            <pre class="exec-code-pre"><code>{part.code}</code></pre>
          </div>
        );

      case "codeExecutionResult":
        return (
          <div class={`code-exec-result ${part.outcome === "OUTCOME_OK" ? "result-ok" : "result-error"}`}>
            <div class="code-exec-result-header md-typescale-label-small">
              <md-icon>{part.outcome === "OUTCOME_OK" ? "check_circle" : "error_outline"}</md-icon>
              <span>
                {part.outcome === "OUTCOME_OK"
                  ? "Output"
                  : part.outcome === "OUTCOME_DEADLINE_EXCEEDED"
                  ? "Timed Out"
                  : "Error"}
              </span>
            </div>
            <Show when={part.output}>
              <pre class="code-exec-output">{part.output}</pre>
            </Show>
          </div>
        );

      default:
        return null;
    }
  };

  const copyMessageText = (msg: Message) => {
    const text = msg.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("\n");
    navigator.clipboard.writeText(text);
  };

  // NOTE (subagent 3/5): formatTime lama diganti cache modul formatTimeCached
  // (≤500 entri) yang dipakai <MessageTime/> — toLocaleTimeString tidak
  // dipanggil ulang per render row untuk createdAt yang sama.

  // === Snackbar ===

  const [snackbarMessage, setSnackbarMessage] = createSignal<string | null>(null);
  const [snackbarExiting, setSnackbarExiting] = createSignal(false);
  let snackbarDismissTimer: ReturnType<typeof setTimeout> | undefined;
  let snackbarRemoveTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => {
    clearTimeout(snackbarDismissTimer);
    clearTimeout(snackbarRemoveTimer);
  });

  const showSnackbar = (message: string): void => {
    clearTimeout(snackbarDismissTimer);
    clearTimeout(snackbarRemoveTimer);
    setSnackbarExiting(false);
    setSnackbarMessage(message);
    // Auto-dismiss after 4s; remove from DOM after exit animation.
    snackbarDismissTimer = setTimeout(() => {
      setSnackbarExiting(true);
      snackbarRemoveTimer = setTimeout(() => {
        setSnackbarMessage(null);
        setSnackbarExiting(false);
      }, 200);
    }, 4000);
  };

  // Save a base64 inline image to Downloads.
  //
  // Android: uses MediaStore (tauri-plugin-android-fs) because scoped storage
  // (API 29+) blocks direct writes. API 24-28 needs WRITE_EXTERNAL_STORAGE,
  // requested by the plugin.
  // Desktop: uses plugin-fs with BaseDirectory.Download.
  // Browser: falls back to anchor[download].
  //
  // Outcomes are reported via snackbar; errors are not re-thrown because callers
  // are fire-and-forget.
  const downloadInlineImage = async (mimeType: string, base64Data: string, label?: string): Promise<void> => {
    const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
    const uid = crypto.randomUUID();
    const filename = label ? `${label}.${ext}` : `lumi-ai-image-${uid}.${ext}`;
    const bytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));

    if (isTauri() && isAndroid()) {
      const {
        AndroidFs,
        AndroidPublicGeneralPurposeDir,
        getAndroidApiLevel,
      } = await import("tauri-plugin-android-fs-api");

      // Request legacy storage permission on Android 7-9. No-op on API 29+.
      const apiLevel = await getAndroidApiLevel();
      if (apiLevel < 29) {
        const alreadyGranted = await AndroidFs.checkPublicFilesPermission();
        if (!alreadyGranted) {
          const granted = await AndroidFs.requestPublicFilesPermission();
          if (!granted) {
            showSnackbar("Storage permission denied");
            return;
          }
        }
      }

      // Write as pending so other apps don't see the partial file, then scan
      // into MediaStore.
      let uri: AndroidFsUri | undefined;
      try {
        uri = await AndroidFs.createNewPublicFile(
          AndroidPublicGeneralPurposeDir.Download,
          filename,
          mimeType,
          { isPending: true },
        );
        await AndroidFs.writeFile(uri, bytes);
        await AndroidFs.setPublicFilePending(uri, false);
        await AndroidFs.scanPublicFile(uri);
      } catch (err) {
        // Remove the pending file on error.
        if (uri != null) {
          await AndroidFs.removeFile(uri).catch(() => {});
        }
        showSnackbar(`Could not save ${filename}`);
        return;
      }
      showSnackbar(`${filename} saved to Downloads`);
      return;
    }

    if (isTauri()) {
      try {
        const { writeFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");
        await writeFile(filename, bytes, { baseDir: BaseDirectory.Download });
        showSnackbar(`${filename} saved to Downloads`);
        return;
      } catch (err) {
        // Fall back to browser download on desktop.
        console.error("Tauri fs write failed:", err);
      }
    }

    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    showSnackbar(`${filename} downloaded`);
  };

  // Resubmit the message unchanged. Creates a new branch like edit+submit.
  // Passing undefined preserves existing non-text parts.
  const regenerateUserMessage = (msg: Message): void => {
    if (isStreaming()) return;
    const text = msg.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("\n");
    editMessage(msg.id, text, undefined);
  };

  // === Subagent 3/5: child kecil agar actions tidak ikut evaluasi per token ===
  // MessageActions hanya membaca msg (statis per row), isStreaming (boolean
  // yang hanya berubah di awal/akhir stream, bukan per token), branchState,
  // dan messages (untuk isLast). TIDAK membaca streamingText/streamingThinking/
  // streamingImages/dll — jadi komputasinya tidak ter-subscribe ke update
  // per token. Dipakai sebagai <MessageActions msg={msg} isUser={isUser} />.
  const MessageActions = (props: { msg: Message; isUser: boolean }) => {
    const branch = () => props.msg.branchGroupId ? branchState[props.msg.branchGroupId] : undefined;
    const isLast = () => messages[messages.length - 1]?.id === props.msg.id;
    return (
      <div class={`message-actions ${props.isUser ? "actions-user" : "actions-model"}`}>
        <MessageTime createdAt={props.msg.createdAt} />

        {/* Branch navigation on user messages */}
        <Show when={props.isUser && branch()}>
          {(_br) => {
            const b = branch()!;
            return (
              <BranchNav groupId={props.msg.branchGroupId!} activeIndex={b.activeIndex} total={b.total} />
            );
          }}
        </Show>

        <md-icon-button class="action-btn" type="button" aria-label="Copy message" onClick={() => copyMessageText(props.msg)}>
          <md-icon>content_copy</md-icon>
        </md-icon-button>
        <Show when={props.isUser && !isStreaming()}>
          <md-icon-button class="action-btn" type="button" aria-label="Edit message" onClick={() => startEdit(props.msg)}>
            <md-icon>edit</md-icon>
          </md-icon-button>
        </Show>
        <Show when={props.isUser && !isStreaming()}>
          <md-icon-button class="action-btn" type="button" aria-label="Regenerate" onClick={() => regenerateUserMessage(props.msg)}>
            <md-icon>replay</md-icon>
          </md-icon-button>
        </Show>
        <Show when={!props.isUser && isLast() && !isStreaming()}>
          <md-icon-button class="action-btn" type="button" aria-label="Retry" onClick={() => retryMessage()}>
            <md-icon>refresh</md-icon>
          </md-icon-button>
        </Show>
        {/* Branch to new chat: only on model (response) messages */}
        <Show when={!props.isUser && !isStreaming()}>
          <md-icon-button class="action-btn" type="button" aria-label="Branch to new chat" onClick={() => branchToNewChat(props.msg.id)}>
            <md-icon>call_split</md-icon>
          </md-icon-button>
        </Show>
      </div>
    );
  };

  // === Subagent 3/5: skeleton streaming stabil ===
  // Satu .message-bubble tetap dengan 6 slot yang SELALU mounted; visibilitas
  // diatur via `hidden` pada wrapper div polos (bukan <Show> mount-unmount),
  // sehingga bentuk row & DOM tidak di-recreate saat thinking/code/images/text
  // muncul per token.
  // === Subagent 1/5: isi slot markdown diisolasi ke ThrottledMarkdown leaf ===
  // streamingText()/streamingThinking() hanya dibaca di dalam leaf tersebut
  // (rAF ~30fps + fast path plain + settle penuh), bukan di StreamingBubble.
  // Code/images/results dibungkus ke leaf agar tidak subscribe ke token teks.
  const StreamingBubble = () => {
    const hasThinking = () => !!streamingThinking();
    const hasText = () => !!streamingText();
    const hasCode = () => streamingCodeBlocks.length > 0;
    const hasResults = () => streamingCodeResults.length > 0;
    const hasImages = () => streamingImages.length > 0;
    const isTyping = () => !hasText() && !hasThinking() && !hasCode() && !hasResults() && !hasImages();
    return (
      <div class="message message-model is-streaming" id="msg-streaming" data-id="streaming" data-role="model">
        <div class="message-avatar">
          <div class="avatar-icon lumi-logo" />
        </div>
        <div class="message-bubble bubble-model">
          {/* Slot thinking */}
          <div hidden={!hasThinking()}>
            <details class="message-thinking" open>
              <summary class="md-typescale-label-medium thinking-label">
                <md-icon class="thinking-icon">psychology</md-icon>
                Thinking...
              </summary>
              <ThrottledMarkdown text={streamingThinking} cls="thinking-content md-typescale-body-small message-text" />
            </details>
          </div>
          {/* Slot code blocks (append-only; For stabil by identity) */}
          <div hidden={!hasCode()}>
            <StreamingCodeBlocksView />
          </div>
          {/* Slot code results */}
          <div hidden={!hasResults()}>
            <StreamingCodeResultsView />
          </div>
          {/* Slot images */}
          <div hidden={!hasImages()}>
            <StreamingImagesView onDownload={(mimeType, data) => void downloadInlineImage(mimeType, data)} />
          </div>
          {/* Slot text */}
          <div hidden={!hasText()}>
            <ThrottledMarkdown text={streamingText} cls="message-text" />
          </div>
          {/* Slot typing (tampil hanya saat semua slot lain kosong) */}
          <div hidden={!isTyping()}>
            <div class="typing-indicator">
              <span></span><span></span><span></span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderMessage = (msg: Message) => {
    const isUser = msg.role === "user";

    // For user messages, separate file attachments (inlineData/fileData) from text parts
    const userAttachParts = () =>
      isUser ? msg.parts.filter((p) => p.type === "inlineData" || p.type === "fileData") as (
        | { type: "inlineData"; mimeType: string; data: string; label?: string }
        | { type: "fileData"; mimeType: string; fileUri: string; expiresAt: number; apiKeyHint: string; fileName: string; preview?: string }
      )[] : [];
    const userTextParts = () =>
      isUser ? msg.parts.filter((p) => p.type !== "inlineData" && p.type !== "fileData") : [];

    return (
      <div
        class={`message message-enter ${isUser ? "message-user" : "message-model"}`}
        id={`msg-${msg.id}`}
        data-id={msg.id}
        data-role={msg.role}
      >
        <Show when={!isUser}>
          <div class="message-avatar">
            <div class="avatar-icon lumi-logo" />
          </div>
        </Show>
        <div class="message-content-wrapper">
          {/* User attachment row: adaptive grid cells 1/1 (For stabil via part identity; key bukan index) */}
          <Show when={isUser && userAttachParts().length > 0}>
            <div class="user-attach-row" role="list" aria-label="Attached files">
              <For each={userAttachParts()}>
                {(part) => {
                  const isImage = part.mimeType.startsWith("image/");
                  const info = getFileTypeInfo(part.mimeType);
                  // fileData parts use the stored preview thumbnail; inlineData parts have the full base64
                  const imgSrc = part.type === "fileData"
                    ? part.preview
                    : `data:${part.mimeType};base64,${part.data}`;
                  const name = part.type === "fileData" ? part.fileName : (part.label || info.label);
                  return (
                    <div class="user-attach-item" role="listitem" aria-label={name}>
                      <Show
                        when={isImage && imgSrc}
                        fallback={
                          <div class="user-attach-file-icon">
                            <md-icon aria-hidden="true">{info.icon}</md-icon>
                          </div>
                        }
                      >
                        <img
                          class="user-attach-img"
                          src={imgSrc}
                          alt={name}
                          loading="lazy"
                          decoding="async"
                        />
                      </Show>
                      <span class="user-attach-name md-typescale-label-small">{name}</span>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>

          {/* Bubble: model gets all parts; user gets only text parts */}
          <Show when={!isUser || userTextParts().length > 0}>
            <div class={`message-bubble ${isUser ? "bubble-user" : "bubble-model"}`}>
              <For each={isUser ? userTextParts() : msg.parts}>
                {(part) => renderPart(part, isUser)}
              </For>
            </div>
          </Show>

          {/* Actions diisolasi ke child agar timestamp/branch/buttons tidak ikut
              evaluasi per token (hanya butuh msg.id/createdAt/branch). */}
          <MessageActions msg={msg} isUser={isUser} />
        </div>
      </div>
    );
  };

  // === Welcome Screen ===

  const WelcomeScreen = () => {
    return (
      <div class="welcome-screen">
        <div class="welcome-content">
          <h1 class="welcome-greeting">
            {greeting}
          </h1>
          <p class="welcome-subtitle">{subtitle}</p>
          {/* Suggestion chips inside welcome on mobile — SENGAJA horizontal strip (flex),
              bukan grid: 4 chip sejajar scroll-x; jangan grid-di-dalam-grid. */}
          <div class="welcome-suggestions" role="list" aria-label="Suggestions">
            <For each={suggestions}>
              {([icon, label]) => (
                <button class="suggestion-chip" aria-label={label} onClick={() => handleSuggestionClick(label)}>
                  <md-icon aria-hidden="true">{icon}</md-icon>
                  <span>{label}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    );
  };

  // === Suggestion Chips Row — horizontal strip dipertahankan (bukan grid) ===

  const SuggestionRow = () => (
    <div class="suggestion-row" role="list" aria-label="Suggestions">
      <For each={suggestions}>
        {([icon, label]) => (
          <button class="suggestion-chip" aria-label={label} onClick={() => handleSuggestionClick(label)}>
            <md-icon aria-hidden="true">{icon}</md-icon>
            <span>{label}</span>
          </button>
        )}
      </For>
    </div>
  );

  // === Input Area ===

  const InputArea = () => (
    <div class="chat-input-area">
      {/* File preview strip — adaptive grid (For keyed by att.id via object identity; tidak pakai index) */}
      <Show when={pendingAttachments.length > 0}>
        <div class="attachment-strip" role="list" aria-label="Pending attachments">
          <For each={pendingAttachments}>
            {(att) => (
              <div
                class={`attachment-preview${att.uploading ? " uploading" : att.uploadError ? " upload-error" : ""}`}
                role="listitem"
                aria-label={`${att.file.name}${att.uploading ? ", uploading" : att.uploadError ? `, upload error: ${att.uploadError}` : ""}`}
              >
                <Show
                  when={!att.uploading && att.preview}
                  fallback={
                    <div class="attachment-file-icon">
                      <Show
                        when={att.uploading}
                        fallback={<md-icon aria-hidden="true">{att.uploadError ? "error" : "description"}</md-icon>}
                      >
                        <div class="attachment-spinner" aria-hidden="true" />
                      </Show>
                    </div>
                  }
                >
                  <img src={att.preview} alt={att.file.name} class="attachment-thumb" loading="lazy" decoding="async" />
                </Show>
                {/* Status satu sudut konsisten: top-left (remove tetap top-right) */}
                <Show when={att.uploading || att.uploadError}>
                  <span
                    class={`attachment-status ${att.uploading ? "is-uploading" : "is-error"}`}
                    aria-hidden="true"
                  >
                    <Show when={att.uploading} fallback={<md-icon>error</md-icon>}>
                      <span class="attachment-status-dot" />
                    </Show>
                  </span>
                </Show>
                <span class="attachment-name md-typescale-label-small">{att.file.name}</span>
                <Show when={att.uploadError}>
                  <span class="attachment-error-label md-typescale-label-small">{att.uploadError}</span>
                </Show>
                <button type="button" class="attachment-remove" aria-label={`Remove attachment ${att.file.name}`} onClick={() => removeAttachment(att.id)}>
                  <md-icon aria-hidden="true">close</md-icon>
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Upload error banner (shown when upload auto-fails and attachment is removed) */}
      <Show when={fileUploadError()}>
        <div class="upload-error-banner">
          <md-icon class="upload-error-icon">error_outline</md-icon>
          <span class="md-typescale-label-medium">{fileUploadError()}</span>
          <button type="button" class="icon-btn icon-btn-sm upload-error-dismiss" aria-label="Dismiss upload error" onClick={() => setFileUploadError(null)}>
            <md-icon>close</md-icon>
          </button>
        </div>
      </Show>

      <form class="chat-form" onSubmit={handleSubmit}>
        {/* Edit mode banner */}
        <Show when={editingMessageId()}>
          <div class="edit-banner">
            <md-icon class="edit-banner-icon">edit</md-icon>
            <span class="md-typescale-label-medium">Editing message</span>
            <md-icon-button class="edit-banner-close" type="button" aria-label="Cancel edit" onClick={() => cancelEdit()}>
              <md-icon>close</md-icon>
            </md-icon-button>
          </div>
        </Show>

        <div class="input-row">
          <div class="input-field-wrapper">
            <textarea
              ref={inputRef}
              rows={1}
              placeholder={editingMessageId() ? "Edit your message..." : "Message Lumi AI..."}
              aria-label="Message Lumi AI"
              class="chat-input"
              enterkeyhint="send"
              autocapitalize="sentences"
              autocomplete="off"
              autocorrect="off"
              spellcheck={false}
              onKeyDown={handleKeyDown}
              disabled={isViewingActiveStream()}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 200) + "px";
              }}
            />
          </div>
        </div>
        <div class="input-toolbar">
          {/* Attach button */}
          <md-icon-button
            type="button"
            aria-label="Attach files"
            onClick={() => fileInputRef?.click()}
            disabled={isViewingActiveStream()}
          >
            <md-icon>add</md-icon>
          </md-icon-button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/*,audio/*,application/pdf,text/*,.py,.js,.ts,.json,.csv,.md,.xml,.html,.rtf,.epub"
            style="display:none"
            onChange={handleFileSelect}
          />

          {/* Tools button */}
          <div class="toolbar-menu-anchor">
            <md-icon-button
              type="button"
              aria-label="Tools"
              onClick={() => { tapHaptic(); openToolsOnly(!toolsMenuOpen()); }}
              class={activeToolCount() > 0 ? "tools-active" : ""}
            >
              <md-icon>build</md-icon>
            </md-icon-button>
            <Show when={activeToolCount() > 0}>
              <span class="tool-badge numeric-tnum">
                <Show when={String(activeToolCount())} keyed>
                  {(v) => <span class="numeric-swap" data-key={v}>{v}</span>}
                </Show>
              </span>
            </Show>
            <Show when={toolsMenuOpen()}>
              <div class="toolbar-popup tools-popup" role="dialog" aria-label="Tools" onClick={(e) => e.stopPropagation()}>
                <div class="popup-header form-section-header md-typescale-title-small">Tools</div>
                <label class="tool-toggle">
                  <md-icon>travel_explore</md-icon>
                  <span>Google Search</span>
                  <input
                    type="checkbox"
                    checked={searchEnabled()}
                    onChange={(e) => setSearchEnabled(e.currentTarget.checked)}
                  />
                  <span class={`toggle-track ${searchEnabled() ? "on" : ""}`}>
                    <span class="toggle-thumb" />
                  </span>
                </label>
                {/* URL Context is not supported by all models (e.g. Gemma 4). */}
                <Show when={modelSupportsUrlContext(selectedModel())}>
                  <label class="tool-toggle">
                    <md-icon>link</md-icon>
                    <span>URL Context</span>
                    <input
                      type="checkbox"
                      checked={urlContextEnabled()}
                      onChange={(e) => setUrlContextEnabled(e.currentTarget.checked)}
                    />
                    <span class={`toggle-track ${urlContextEnabled() ? "on" : ""}`}>
                      <span class="toggle-thumb" />
                    </span>
                  </label>
                </Show>
                <Show when={modelSupportsCodeExecution(selectedModel())}>
                  <label class="tool-toggle">
                    <md-icon>code</md-icon>
                    <span>Code Execution</span>
                    <input
                      type="checkbox"
                      checked={codeExecutionEnabled()}
                      onChange={(e) => setCodeExecutionEnabled(e.currentTarget.checked)}
                    />
                    <span class={`toggle-track ${codeExecutionEnabled() ? "on" : ""}`}>
                      <span class="toggle-thumb" />
                    </span>
                  </label>
                </Show>
              </div>
              <div class="popup-backdrop" onClick={() => setToolsMenuOpen(false)} />
            </Show>
          </div>

          {/* Custom Instructions button */}
          <div class="toolbar-menu-anchor">
            <md-icon-button
              type="button"
              aria-label="Custom Instructions"
              onClick={() => { tapHaptic(); openInstructionsOnly(!instructionsMenuOpen()); setEditingInstruction(null); }}
              class={activeInstructionCount() > 0 ? "tools-active" : ""}
            >
              <md-icon>tune</md-icon>
            </md-icon-button>
            <Show when={activeInstructionCount() > 0}>
              <span class="tool-badge numeric-tnum">
                <Show when={String(activeInstructionCount())} keyed>
                  {(v) => <span class="numeric-swap" data-key={v}>{v}</span>}
                </Show>
              </span>
            </Show>
            <Show when={instructionsMenuOpen()}>
              <div class="toolbar-popup instructions-popup" role="dialog" aria-label="Custom Instructions" onClick={(e) => e.stopPropagation()}>
                <div class="popup-header form-section-header md-typescale-title-small">
                  <span>Custom Instructions</span>
                  <button
                    type="button"
                    class="icon-btn"
                    aria-label="Add instruction"
                    onClick={() => setEditingInstruction({ name: "", content: "" })}
                  >
                    <md-icon>add</md-icon>
                  </button>
                </div>

                {/* Inline editor — modal-form style: name + content, Save validates */}
                <Show when={editingInstruction()}>
                  <div class="instruction-editor">
                    <input
                      ref={(el) => el.focus()}
                      type="text"
                      class="instruction-editor-name"
                      placeholder="Instruction name"
                      aria-label="Instruction name"
                      value={editingInstruction()!.name}
                      autocapitalize="sentences"
                      autocomplete="off"
                      autocorrect="off"
                      spellcheck={false}
                      enterkeyhint="next"
                      onInput={(e) => setEditingInstruction({ ...editingInstruction()!, name: e.currentTarget.value })}
                    />
                    <textarea
                      class="instruction-editor-content"
                      placeholder="Instruction content..."
                      aria-label="Instruction content"
                      rows={4}
                      value={editingInstruction()!.content}
                      autocapitalize="sentences"
                      autocomplete="off"
                      autocorrect="off"
                      spellcheck={false}
                      enterkeyhint="enter"
                      onInput={(e) => setEditingInstruction({ ...editingInstruction()!, content: e.currentTarget.value })}
                    />
                    <div class="instruction-editor-actions">
                      <button type="button" class="text-btn" onClick={handleInstructionCancel}>Cancel</button>
                      <button
                        type="button"
                        class="tonal-btn"
                        onClick={handleInstructionSave}
                        disabled={!editingInstruction()?.name.trim() || !editingInstruction()?.content.trim()}
                      >Save</button>
                    </div>
                  </div>
                </Show>

                {/* Instruction list */}
                <Show when={customInstructions.length > 0}>
                  <div class="instruction-list">
                    <For each={customInstructions}>
                      {(instruction) => (
                        <div class="instruction-item">
                          <label class="instruction-toggle">
                            <input
                              type="checkbox"
                              checked={activeInstructionIds.includes(instruction.id)}
                              onChange={() => toggleInstructionActive(instruction.id)}
                            />
                            <span class={`toggle-track ${activeInstructionIds.includes(instruction.id) ? "on" : ""}`}>
                              <span class="toggle-thumb" />
                            </span>
                          </label>
                          <button
                            type="button"
                            class="instruction-info instruction-info-btn"
                            onClick={() => toggleInstructionActive(instruction.id)}
                            aria-pressed={activeInstructionIds.includes(instruction.id)}
                            aria-label={`Toggle ${instruction.name}`}
                          >
                            <span class="md-typescale-body-medium">{instruction.name}</span>
                            <span class="md-typescale-label-small instruction-preview">
                              {instruction.content.slice(0, 60)}{instruction.content.length > 60 ? "…" : ""}
                            </span>
                          </button>
                          <button
                            type="button"
                            class="icon-btn icon-btn-sm"
                            aria-label="Edit instruction"
                            onClick={() => setEditingInstruction({ id: instruction.id, name: instruction.name, content: instruction.content })}
                          >
                            <md-icon>edit</md-icon>
                          </button>
                          <button
                            type="button"
                            class="icon-btn icon-btn-sm"
                            aria-label="Delete instruction"
                            onClick={() => deleteCustomInstruction(instruction.id)}
                          >
                            <md-icon>delete</md-icon>
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={customInstructions.length === 0 && !editingInstruction()}>
                  <div class="instruction-empty md-typescale-body-small">
                    No custom instructions yet. Add one to customize AI behavior.
                  </div>
                </Show>
              </div>
              <div class="popup-backdrop" onClick={() => setInstructionsMenuOpen(false)} />
            </Show>
          </div>

          {/* Thinking toggle (only for models that support it) */}
          <Show when={modelSupportsThinking(selectedModel())}>
            <div class="toolbar-menu-anchor">
              <button
                type="button"
                class={`thinking-btn ${thinkingEnabled() ? "thinking-active" : ""}`}
                onClick={() => { tapHaptic(); openThinkingOnly(!thinkingMenuOpen()); }}
              >
                <md-icon>psychology</md-icon>
                {/* label swap 150ms fade: inner me-remount via <Show keyed>;
                    outer stabil agar layout tidak geser; tanpa ubah handler. */}
                <span class="md-typescale-label-medium label-fade-wrap">
                  <Show when={thinkingLabel()} keyed>
                    {(v) => <span class="label-swap" data-key={v}>{v}</span>}
                  </Show>
                </span>
              </button>
              <Show when={thinkingMenuOpen()}>
                <div class="toolbar-popup thinking-popup" role="dialog" aria-label="Thinking settings" onClick={(e) => e.stopPropagation()}>
                  <div class="popup-header form-section-header md-typescale-title-small">Thinking</div>

                  {/* Hide enable toggle for models that always think (e.g. Gemini 3 Pro) */}
                  <Show when={!modelAlwaysThinking(selectedModel())}>
                    <label class="tool-toggle">
                      <md-icon>psychology</md-icon>
                      <span>Enable Thinking</span>
                      <input
                        type="checkbox"
                        checked={thinkingEnabled()}
                        onChange={(e) => setThinkingEnabled(e.currentTarget.checked)}
                      />
                      <span class={`toggle-track ${thinkingEnabled() ? "on" : ""}`}>
                        <span class="toggle-thumb" />
                      </span>
                    </label>
                  </Show>

                  {/* Level selector (always visible for alwaysThinking, conditional for others) */}
                  <Show when={usesLevelBasedThinking(selectedModel()) && (modelAlwaysThinking(selectedModel()) || thinkingEnabled())}>
                    <div class="thinking-levels">
                      <div class="md-typescale-label-small thinking-levels-label form-section-header">Thinking Level</div>
                      <div class="thinking-level-options">
                        <For each={getModelThinkingLevels(selectedModel())}>
                          {(lvl) => (
                            <button
                              type="button"
                              class={`thinking-level-btn ${thinkingLevel() === lvl ? "selected" : ""}`}
                              onClick={() => setThinkingLevel(lvl as "low" | "medium" | "high")}
                            >
                              {lvl.charAt(0).toUpperCase() + lvl.slice(1)}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                </div>
                <div class="popup-backdrop" onClick={() => setThinkingMenuOpen(false)} />
              </Show>
            </div>
          </Show>

          <div class="toolbar-spacer" />

          {/* Model selector */}
          <div class="toolbar-menu-anchor">
            <button
              type="button"
              class="model-selector-btn"
              onClick={() => { tapHaptic(); openModelOnly(!modelMenuOpen()); }}
              disabled={isViewingActiveStream()}
            >
              <span class="md-typescale-label-large label-fade-wrap">
                <Show when={currentModelName()} keyed>
                  {(v) => <span class="label-swap" data-key={v}>{v}</span>}
                </Show>
              </span>
              <md-icon>expand_more</md-icon>
            </button>
            <Show when={modelMenuOpen()}>
              <div class="toolbar-popup model-popup" onClick={(e) => e.stopPropagation()}>
                <For each={AVAILABLE_MODELS}>
                  {(model) => (
                    <button
                      type="button"
                      class={`model-option ${model.id === selectedModel() ? "selected" : ""}`}
                      onClick={() => {
                        setSelectedModel(model.id);
                        clampThinkingLevelForModel(model.id);
                        clampUrlContextForModel(model.id);
                        setModelMenuOpen(false);
                      }}
                    >
                      <div>
                        <div class="md-typescale-body-medium">{model.name}</div>
                      </div>
                      <Show when={model.id === selectedModel()}>
                        <md-icon class="model-check">check_circle</md-icon>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
              <div class="popup-backdrop" onClick={() => setModelMenuOpen(false)} />
            </Show>
          </div>

          {/* Send / Stop button — iOS 26 compose: 32px blue circle, white arrow */}
          <button
            type="button"
            aria-label={isViewingActiveStream() ? "Stop generating" : "Send message"}
            disabled={(isStreaming() && !isViewingActiveStream()) || hasPendingUploads()}
            class={`send-button ${isViewingActiveStream() ? "is-stop" : ""}`}
            onClick={() => { if (isViewingActiveStream()) { tapHaptic(); stopStreaming(); } else { doSubmit(); } }}
          >
            <md-icon>{isViewingActiveStream() ? "stop" : editingMessageId() ? "check" : "arrow_upward"}</md-icon>
          </button>
        </div>
      </form>
    </div>
  );

  return (
    <div class="chat-view">
      <div class="chat-topbar">
        <md-icon-button class="sidebar-toggle" type="button" aria-label="Toggle sidebar" onClick={() => setSidebarOpen((prev) => !prev)}>
          <md-icon>{sidebarOpen() ? "menu_open" : "menu"}</md-icon>
        </md-icon-button>
        <span class="md-typescale-title-medium chat-topbar-title">
          {activeConversation()?.title || "Lumi AI"}
        </span>
        <div class="topbar-spacer" />
        <Show when={activeConversationId()}>
          <md-icon-button type="button" aria-label="New chat" onClick={() => selectConversation(null)}>
            <md-icon>edit_square</md-icon>
          </md-icon-button>
        </Show>
      </div>

      <Show
        when={activeConversationId()}
        fallback={
          <div class="welcome-layout">
            <WelcomeScreen />
            <div class="welcome-input-group">
              <InputArea />
              <SuggestionRow />
            </div>
          </div>
        }
      >
        <div class="chat-feed-wrap">
          <div class="chat-messages" ref={chatMessagesRef} onScroll={handleScroll} onTouchMove={dismissComposerKeyboard}>
          <For each={messages}>{(msg) => renderMessage(msg)}</For>

          {/* Streaming response: only shown when viewing the branch that's streaming.
              Skeleton stabil via <StreamingBubble/>: satu .message-bubble dengan
              slot hidden (bukan Show mount-unmount) agar DOM tidak di-recreate
              per token. */}
          <Show when={isViewingActiveStream()}>
            <StreamingBubble />
          </Show>

          <Show when={chatError()}>
            <div class="chat-error md-typescale-body-medium" id="msg-error" data-id="error">
              <md-icon class="error-icon">error_outline</md-icon>
              {chatError()}
            </div>
          </Show>
          </div>

          {/* Floating scroll-to-bottom ala iOS: selalu mounted agar transisi keluar mulus */}
          <button
            type="button"
            class={`scroll-bottom-btn${showScrollBtn() ? " visible" : ""}`}
            aria-label="Scroll to bottom"
            aria-hidden={!showScrollBtn()}
            tabIndex={showScrollBtn() ? 0 : -1}
            onClick={handleScrollBottomClick}
          >
            <md-icon>arrow_downward</md-icon>
          </button>
        </div>

        <InputArea />
      </Show>

      <Show when={snackbarMessage() !== null}>
        <div
          class={`snackbar${snackbarExiting() ? " snackbar--exiting" : ""}`}
          role="status"
        >
          <span class="snackbar-text md-typescale-body-medium">{snackbarMessage()}</span>
        </div>
      </Show>
    </div>
  );
}
