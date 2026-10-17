import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type UIEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  LogicalPosition,
  LogicalSize,
  currentMonitor,
  getCurrentWindow,
} from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  clearChatHistory as clearChatHistoryApi,
  deleteChat as deleteChatApi,
  deleteMessage as deleteMessageApi,
  getChatMemory,
  renameChat,
} from "./api/tauri";
import gleeWordmark from "./assets/brand/glee-wordmark-approved-512w.png";
import {
  chatParticipantIds as chatParticipantIdsCore,
  dedupeIds as dedupeIdsCore,
  isGroupChatMode as isGroupChatModeCore,
} from "./lib/chat-domain";
import { dismissBootOverlay } from "./lib/boot-overlay";
import { useBootstrap } from "./features/bootstrap/use-bootstrap";
import { useRuntimeManagement } from "./features/runtime/use-runtime-management";
import {
  canExportCharacterCardAsPng,
  useCharacterManagement,
} from "./features/characters/use-character-management";
import { useCharacterPortrait } from "./features/characters/use-character-portrait";
import { suggestUserRole } from "./features/characters/suggest-user-role";
import { useContextMemory } from "./features/context/use-context-memory";
import { useProfileManagement } from "./features/profile/use-profile-management";
import { usePresetManagement } from "./features/presets/use-preset-management";
import { useChatOrchestration } from "./features/chat/use-chat-orchestration";
import {
  isGenerationFailureContent,
} from "./features/chat/generation-failure";
import { GenerationFailureEvent } from "./features/chat/generation-failure-event";
import { nextStreamingTextFrame } from "./features/chat/streaming-presentation";
import { resolveReplyPresentation } from "./features/chat/reply-presentation";
import { useCommandPalette } from "./features/command-palette/use-command-palette";
import { useDiagnostics } from "./features/diagnostics/use-diagnostics";
import { GleeIcon, type GleeIconName } from "./components/glee-icon";
import {
  THEME_OPTIONS,
  applyTheme,
  persistTheme,
  readStoredTheme,
  type ThemeId,
} from "./features/theme/theme-domain";
import {
  buildRuntimeRecoveryPlan,
  buildRuntimeRecoveryMessage,
  summarizeDiagnostics,
} from "./features/diagnostics/diagnostics-domain";
import { emptyMemory, normalizeError, sortChatsByRecent } from "./features/app/app-domain";
import { MemoryManager } from "./features/memory/memory-manager";
import { useMemoryItems } from "./features/memory/use-memory-items";
import { PersonaManager } from "./features/personas/persona-manager";
import { PersonaPicker } from "./features/personas/persona-picker";
import { SetupBanner } from "./features/bootstrap/setup-banner";
import { UpdateBanner } from "./features/updates/update-banner";
import { UpdateSettingsSection } from "./features/updates/update-settings-section";
import { useUpdates } from "./features/updates/use-updates";
import { useResourceSetup } from "./features/bootstrap/use-resource-setup";
import { GroupReplyControls } from "./features/chat/group-reply-controls";
import {
  ComposerExtensionTools,
  ExtensionSettings,
  MessageExtensionActions,
} from "./features/extensions/extension-slots";
import { useRegisteredCommands } from "./extensions/react";
import { usePersonas } from "./features/personas/use-personas";
import {
  useAppStore,
  useCharacterStore,
  useChatStore,
  useContextStore,
  useModelStore,
  usePresetStore,
  useProfileStore,
} from "./stores";
import { createEmptyDraft, draftFromCharacter } from "./stores/character-store";
import { createEmptyRelationshipState } from "./stores/profile-store";
import type {
  Character,
  ChatMessage,
  ChatSummary,
  ModelDownloadProgress,
  RuntimePerformanceMode,
  RuntimeState,
} from "./types";
import "./App.css";

const FALLBACK_RUNTIME_STATE: RuntimeState = {
  status: "stopped",
  endpoint: "http://127.0.0.1:8080",
};

const CHARACTER_COLORS = [
  { accent: "#F472B6", light: "#FDF2F8", border: "#FBCFE8" },
  { accent: "#3B82F6", light: "#EFF6FF", border: "#BFDBFE" },
  { accent: "#8B5CF6", light: "#F5F3FF", border: "#DDD6FE" },
  { accent: "#F97316", light: "#FFF7ED", border: "#FED7AA" },
  { accent: "#14B8A6", light: "#F0FDFA", border: "#99F6E4" },
  { accent: "#22C55E", light: "#F0FDF4", border: "#BBF7D0" },
];

const CHARACTER_EMOJIS = ["🌸", "🧠", "🎨", "🚀", "⚡", "🌿", "🎭", "🔥"];
const SAFE_RUNTIME_CONTEXT_SIZE = 8192;

type LibraryTab = "characters" | "chats";
type WorkspaceMode = "hub" | "character" | "chat";
type CharacterTheme = { accent: string; light: string; border: string; emoji: string };

const CharacterEditorPanel = lazy(() =>
  import("./features/characters/character-editor-panel").then((module) => ({
    default: module.CharacterEditorPanel,
  })),
);
const DiagnosticsWorkspace = lazy(() =>
  import("./features/diagnostics/diagnostics-workspace").then((module) => ({
    default: module.DiagnosticsWorkspace,
  })),
);

function IconLabel({
  icon,
  children,
  size = 15,
}: {
  icon: GleeIconName;
  children: ReactNode;
  size?: number;
}) {
  return (
    <span className="glee-icon-label">
      <GleeIcon name={icon} size={size} />
      <span>{children}</span>
    </span>
  );
}

function dedupeIds(ids: string[]): string[] {
  return dedupeIdsCore(ids);
}

function resolveChatCompletionsUrl(endpoint: string): string {
  const safeEndpoint = endpoint.trim() || FALLBACK_RUNTIME_STATE.endpoint;
  const normalized = safeEndpoint.replace(/\/+$/, "");
  if (normalized.endsWith("/v1/chat/completions")) {
    return normalized;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
}

function chatParticipantIds(chat: ChatSummary | null, override?: string[]): string[] {
  return chatParticipantIdsCore(chat, override);
}

function isGroupChatMode(chat: ChatSummary | null, participantIds: string[]): boolean {
  return isGroupChatModeCore(chat, participantIds);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 || size >= 10 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function modelDownloadProgressText(progress: ModelDownloadProgress): string {
  const attempt =
    progress.maxAttempts > 1
      ? `Attempt ${progress.attempt}/${progress.maxAttempts}. `
      : "";
  if (progress.phase === "retrying") {
    return `${attempt}Retrying ${progress.fileName}...`;
  }
  if (progress.phase === "ready") {
    return `${progress.fileName} downloaded and verified.`;
  }
  const downloaded = formatBytes(progress.downloadedBytes);
  const total = progress.totalBytes ? ` of ${formatBytes(progress.totalBytes)}` : "";
  return `${attempt}${progress.phase === "starting" ? "Starting" : "Downloading"} ${progress.fileName}: ${downloaded}${total}.`;
}

function hashIndex(value: string, mod: number): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return mod === 0 ? 0 : hash % mod;
}

function normalizeDraftList(value: string): string {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .join(", ");
}

function themeForCharacter(characterId: string): CharacterTheme {
  const color = CHARACTER_COLORS[hashIndex(characterId, CHARACTER_COLORS.length)];
  const emoji = CHARACTER_EMOJIS[hashIndex(`${characterId}-emoji`, CHARACTER_EMOJIS.length)];
  return { ...color, emoji };
}

function displayTime(iso: string): string {
  if (!iso) {
    return "";
  }
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function displayDate(iso: string): string {
  if (!iso) {
    return "Unknown";
  }
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function renderMessageContent(
  content: string,
  _role: "assistant" | "user",
  _keyPrefix: string,
  _speakerName?: string,
): ReactNode {
  return <div className="bubble-content">{content}</div>;
}

function SmoothStreamingContent({
  content,
  onDisplayedContentChange,
  typingDotsStyle,
}: {
  content: string;
  onDisplayedContentChange: () => void;
  typingDotsStyle?: CSSProperties;
}): ReactNode {
  const [displayedContent, setDisplayedContent] = useState("");
  const targetContentRef = useRef(content);
  const displayedContentRef = useRef("");
  const onDisplayedContentChangeRef = useRef(onDisplayedContentChange);

  useEffect(() => {
    onDisplayedContentChangeRef.current = onDisplayedContentChange;
  }, [onDisplayedContentChange]);

  useEffect(() => {
    if (!content.trim() && displayedContentRef.current) {
      return;
    }
    targetContentRef.current = content;
    if (!content.startsWith(displayedContentRef.current)) {
      displayedContentRef.current = content;
      setDisplayedContent(content);
    }
  }, [content]);

  useEffect(() => {
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let timeoutId = 0;

    const revealNextFrame = () => {
      const target = targetContentRef.current;
      const current = displayedContentRef.current;
      const next = reducedMotion
        ? target
        : nextStreamingTextFrame(current, target);

      if (next !== current) {
        displayedContentRef.current = next;
        setDisplayedContent(next);
        window.requestAnimationFrame(() => {
          onDisplayedContentChangeRef.current();
        });
      }

      timeoutId = window.setTimeout(
        revealNextFrame,
        next === target ? 48 : 24,
      );
    };

    revealNextFrame();
    return () => window.clearTimeout(timeoutId);
  }, []);

  if (!displayedContent.trim()) {
    return (
      <div
        className="typing-dots"
        style={typingDotsStyle}
        role="status"
        aria-label="Character is thinking"
      >
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="bubble-content streaming-content" aria-live="off">
      {displayedContent}
    </div>
  );
}

function runtimeStatusText(runtime: RuntimeState): string {
  if (runtime.status === "running") {
    return "Running";
  }
  if (runtime.status === "starting") {
    return "Starting";
  }
  if (runtime.status === "error") {
    return "Error";
  }
  return "Stopped";
}

function HubRuntimeStatus({
  runtime,
  startingRuntime,
}: {
  runtime: RuntimeState;
  startingRuntime: boolean;
}): ReactNode {
  let label = runtimeStatusText(runtime);
  let tone: "blocked" | "ready" = "blocked";

  if (runtime.status === "running") {
    label = "Running";
    tone = "ready";
  } else if (runtime.status === "starting") {
    label = "Starting";
  } else if (startingRuntime) {
    label = "Preparing";
  }

  return (
    <strong className={`model-status-value ${tone}`} aria-live="polite">
      <span className="model-status-light" aria-hidden="true" />
      <span>{label}</span>
    </strong>
  );
}

function runtimeAccelerationText(runtime: RuntimeState): string {
  const backend = runtime.selection?.backend;
  if (backend === "cuda") {
    return "GPU acceleration";
  }
  if (backend === "vulkan") {
    return "GPU acceleration";
  }
  if (backend === "metal") {
    return "Apple graphics acceleration";
  }
  return "CPU compatible mode";
}

function runtimeHardwareText(runtime: RuntimeState): string {
  const selectedGpu = runtime.selection?.detectedGpus?.[0];
  if (runtime.selection?.backend && runtime.selection.backend !== "cpu" && selectedGpu?.name) {
    return selectedGpu.name;
  }
  if (runtime.selection?.fallbackReason) {
    return "CPU fallback";
  }
  return "Automatic";
}

interface CommandAction {
  id: string;
  label: string;
  hint: string;
  run: () => void | Promise<void>;
}

interface ContextDraft {
  scope: "global" | "character";
  title: string;
  keywords: string;
  content: string;
  enabled: boolean;
}

function textOr(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function snippetPreview(content: string, maxLength = 220): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function createEmptyContextDraft(): ContextDraft {
  return {
    scope: "character",
    title: "",
    keywords: "",
    content: "",
    enabled: true,
  };
}

function displayPath(path?: string): string {
  if (!path) {
    return "-";
  }
  return path.replace(/^\\\\\?\\/, "");
}

function initialsForName(name?: string): string {
  const parts = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) {
    return "U";
  }
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function fileBaseName(path?: string): string {
  return path?.split(/[/\\]/).pop() || "";
}

function CharacterAvatar({
  character,
  theme,
  className = "",
  style,
}: {
  character?: Character;
  theme: CharacterTheme;
  className?: string;
  style?: CSSProperties;
}) {
  const portraitSrc = useCharacterPortrait(character?.avatar);
  const vars = {
    "--accent": theme.accent,
    "--accent-light": theme.light,
    "--accent-border": theme.border,
    ...style,
  } as CSSProperties;

  return (
    <div className={`char-avatar${className ? ` ${className}` : ""}`} style={vars}>
      {portraitSrc ? (
        <img src={portraitSrc} alt={character?.name ? `${character.name} portrait` : "Character portrait"} />
      ) : (
        <span>{theme.emoji}</span>
      )}
    </div>
  );
}

function CharacterCardPortrait({
  character,
  theme,
}: {
  character?: Character;
  theme: CharacterTheme;
}) {
  const portraitSrc = useCharacterPortrait(character?.avatar);
  const vars = {
    "--accent": theme.accent,
    "--accent-light": theme.light,
    "--accent-border": theme.border,
  } as CSSProperties;

  return (
    <div
      className={`character-card-portrait${portraitSrc ? " has-portrait" : " is-fallback"}`}
      style={vars}
    >
      {portraitSrc ? (
        <img src={portraitSrc} alt={character?.name ? `${character.name} portrait` : "Character portrait"} />
      ) : (
        <span>{theme.emoji}</span>
      )}
    </div>
  );
}

function UserProfileAvatar({
  imagePath,
  name,
  className = "",
}: {
  imagePath?: string;
  name?: string;
  className?: string;
}) {
  const portraitSrc = useCharacterPortrait(imagePath);

  return (
    <div className={`profile-avatar${className ? ` ${className}` : ""}`}>
      {portraitSrc ? (
        <img src={portraitSrc} alt={name ? `${name} profile` : "User profile"} />
      ) : (
        <span>{initialsForName(name)}</span>
      )}
    </div>
  );
}

function RuntimeRecoverySupportCard({
  plan,
  runtime,
  canRetryStart,
  startingRuntime,
  exportingDiagnostics,
  creatingDatabaseBackup,
  onRetryStart,
  onOpenDiagnostics,
  onExportDiagnostics,
  onBackupDatabase,
  onCopySupportSummary,
  onCopyRuntimeLog,
}: {
  plan: ReturnType<typeof buildRuntimeRecoveryPlan>;
  runtime: RuntimeState;
  canRetryStart: boolean;
  startingRuntime: boolean;
  exportingDiagnostics: boolean;
  creatingDatabaseBackup: boolean;
  onRetryStart: () => void | Promise<void>;
  onOpenDiagnostics: () => void;
  onExportDiagnostics: () => void | Promise<void>;
  onBackupDatabase: () => void | Promise<void>;
  onCopySupportSummary: () => void | Promise<void>;
  onCopyRuntimeLog: () => void | Promise<void>;
}) {
  return (
    <div className="inspector-helper-card runtime-recovery-card">
      <div className="runtime-recovery-copy">
        <div>
          <strong>{plan.headline}</strong>
          <p>{plan.message}</p>
        </div>
        {plan.steps.length > 0 && (
          <ul className="feature-list runtime-recovery-list">
            {plan.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        )}
        <p className="runtime-recovery-support-note">
          Need help? Export the diagnostics bundle and include the copied support summary when reporting the beta issue.
        </p>
      </div>
      <div className="runtime-recovery-actions">
        <button
          type="button"
          className="primary"
          disabled={startingRuntime || !canRetryStart}
          onClick={() => void onRetryStart()}
        >
          {startingRuntime ? "Retrying..." : "Retry Start"}
        </button>
        <button type="button" className="ghost" onClick={onOpenDiagnostics}>
          <IconLabel icon="diagnostics">Open Diagnostics</IconLabel>
        </button>
        <button
          type="button"
          className="ghost"
          disabled={exportingDiagnostics}
          onClick={() => void onExportDiagnostics()}
        >
          <IconLabel icon="export">{exportingDiagnostics ? "Exporting..." : "Export Bundle"}</IconLabel>
        </button>
        <button type="button" className="ghost" onClick={() => void onCopySupportSummary()}>
          Copy Summary
        </button>
        {runtime.logFile && (
          <button type="button" className="ghost" onClick={() => void onCopyRuntimeLog()}>
            Copy Log Path
          </button>
        )}
        <button
          type="button"
          className="ghost"
          disabled={creatingDatabaseBackup}
          onClick={() => void onBackupDatabase()}
        >
          {creatingDatabaseBackup ? "Backing up..." : "Backup DB"}
        </button>
      </div>
    </div>
  );
}

function RuntimeStartupSummaryCard({ runtime }: { runtime: RuntimeState }) {
  return (
    <div className="inspector-helper-card runtime-settings-card">
      <div className="runtime-settings-copy">
        <strong>Local runtime</strong>
        <p>{runtimeAccelerationText(runtime)}</p>
      </div>
      <ul className="meta-list">
        <li><span>Mode</span><strong>Automatic</strong></li>
        <li><span>Hardware</span><strong>{runtimeHardwareText(runtime)}</strong></li>
        <li><span>Status</span><strong>{runtimeStatusText(runtime)}</strong></li>
      </ul>
    </div>
  );
}

export default function App() {
  const {
    booting,
    notice,
    commandPaletteOpen,
    commandFilter,
    detailTab,
    setNotice,
    setCommandPaletteOpen,
    setCommandFilter,
    setDetailTab,
  } = useAppStore();
  const {
    models,
    runtime,
    importingModel,
    downloadingModel,
    modelDownloadProgress,
    startingRuntime,
    stoppingRuntime,
  } = useModelStore();
  const {
    characters,
    editingCharacterId,
    searchInput,
    editorMode,
    draft,
    savingCharacter,
    importingCard,
    setActiveCharacterId,
    setSearchInput,
    setDraft,
    startCreate: startCreateCharacter,
    startEdit: startEditCharacter,
    cancelEditor: cancelCharacterEditor,
  } = useCharacterStore();
  const {
    chats,
    activeChatId,
    messagesByChat,
    participantsByChat,
    composerInput,
    replyStateByChat,
    streamingByChat,
    editingMessageId,
    editingMessageDraft,
    messageActionBusyId,
    savingMemory,
    groupBuilderOpen,
    groupTitle,
    groupSelection,
    creatingGroup,
    setChats,
    setActiveChatId,
    setComposerInput,
    setMessagesByChat,
    setParticipantsByChat,
    setMemoryByChat,
    setMessageActionBusyId,
    setGroupBuilderOpen,
    setGroupTitle,
    setGroupSelection,
    setEditingMessageDraft,
  } = useChatStore();
  const {
    contextEntries,
    activeContextHits,
    activeMemoryHits,
    contextDraft,
    savingContext,
    setActiveContextHits,
    setActiveMemoryHits,
    setContextDraft,
  } = useContextStore();
  const { hydrateRelationshipState } = useProfileStore();
  const {
    generationPresets,
    activeGenerationPresetId,
    generationEditorMode,
    generationPresetDraft,
    savingGenerationPreset,
    deletingPresetKey,
    presetProfileByChat,
    setGenerationPresetDraft,
  } = usePresetStore();
  const {
    personas,
    editingPersonaId,
    personaDraft,
    savingPersona,
    setPersonaDraft,
    startCreatePersona,
    startEditPersona,
    savePersona,
    removePersona,
    choosePersonaForChat,
  } = usePersonas();

  useBootstrap();

  const endRef = useRef<HTMLDivElement | null>(null);
  const messageFeedRef = useRef<HTMLElement | null>(null);
  const streamScrollPinnedRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const mainColumnRef = useRef<HTMLElement | null>(null);
  const detailScrollRef = useRef<HTMLDivElement | null>(null);
  const hubScrollTopRef = useRef(0);

  const pinMessageFeedToEnd = useCallback(() => {
    streamScrollPinnedRef.current = true;
    const feed = messageFeedRef.current;
    if (feed) {
      feed.scrollTo({ top: feed.scrollHeight, behavior: "auto" });
      return;
    }
    endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, []);
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(() => readStoredTheme());
  const [profileOpen, setProfileOpen] = useState(false);
  const [characterProfileOpen, setCharacterProfileOpen] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [modelPathDraft, setModelPathDraft] = useState("");
  const [modelUrlDraft, setModelUrlDraft] = useState("");
  const [hubSearchInput, setHubSearchInput] = useState("");
  const [libraryTab, setLibraryTab] = useState<LibraryTab>("characters");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("hub");
  const [leftPanelOpen, setLeftPanelOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth > 900,
  );
  const [rightPanelOpen, setRightPanelOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth > 940,
  );
  const [deletingCharacterId, setDeletingCharacterId] = useState<string | null>(null);
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const [clearingChatId, setClearingChatId] = useState<string | null>(null);
  const [openCharacterMenuId, setOpenCharacterMenuId] = useState<string | null>(null);
  const [openChatMenuId, setOpenChatMenuId] = useState<string | null>(null);
  const [characterActionMenuOpen, setCharacterActionMenuOpen] = useState(false);
  const [responderChoiceByChat, setResponderChoiceByChat] = useState<Record<string, string[]>>({});
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [firstRunSetupActive, setFirstRunSetupActive] = useState(false);
  const [firstRunSetupDismissed, setFirstRunSetupDismissed] = useState(false);
  const [groupEditTitle, setGroupEditTitle] = useState("");
  const [groupEditSelection, setGroupEditSelection] = useState<string[]>([]);
  const [savingGroupChat, setSavingGroupChat] = useState(false);
  const [groupSceneDraft, setGroupSceneDraft] = useState("");
  const [groupSummaryDraft, setGroupSummaryDraft] = useState("");
  const [groupToneDraft, setGroupToneDraft] = useState("");
  const [groupUserStateDraft, setGroupUserStateDraft] = useState("");

  const {
    activeModel,
    importModelFile: onImportModel,
    importModelPath: onImportModelPath,
    downloadModelFromUrl: onDownloadModelFromUrl,
    recommendedModel,
    refreshModelLibrary: onRefreshModelLibrary,
    activateModel: onSetActiveModel,
    startSelectedRuntime: onStartRuntime,
    stopSelectedRuntime: onStopRuntime,
    cancelModelDownload: onCancelModelDownload,
    runtimeSettings,
    setPerformanceMode: onSetPerformanceMode,
  } = useRuntimeManagement();
  useUpdates();
  const chatMemory = useMemoryItems({ chatId: activeChatId, enabled: Boolean(activeChatId) });
  const allMemory = useMemoryItems({ includeArchived: true, enabled: settingsOpen });
  const memoryCharacters = useMemo(
    () => characters.map((character) => ({ id: character.id, name: character.name })),
    [characters],
  );
  const memoryChatTitles = useMemo(
    () => Object.fromEntries(chats.map((chat) => [chat.id, chat.title])),
    [chats],
  );
  const resourceSetup = useResourceSetup(async () => {
    await onRefreshModelLibrary();
  });
  const onChangePerformanceMode = useCallback(
    async (mode: RuntimePerformanceMode) => {
      await onSetPerformanceMode(mode);
      if (runtime.status === "running") {
        await onStopRuntime();
        await onStartRuntime();
      }
    },
    [onSetPerformanceMode, onStartRuntime, onStopRuntime, runtime.status],
  );
  const {
    saveCurrentCharacter,
    importCharacterCard: onImportCharacterCard,
    chooseCharacterPortrait: onChooseCharacterPortrait,
    exportCharacterCardJson: onExportCharacterCardJson,
    exportCharacterCardPng: onExportCharacterCardPng,
    deleteCharacter: onDeleteCharacter,
  } = useCharacterManagement();
  const {
    persistMemory,
    refreshMemory: onRefreshMemory,
    createEntry,
    toggleEntry: onToggleContextEntry,
    deleteEntry: onDeleteContextEntry,
  } = useContextMemory();
  const {
    userProfile,
    userProfileDraft,
    relationshipDraft,
    loadingRelationship,
    savingUserProfile,
    savingRelationship,
    setUserProfileDraft,
    setRelationshipDraft,
    saveUserProfile,
    saveRelationshipState,
  } = useProfileManagement();
  const {
    selectGenerationPreset: onSelectGenerationPreset,
    startCreateGenerationPreset: onStartCreateGenerationPreset,
    startEditGenerationPreset: onStartEditGenerationPreset,
    saveGenerationPreset,
    deleteGenerationPresetById: onDeleteGenerationPresetClick,
  } = usePresetManagement();
  const {
    diagnostics,
    loadingDiagnostics,
    exportingDiagnostics,
    creatingDatabaseBackup,
    restoringDatabase,
    databaseBackups,
    refreshDiagnostics: onRefreshDiagnostics,
    exportBundle: onExportDiagnostics,
    backupDatabase: onBackupDatabase,
    restoreDatabase: onRestoreDatabase,
    saveBackupCopy: onSaveBackupCopy,
    addBackupFromFile: onAddBackupFromFile,
  } = useDiagnostics();
  const {
    activeChat,
    activeCharacter,
    activeParticipants,
    activeMemory,
    activeRelationshipState: compiledRelationshipState,
    createDirectChat: onCreateChat,
    createGroup: createGroupChatFromSelection,
    updateGroup: onUpdateGroupChat,
    sendMessage: onSendMessage,
    requestCharacterReply: onRequestCharacterReply,
    startEditUserMessage: onStartEditUserMessage,
    cancelEditUserMessage: onCancelEditUserMessage,
    saveEditedUserMessage: onSaveEditedUserMessage,
    regenerateAssistantMessage: onRegenerateAssistantMessage,
    branchFromMessage: onBranchFromMessage,
    exportChat: onExportChat,
    stopGeneration: onStopGeneration,
    cancelChatWork,
  } = useChatOrchestration(composerRef, persistMemory);

  const charMap = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters],
  );
  const participantIds = useMemo(
    () => chatParticipantIds(activeChat, activeChat ? participantsByChat[activeChat.id] : undefined),
    [activeChat, participantsByChat],
  );
  const groupChatActive = useMemo(
    () => isGroupChatMode(activeChat, participantIds),
    [activeChat, participantIds],
  );
  const activeTheme = useMemo(
    () => themeForCharacter(activeCharacter?.id ?? 'glee-default'),
    [activeCharacter],
  );
  const chatBoundLeadCharacter = useMemo(() => {
    if (!activeChat) {
      return null;
    }
    const ids =
      participantIds.length > 0
        ? participantIds
        : activeChat.characterId
          ? [activeChat.characterId]
          : [];
    return ids
      .map((id) => charMap.get(id))
      .find((character): character is Character => Boolean(character)) ?? null;
  }, [activeChat, charMap, participantIds]);
  const suggestedUserRole = useMemo(
    () => suggestUserRole(activeCharacter),
    [activeCharacter],
  );
  const activeVars = useMemo(
    () =>
      ({
        '--accent': activeTheme.accent,
        '--accent-light': activeTheme.light,
        '--accent-border': activeTheme.border,
      }) as CSSProperties,
    [activeTheme],
  );
  const currentMessages = useMemo(
    () => (activeChatId ? messagesByChat[activeChatId] ?? [] : []),
    [activeChatId, messagesByChat],
  );
  const activeReplyState = useMemo(
    () => (activeChatId ? replyStateByChat[activeChatId] ?? null : null),
    [activeChatId, replyStateByChat],
  );
  const streaming = useMemo(
    () => (activeChatId ? streamingByChat[activeChatId] ?? null : null),
    [activeChatId, streamingByChat],
  );
  const replyPresentation = useMemo(
    () =>
      resolveReplyPresentation(
        activeReplyState,
        streaming,
        activeParticipants[0]?.id ?? activeCharacter?.id,
      ),
    [activeCharacter?.id, activeParticipants, activeReplyState, streaming],
  );
  const sending = activeReplyState === "queued" || activeReplyState === "streaming";
  const generating = activeReplyState === "streaming";

  useEffect(() => {
    if (!activeChat || !groupChatActive) {
      setGroupEditTitle("");
      setGroupEditSelection([]);
      return;
    }
    setGroupEditTitle(activeChat.title);
    setGroupEditSelection(participantIds);
  }, [activeChat, groupChatActive, participantIds]);

  const shellMode: WorkspaceMode =
    workspaceMode === "chat" && activeChat
      ? "chat"
      : workspaceMode === "character" && activeCharacter
        ? "character"
        : "hub";
  const compactDetailLayout = viewportWidth <= 940;
  const compactShellLayout = viewportWidth <= 900;
  const detailRailVisible = shellMode !== "character" && rightPanelOpen;
  const detailRailRendered = detailRailVisible;

  const filteredCharacters = useMemo(() => {
    const query = searchInput.trim().toLowerCase();
    if (!query) {
      return characters;
    }
    return characters.filter((character) => {
      return (
        character.name.toLowerCase().includes(query) ||
        character.description.toLowerCase().includes(query) ||
        character.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    });
  }, [characters, searchInput]);

  const filteredHubCharacters = useMemo(() => {
    const query = hubSearchInput.trim().toLowerCase();
    if (!query) {
      return characters;
    }
    return characters.filter((character) => {
      return (
        character.name.toLowerCase().includes(query) ||
        character.description.toLowerCase().includes(query) ||
        character.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    });
  }, [characters, hubSearchInput]);

  const filteredChats = useMemo(() => {
    const query = searchInput.trim().toLowerCase();
    if (!query) {
      return chats;
    }
    return chats.filter((chat) => {
      if (chat.title.toLowerCase().includes(query)) {
        return true;
      }
      return chatParticipantIds(chat).some((id) =>
        charMap.get(id)?.name.toLowerCase().includes(query),
      );
    });
  }, [chats, charMap, searchInput]);

  const latestMessage = useMemo(
    () => (currentMessages.length > 0 ? currentMessages[currentMessages.length - 1] : undefined),
    [currentMessages],
  );
  const hubRecentChats = useMemo(
    () =>
      [...chats]
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 5),
    [chats],
  );
  const latestAssistantMessage = useMemo(
    () => [...currentMessages].reverse().find((message) => message.role === 'assistant'),
    [currentMessages],
  );
  const latestUserMessage = useMemo(
    () => [...currentMessages].reverse().find((message) => message.role === 'user'),
    [currentMessages],
  );
  const showFirstRunOnboarding =
    !booting &&
    !firstRunSetupDismissed &&
    firstRunSetupActive &&
    (models.length === 0 || runtime.status !== "running");
  const activeModalSelector = useMemo(() => {
    if (commandPaletteOpen) return ".command-modal";
    if (editorMode) return ".character-editor-modal";
    if (characterProfileOpen) return ".character-profile-modal";
    if (profileOpen) return ".profile-modal";
    if (groupBuilderOpen) return ".group-builder-modal";
    if (showFirstRunOnboarding) return ".onboarding-modal";
    if (settingsOpen) return ".settings-modal";
    return null;
  }, [
    characterProfileOpen,
    commandPaletteOpen,
    editorMode,
    groupBuilderOpen,
    profileOpen,
    settingsOpen,
    showFirstRunOnboarding,
  ]);

  useEffect(() => {
    if (!activeModalSelector) {
      return;
    }
    const selector = activeModalSelector;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => {
      const modal = document.querySelector<HTMLElement>(selector);
      const firstFocusable = modal?.querySelector<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      );
      (firstFocusable ?? modal)?.focus();
    });

    function trapFocus(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Tab") {
        return;
      }
      const modal = document.querySelector<HTMLElement>(selector);
      if (!modal) {
        return;
      }
      const focusable = Array.from(
        modal.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element): element is HTMLElement => !element.hidden && element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        modal.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", trapFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", trapFocus);
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [activeModalSelector]);
  const runtimeRecoveryPlan = useMemo(
    () => buildRuntimeRecoveryPlan(runtime, diagnostics, activeModel?.name),
    [activeModel?.name, diagnostics, runtime],
  );
  const detailLeadCharacter = useMemo(
    () => {
      const selectedParticipant =
        groupChatActive && activeCharacter && participantIds.includes(activeCharacter.id)
          ? activeCharacter
          : null;
      if (shellMode === "chat") {
        return groupChatActive
          ? selectedParticipant ?? activeParticipants[0] ?? chatBoundLeadCharacter ?? activeCharacter ?? null
          : chatBoundLeadCharacter ?? activeCharacter ?? null;
      }
      return groupChatActive
        ? selectedParticipant ?? activeParticipants[0] ?? activeCharacter ?? null
        : activeCharacter ?? null;
    },
    [
      activeCharacter,
      activeParticipants,
      chatBoundLeadCharacter,
      groupChatActive,
      participantIds,
      shellMode,
    ],
  );
  const detailTheme = useMemo(
    () => themeForCharacter(detailLeadCharacter?.id ?? activeCharacter?.id ?? activeChatId ?? "detail"),
    [activeCharacter?.id, activeChatId, detailLeadCharacter?.id],
  );
  const detailCardCanExportPng = canExportCharacterCardAsPng(detailLeadCharacter);
  const detailRoster = useMemo(
    () =>
      participantIds
        .map((id) => charMap.get(id))
        .filter((participant): participant is Character => Boolean(participant)),
    [charMap, participantIds],
  );
  const showLegacyDetailTabs = true;
  const sidebarProfileLabel = useMemo(
    () => textOr(userProfile.name, "Your Profile"),
    [userProfile.name],
  );
  const composerPlaceholder = groupChatActive
    ? "Send a message to the group..."
    : `Message ${chatBoundLeadCharacter?.name ?? activeCharacter?.name ?? "character"}...`;
  const privateAiStatus =
    runtime.status === "running"
      ? { tone: "ready", label: "Private AI ready" }
      : runtime.status === "starting"
        ? { tone: "working", label: "Private AI preparing" }
        : runtime.status === "error"
          ? { tone: "error", label: "Private AI needs attention" }
          : { tone: "idle", label: "Private AI paused" };

  useEffect(() => {
    setCharacterActionMenuOpen(false);
  }, [detailLeadCharacter?.id, shellMode, rightPanelOpen]);

  useEffect(() => {
    detailScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [activeChatId, detailLeadCharacter?.id, detailTab, shellMode]);

  const extensionCommands = useRegisteredCommands();
  const commandActions: CommandAction[] = (() => {
    const actions: CommandAction[] = [
      {
        id: 'import-card',
        label: 'Import Character Card',
        hint: 'PNG or JSON card',
        run: () => onImportCharacterCard(),
      },
      {
        id: 'new-character',
        label: 'New Character',
        hint: 'Open Character Studio',
        run: () => startCreateCharacter(),
      },
      {
        id: 'new-chat',
        label: 'New Chat',
        hint: 'Create direct chat',
        run: () => {
          if (activeCharacter) {
            void onStartConversation(activeCharacter);
          }
        },
      },
      {
        id: 'refresh-memory',
        label: 'Refresh Memory',
        hint: 'Recompute summary and facts',
        run: () => onRefreshMemory(),
      },
      {
        id: 'new-context',
        label: 'New Context Entry',
        hint: 'Add lorebook context',
        run: () => {
          setDetailTab('memory');
          setContextDraft(createEmptyContextDraft());
        },
      },
      {
        id: 'export-chat',
        label: 'Export Chat',
        hint: 'Download JSON + Markdown',
        run: () => onExportChat(),
      },
      {
        id: 'open-profile',
        label: 'Open Profile',
        hint: 'Edit your default identity',
        run: () => {
          setSettingsOpen(false);
          setProfileOpen(true);
        },
      },
      {
        id: 'open-settings',
        label: 'Open Settings',
        hint: 'Privacy, appearance, data, and recovery',
        run: () => {
          setProfileOpen(false);
          setSettingsOpen(true);
        },
      },
      {
        id: 'open-diagnostics',
        label: 'Open Diagnostics',
        hint: 'Inspect health and recovery state',
        run: () => onOpenDiagnosticsWorkspace(),
      },
      {
        id: 'export-diagnostics',
        label: 'Export Diagnostics',
        hint: 'Write support bundle to disk',
        run: () => onExportDiagnostics(),
      },
      {
        id: 'backup-database',
        label: 'Backup Database',
        hint: 'Create a local DB backup',
        run: () => onBackupDatabase(),
      },
    ];

    actions.unshift(
      {
        id: 'import-model',
        label: 'Add AI Model File',
        hint: 'Load a .gguf model from disk',
        run: () => onImportModel(),
      },
      {
        id: 'start-runtime',
        label: 'Resume AI',
        hint: 'Start the local AI',
        run: () => onStartRuntime(),
      },
      {
        id: 'stop-runtime',
        label: 'Pause AI',
        hint: 'Stop the local AI and free memory',
        run: () => onStopRuntime(),
      },
    );

    if (activeChat) {
      actions.push({
        id: 'stop-generation',
        label: 'Stop Generation',
        hint: 'Abort current response',
        run: () => onStopGeneration(),
      });
    }
    if (latestAssistantMessage) {
      actions.push({
        id: 'regenerate-last-assistant',
        label: 'Regenerate Last Reply',
        hint: 'Try the most recent assistant message again',
        run: () => onRegenerateAssistantMessage(latestAssistantMessage),
      });
    }
    if (latestMessage) {
      actions.push({
        id: 'branch-chat',
        label: 'Branch from Current Message',
        hint: 'Create a new branch chat',
        run: () => onBranchFromMessage(latestMessage),
      });
    }
    if (latestUserMessage) {
      actions.push({
        id: 'edit-last-user',
        label: 'Edit Last User Message',
        hint: 'Refine previous prompt',
        run: () => onStartEditUserMessage(latestUserMessage),
      });
    }
    return [...actions, ...extensionCommands];
  })();

  const {
    commandInputRef,
    filteredCommands,
    runCommand: onRunCommand,
  } = useCommandPalette(commandActions);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(pinMessageFeedToEnd);
    return () => window.cancelAnimationFrame(frameId);
  }, [activeChatId, pinMessageFeedToEnd]);

  useEffect(() => {
    const latestMessage = currentMessages[currentMessages.length - 1];
    if (latestMessage?.role === "user") {
      streamScrollPinnedRef.current = true;
    }
    if (!streamScrollPinnedRef.current) {
      return;
    }
    const frameId = window.requestAnimationFrame(pinMessageFeedToEnd);
    return () => window.cancelAnimationFrame(frameId);
  }, [currentMessages, pinMessageFeedToEnd]);

  useEffect(() => {
    if (!replyPresentation || !streamScrollPinnedRef.current) {
      return;
    }
    const frameId = window.requestAnimationFrame(pinMessageFeedToEnd);
    return () => window.cancelAnimationFrame(frameId);
  }, [replyPresentation, pinMessageFeedToEnd]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const id = window.setTimeout(() => setNotice(null), 5200);
    return () => window.clearTimeout(id);
  }, [notice, setNotice]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    async function syncMaximized(): Promise<void> {
      try {
        const maximized = await appWindow.isMaximized();
        if (active) {
          setWindowMaximized(maximized);
        }
      } catch {
        // Window state is best-effort for custom chrome.
      }
    }

    void syncMaximized();
    appWindow
      .onResized(() => {
        void syncMaximized();
      })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(() => {
        // Ignore listener failures; controls will still work.
      });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [appWindow]);

  useEffect(() => {
    // macOS keeps its native, decorated window; elsewhere the undecorated
    // window would otherwise show an accent border.
    if (document.documentElement.dataset.platform === "macos") {
      return;
    }
    void appWindow.setShadow(false).catch(() => {
      // Not every platform supports changing the shadow.
    });
  }, [appWindow]);

  useEffect(() => {
    function syncViewportWidth(): void {
      setViewportWidth(window.innerWidth);
    }

    syncViewportWidth();
    window.addEventListener("resize", syncViewportWidth);
    return () => window.removeEventListener("resize", syncViewportWidth);
  }, []);

  useEffect(() => {
    if (compactShellLayout) {
      setLeftPanelOpen(false);
    }
  }, [compactShellLayout]);

  useEffect(() => {
    if (compactDetailLayout) {
      setRightPanelOpen(false);
    }
  }, [compactDetailLayout]);

  useEffect(() => {
    let active = true;

    async function fitWindowToMonitor(): Promise<void> {
      try {
        if (await appWindow.isMaximized()) {
          return;
        }
        const monitor = await currentMonitor();
        if (!active || !monitor) {
          return;
        }
        const scaleFactor = monitor.scaleFactor || 1;
        const workWidth = monitor.workArea.size.width / scaleFactor;
        const workHeight = monitor.workArea.size.height / scaleFactor;
        const workX = monitor.workArea.position.x / scaleFactor;
        const workY = monitor.workArea.position.y / scaleFactor;

        const targetWidth = Math.max(1100, Math.round(workWidth * 0.7));
        const targetHeight = Math.max(720, Math.round(workHeight * 0.7));
        const width = Math.min(targetWidth, workWidth - 64);
        const height = Math.min(targetHeight, workHeight - 64);
        const posX = workX + Math.round((workWidth - width) / 2);
        const posY = workY + Math.round((workHeight - height) / 2);

        await appWindow.setSize(new LogicalSize(width, height));
        await appWindow.setPosition(new LogicalPosition(posX, posY));
      } catch {
        // Initial sizing is best-effort; the configured window size is the fallback.
      }
    }

    void fitWindowToMonitor();
    return () => {
      active = false;
    };
  }, [appWindow]);

  useEffect(() => {
    if (
      !settingsOpen &&
      !profileOpen &&
      !showFirstRunOnboarding &&
      !groupBuilderOpen &&
      !editorMode &&
      !characterProfileOpen
    ) {
      return;
    }
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        if (editorMode) {
          requestCloseCharacterEditor();
          return;
        }
        if (groupBuilderOpen) {
          closeGroupBuilder();
          return;
        }
        if (characterProfileOpen) {
          setCharacterProfileOpen(false);
          return;
        }
        if (profileOpen) {
          void closeProfileEditor();
          return;
        }
        setSettingsOpen(false);
        setFirstRunSetupDismissed(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    if (!booting) {
      dismissBootOverlay();
    }
  }, [booting]);

  useEffect(() => {
    if (shellMode !== "hub") {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (mainColumnRef.current) {
        mainColumnRef.current.scrollTop = hubScrollTopRef.current;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [shellMode]);

  useEffect(() => {
    if (recommendedModel?.url && !modelUrlDraft.trim()) {
      setModelUrlDraft(recommendedModel.url);
    }
  }, [modelUrlDraft, recommendedModel]);

  useEffect(() => {
    if (booting) {
      return;
    }
    if (models.length === 0) {
      setFirstRunSetupActive(true);
      setFirstRunSetupDismissed(false);
    }
  }, [booting, models.length]);

  useEffect(() => {
    if (firstRunSetupActive && models.length > 0 && runtime.status === "running") {
      setFirstRunSetupDismissed(true);
      setFirstRunSetupActive(false);
    }
  }, [firstRunSetupActive, models.length, runtime.status]);

  useEffect(() => {
    if (activeChatId) {
      setLibraryTab("chats");
    }
  }, [activeChatId]);

  useEffect(() => {
    if (!activeChatId && workspaceMode === "chat") {
      setWorkspaceMode("hub");
    }
  }, [activeChatId, workspaceMode]);

  async function onSaveCharacter(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await saveCurrentCharacter();
  }

  function isCharacterDraftDirty(): boolean {
    const baseline =
      editorMode === "edit" && editingCharacterId
        ? characters.find((character) => character.id === editingCharacterId)
        : null;
    const initialDraft = baseline ? draftFromCharacter(baseline) : createEmptyDraft();
    return JSON.stringify(draft) !== JSON.stringify(initialDraft);
  }

  function requestCloseCharacterEditor(): void {
    if (savingCharacter) {
      return;
    }
    if (
      isCharacterDraftDirty() &&
      !window.confirm("Discard the unsaved changes in Character Studio?")
    ) {
      return;
    }
    cancelCharacterEditor();
  }

  function openGroupBuilder(): void {
    if (groupSelection.length === 0 && characters.length > 1) {
      setGroupSelection([characters[0].id, characters[1].id]);
    }
    if (!groupTitle.trim()) {
      setGroupTitle("Group Chat");
    }
    setGroupBuilderOpen(true);
  }

  function closeGroupBuilder(): void {
    setGroupBuilderOpen(false);
    setGroupSceneDraft("");
    setGroupSummaryDraft("");
    setGroupToneDraft("");
    setGroupUserStateDraft("");
  }

  function openProfileEditor(): void {
    setSettingsOpen(false);
    setProfileOpen(true);
  }

  async function onChooseUserProfileImage(): Promise<void> {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Profile Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof selected !== "string") {
      return;
    }
    setUserProfileDraft((prev) => ({ ...prev, avatar: selected }));
  }

  function onClearUserProfileImage(): void {
    setUserProfileDraft((prev) => ({ ...prev, avatar: "" }));
  }

  function isUserProfileDraftDirty(): boolean {
    return (
      userProfileDraft.name.trim() !== userProfile.name.trim() ||
      userProfileDraft.about.trim() !== userProfile.about.trim() ||
      userProfileDraft.gender.trim() !== userProfile.gender.trim() ||
      userProfileDraft.avatar.trim() !== userProfile.avatar.trim() ||
      normalizeDraftList(userProfileDraft.traits) !== userProfile.traits.join(", ") ||
      userProfileDraft.preferences.trim() !== userProfile.preferences.trim() ||
      userProfileDraft.boundaries.trim() !== userProfile.boundaries.trim()
    );
  }

  async function closeProfileEditor(): Promise<void> {
    if (savingUserProfile) {
      return;
    }
    if (isUserProfileDraftDirty()) {
      await saveUserProfile();
    }
    setProfileOpen(false);
  }

  function openSettingsPanel(): void {
    setProfileOpen(false);
    setSettingsOpen(true);
  }

  function closeSettingsPanel(): void {
    setSettingsOpen(false);
  }

  function onSelectTheme(nextTheme: ThemeId): void {
    const selectedTheme = persistTheme(nextTheme);
    applyTheme(selectedTheme);
    setTheme(selectedTheme);
  }

  async function onCreateGroup(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const created = await createGroupChatFromSelection(groupSelection, groupTitle, {
      summary: groupSummaryDraft,
      currentScene: groupSceneDraft,
      interactionTone: groupToneDraft,
      userState: groupUserStateDraft,
    });
    if (created) {
      closeGroupBuilder();
      setWorkspaceMode("chat");
      setLibraryTab("chats");
    }
  }

  async function onCreateContextEntry(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await createEntry();
  }

  async function onSaveGenerationPreset(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await saveGenerationPreset();
  }

  async function onSaveUserProfile(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await saveUserProfile();
  }

  async function onSaveRelationshipState(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await saveRelationshipState();
  }

  function onApplySuggestedUserRole(): void {
    if (!suggestedUserRole) {
      return;
    }
    setRelationshipDraft((prev) => ({
      ...prev,
      userRoleName: suggestedUserRole.name,
      userRoleDescription:
        suggestedUserRole.description ||
        prev.userRoleDescription ||
        (userProfile.name.trim()
          ? `${userProfile.name.trim()} is taking the role of ${suggestedUserRole.name} in this chat.`
          : `The user is taking the role of ${suggestedUserRole.name} in this chat.`),
    }));
  }

  function onClearChatSpecificUserRole(): void {
    setRelationshipDraft((prev) => ({
      ...prev,
      userRoleName: "",
      userRoleDescription: "",
    }));
  }

  async function sendWithResponderChoice(): Promise<void> {
    const chosen = activeChatId ? responderChoiceByChat[activeChatId] ?? [] : [];
    if (activeChatId && chosen.length > 0) {
      // The choice applies to one message; the next one goes back to automatic.
      setResponderChoiceByChat((prev) => ({ ...prev, [activeChatId]: [] }));
    }
    await onSendMessage(undefined, chosen.length > 0 ? { responderIds: chosen } : undefined);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendWithResponderChoice();
    }
  }

  async function onMinimizeWindow(): Promise<void> {
    try {
      await appWindow.minimize();
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    }
  }

  async function onToggleMaximizeWindow(): Promise<void> {
    try {
      await appWindow.toggleMaximize();
      setWindowMaximized(await appWindow.isMaximized());
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    }
  }

  async function onCloseWindow(): Promise<void> {
    try {
      await appWindow.close();
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    }
  }

  async function onStartWindowDrag(event: MouseEvent<HTMLElement>): Promise<void> {
    if (event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, input, select, textarea, a")) {
      return;
    }
    try {
      await appWindow.startDragging();
    } catch {
      // Dragging is best-effort when custom chrome is enabled.
    }
  }

  async function onImportModelFromPath(): Promise<void> {
    if (!modelPathDraft.trim()) {
      setNotice({ kind: "error", message: "Enter a .gguf file path first." });
      return;
    }
    const imported = await onImportModelPath(modelPathDraft);
    if (imported) {
      setModelPathDraft("");
      setFirstRunSetupActive(true);
    }
  }

  async function onDownloadModelFromDraft(): Promise<void> {
    if (!modelUrlDraft.trim()) {
      setNotice({ kind: "error", message: "Enter a model download URL first." });
      return;
    }
    const downloaded = await onDownloadModelFromUrl(
      modelUrlDraft.trim(),
      recommendedModel?.url === modelUrlDraft.trim() ? recommendedModel.name : undefined,
      recommendedModel?.url === modelUrlDraft.trim() ? recommendedModel.sha256 : undefined,
    );
    if (downloaded) {
      setFirstRunSetupActive(true);
    }
  }

  async function onDownloadRecommendedModel(): Promise<void> {
    if (!recommendedModel) {
      setNotice({ kind: "error", message: "No recommended model download is configured for this build." });
      return;
    }
    const downloaded = await onDownloadModelFromUrl(
      recommendedModel.url,
      recommendedModel.name,
      recommendedModel.sha256,
    );
    if (downloaded) {
      setFirstRunSetupActive(true);
    }
  }

  async function onCompleteFirstRunRuntimeStart(): Promise<void> {
    await onStartRuntime();
  }

  async function copyTextToClipboard(value: string, successMessage: string): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is not available in this build.");
      }
      await navigator.clipboard.writeText(value);
      setNotice({ kind: "info", message: successMessage });
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    }
  }

  function onOpenDiagnosticsWorkspace(): void {
    if (workspaceMode === "character") {
      setWorkspaceMode(activeChatId ? "chat" : "hub");
    }
    setRightPanelOpen(true);
    setDetailTab("diagnostics");
    setSettingsOpen(false);
    if (showFirstRunOnboarding) {
      setFirstRunSetupDismissed(true);
    }
  }

  async function onCopyRuntimeSupportSummary(): Promise<void> {
    await copyTextToClipboard(
      runtimeRecoveryPlan.supportSummary,
      "Support summary copied.",
    );
  }

  async function onCopyRuntimeLogPath(): Promise<void> {
    if (!runtime.logFile) {
      setNotice({ kind: "error", message: "Runtime log path is unavailable." });
      return;
    }
    await copyTextToClipboard(runtime.logFile, "Runtime log path copied.");
  }

  function onReturnToHub(): void {
    setCharacterProfileOpen(false);
    setWorkspaceMode("hub");
    setLibraryTab("characters");
    setDetailTab("overview");
  }

  function onShowChatLibrary(): void {
    setCharacterProfileOpen(false);
    setLibraryTab("chats");
    if (activeChatId) {
      setWorkspaceMode("chat");
    }
  }

  function onShowCharacterLibrary(): void {
    setCharacterProfileOpen(false);
    setLibraryTab("characters");
    setWorkspaceMode("hub");
    setDetailTab("overview");
  }

  function onSelectCharacterForHub(character: Character): void {
    setLibraryTab("characters");
    setActiveCharacterId(character.id);
    setCharacterProfileOpen(false);
    setWorkspaceMode("hub");
    setDetailTab("overview");
  }

  function onOpenCharacterProfile(character: Character): void {
    setLibraryTab("characters");
    setActiveCharacterId(character.id);
    setCharacterProfileOpen(true);
  }

  async function onStartConversation(
    character: Character,
    openingMessage?: string,
  ): Promise<void> {
    setCharacterProfileOpen(false);
    setLibraryTab("chats");
    setActiveCharacterId(character.id);
    await onCreateChat(character, openingMessage);
    setWorkspaceMode("chat");
    setDetailTab("overview");
  }

  function onOpenChatWorkspace(chat: ChatSummary): void {
    setCharacterProfileOpen(false);
    const ids = chatParticipantIds(chat, participantsByChat[chat.id]);
    setLibraryTab("chats");
    setWorkspaceMode("chat");
    setActiveChatId(chat.id);
    if (ids[0]) {
      setActiveCharacterId(ids[0]);
    }
    setDetailTab("overview");
  }

  function onToggleGroupEditMember(characterId: string): void {
    setGroupEditSelection((prev) => {
      if (prev.includes(characterId)) {
        return prev.filter((id) => id !== characterId);
      }
      return dedupeIds([...prev, characterId]);
    });
  }

  async function onSaveGroupChat(): Promise<void> {
    if (!activeChat || !groupChatActive) {
      return;
    }
    setSavingGroupChat(true);
    try {
      const updated = await onUpdateGroupChat(activeChat.id, groupEditSelection, groupEditTitle);
      if (updated) {
        setGroupEditTitle(updated.title);
        setGroupEditSelection(updated.participantIds);
      }
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    } finally {
      setSavingGroupChat(false);
    }
  }

  async function onDeleteCharacterClick(character: Character): Promise<void> {
    if (deletingCharacterId || deletingChatId) {
      return;
    }
    if (!window.confirm(`Delete ${character.name}? Chats will remain, but this character will be removed from them.`)) {
      return;
    }

    setDeletingCharacterId(character.id);
    try {
      setOpenCharacterMenuId(null);
      const deleted = await onDeleteCharacter(character);
      if (!deleted) {
        return;
      }
      setChats((prev) =>
        prev.map((chat) => ({
          ...chat,
          characterId: chat.characterId === character.id ? undefined : chat.characterId,
          participantIds: chat.participantIds.filter((id) => id !== character.id),
        })),
      );
      setParticipantsByChat((prev) => {
        const next = { ...prev };
        for (const [chatId, participantIds] of Object.entries(next)) {
          next[chatId] = participantIds.filter((id) => id !== character.id);
        }
        return next;
      });
      if (activeCharacter?.id === character.id) {
        setCharacterProfileOpen(false);
        const nextCharacterId =
          activeChat != null
            ? participantsByChat[activeChat.id]?.find((id) => id !== character.id) ?? null
            : null;
        if (nextCharacterId) {
          setActiveCharacterId(nextCharacterId);
        }
      }
    } finally {
      setDeletingCharacterId(null);
    }
  }

  async function onDeleteChatClick(chat: ChatSummary): Promise<void> {
    if (deletingCharacterId || deletingChatId || clearingChatId) {
      return;
    }
    if (!window.confirm(`Delete "${chat.title}"? This chat history will be removed.`)) {
      return;
    }

    setDeletingChatId(chat.id);
    try {
      setOpenChatMenuId(null);
      await deleteChatApi(chat.id);
      const remainingChats = chats.filter((entry) => entry.id !== chat.id);
      setChats(remainingChats);
      setMessagesByChat((prev) => {
        const next = { ...prev };
        delete next[chat.id];
        return next;
      });
      setParticipantsByChat((prev) => {
        const next = { ...prev };
        delete next[chat.id];
        return next;
      });
      setMemoryByChat((prev) => {
        const next = { ...prev };
        delete next[chat.id];
        return next;
      });
      if (activeChatId === chat.id) {
        const nextActiveChat = remainingChats[0] ?? null;
        setActiveChatId(nextActiveChat?.id ?? null);
        const nextActiveCharacterId =
          nextActiveChat?.participantIds[0] ??
          (nextActiveChat?.characterId ?? null);
        setActiveCharacterId(nextActiveCharacterId);
        setWorkspaceMode(nextActiveChat ? "chat" : "hub");
      }
      setNotice({ kind: "info", message: `Deleted ${chat.title}.` });
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    } finally {
      setDeletingChatId(null);
    }
  }

  async function onSaveEditedMessageClick(message: ChatMessage): Promise<void> {
    const index = currentMessages.findIndex((item) => item.id === message.id);
    const laterMessages = index >= 0 ? currentMessages.length - 1 - index : 0;
    if (
      message.role === "user" &&
      laterMessages > 0 &&
      !window.confirm(
        `Saving this change removes the ${laterMessages} message${laterMessages === 1 ? "" : "s"} after it, because they replied to the old text. Continue?`,
      )
    ) {
      return;
    }
    await onSaveEditedUserMessage(message);
  }

  async function onDeleteMessageClick(message: ChatMessage): Promise<void> {
    if (!activeChat || !activeChatId || messageActionBusyId) {
      return;
    }
    if (!window.confirm("Delete this message? The messages around it stay as they are.")) {
      return;
    }
    setMessageActionBusyId(message.id);
    try {
      cancelChatWork(activeChatId);
      const mutation = await deleteMessageApi(message.id, activeChat.historyEpoch);
      setMessagesByChat((prev) => ({ ...prev, [activeChatId]: mutation.messages }));
      setChats((prev) =>
        sortChatsByRecent(
          prev.map((chat) =>
            chat.id === activeChatId
              ? { ...chat, historyEpoch: mutation.historyEpoch, updatedAt: mutation.updatedAt }
              : chat,
          ),
        ),
      );
      void getChatMemory(activeChatId)
        .then((memory) => setMemoryByChat((prev) => ({ ...prev, [activeChatId]: memory })))
        .catch(() => undefined);
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    } finally {
      setMessageActionBusyId(null);
    }
  }

  function onStartRenameChat(chat: ChatSummary): void {
    setOpenChatMenuId(null);
    setRenameDraft(chat.title);
    setRenamingChatId(chat.id);
  }

  async function onSaveChatRename(chat: ChatSummary): Promise<void> {
    const title = renameDraft.trim();
    setRenamingChatId(null);
    if (!title || title === chat.title) {
      return;
    }
    try {
      const renamed = await renameChat(chat.id, title);
      setChats((previous) =>
        previous.map((item) => (item.id === chat.id ? { ...item, title: renamed.title } : item)),
      );
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    }
  }

  async function onClearChatHistoryClick(chat: ChatSummary): Promise<void> {
    if (deletingCharacterId || deletingChatId || clearingChatId) {
      return;
    }
    if (messageActionBusyId) {
      setNotice({
        kind: "error",
        message: "Finish the current message action before clearing history.",
      });
      return;
    }
    const hasActiveGeneration = Boolean(replyStateByChat[chat.id] || streamingByChat[chat.id]);
    if (
      !window.confirm(
        hasActiveGeneration
          ? `Clear the message history for "${chat.title}"? This will stop the pending response, keep the chat itself, and remove its messages, saved chat memory, and relationship state.`
          : `Clear the message history for "${chat.title}"? This keeps the chat itself, but removes its messages, saved chat memory, and relationship state.`,
      )
    ) {
      return;
    }

    setClearingChatId(chat.id);
    try {
      setOpenChatMenuId(null);
      cancelChatWork(chat.id);
      const mutation = await clearChatHistoryApi(chat.id);
      setChats((prev) =>
        sortChatsByRecent(
          prev.map((entry) =>
            entry.id === chat.id
              ? {
                  ...entry,
                  historyEpoch: mutation.historyEpoch,
                  updatedAt: mutation.updatedAt,
                }
              : entry,
          ),
        ),
      );
      setMessagesByChat((prev) => ({ ...prev, [chat.id]: mutation.messages }));
      setMemoryByChat((prev) => ({ ...prev, [chat.id]: emptyMemory(chat.id) }));
      hydrateRelationshipState(createEmptyRelationshipState(chat.id));
      if (activeChatId === chat.id) {
        setActiveContextHits([]);
        setActiveMemoryHits([]);
      }
      setNotice({ kind: "info", message: `Cleared history for ${chat.title}.` });
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    } finally {
      setClearingChatId(null);
    }
  }

  if (booting) {
    return null;
  }

  function onWorkspaceScroll(event: UIEvent<HTMLElement>): void {
    if (shellMode === "hub") {
      hubScrollTopRef.current = event.currentTarget.scrollTop;
    }
  }

  function renderDiagnosticsWorkspace(onBack?: () => void): ReactNode {
    return (
      <Suspense fallback={<p className="empty-note">Loading diagnostics...</p>}>
        <DiagnosticsWorkspace
          diagnostics={diagnostics}
        runtime={runtime}
        activeModelName={activeModel?.name}
        messageCounts={
          activeChat
            ? {
                user: currentMessages.filter((message) => message.role === "user").length,
                assistant: currentMessages.filter((message) => message.role === "assistant").length,
              }
            : undefined
        }
        loadingDiagnostics={loadingDiagnostics}
        exportingDiagnostics={exportingDiagnostics}
        creatingDatabaseBackup={creatingDatabaseBackup}
        restoringDatabase={restoringDatabase}
        databaseBackups={databaseBackups}
        runtimeRecoveryCard={
          runtime.status === "error" ? (
            <RuntimeRecoverySupportCard
              plan={runtimeRecoveryPlan}
              runtime={runtime}
              canRetryStart={Boolean(activeModel)}
              startingRuntime={startingRuntime}
              exportingDiagnostics={exportingDiagnostics}
              creatingDatabaseBackup={creatingDatabaseBackup}
              onRetryStart={() => void onStartRuntime()}
              onOpenDiagnostics={onOpenDiagnosticsWorkspace}
              onExportDiagnostics={() => void onExportDiagnostics()}
              onBackupDatabase={() => void onBackupDatabase()}
              onCopySupportSummary={() => void onCopyRuntimeSupportSummary()}
              onCopyRuntimeLog={() => void onCopyRuntimeLogPath()}
            />
          ) : undefined
        }
        onRefresh={onRefreshDiagnostics}
        onExport={onExportDiagnostics}
        onBackup={onBackupDatabase}
        onRestore={onRestoreDatabase}
          onBack={onBack}
        />
      </Suspense>
    );
  }

  function onToggleLibraryPanel(): void {
    const opening = !leftPanelOpen;
    if (opening && compactDetailLayout) {
      setRightPanelOpen(false);
    }
    setLeftPanelOpen(opening);
  }

  function onToggleDetailPanel(): void {
    const opening = !rightPanelOpen;
    if (opening && compactDetailLayout) {
      setLeftPanelOpen(false);
    }
    setRightPanelOpen(opening);
  }

  return (
    <div className={`glee-shell${windowMaximized ? " maximized" : ""}`} style={activeVars}>
      <header className="window-bar" onMouseDownCapture={(event) => void onStartWindowDrag(event)}>
        <div className="window-drag" data-tauri-drag-region>
          <div className="window-title">
            <span
              className="window-brand-logo"
              role="img"
              aria-label="Glee"
              style={{ "--glee-wordmark-url": `url("${gleeWordmark}")` } as CSSProperties}
            />
          </div>
          <div className="window-context" aria-live="polite">
            <span className={`private-ai-status ${privateAiStatus.tone}`}>
              <span className="private-ai-status-dot" aria-hidden="true" />
              {privateAiStatus.label}
            </span>
          </div>
          <div className="window-controls">
            <button type="button" className="window-control" aria-label="Minimize" onMouseDown={(event) => event.stopPropagation()} onClick={() => void onMinimizeWindow()}>
              <span className="minimize" />
            </button>
            <button type="button" className="window-control" aria-label={windowMaximized ? "Restore" : "Maximize"} onMouseDown={(event) => event.stopPropagation()} onClick={() => void onToggleMaximizeWindow()}>
              <span className={windowMaximized ? "restore" : "maximize"} />
            </button>
            <button type="button" className="window-control close" aria-label="Close" onMouseDown={(event) => event.stopPropagation()} onClick={() => void onCloseWindow()}>
              <span className="close-icon" />
            </button>
          </div>
        </div>
      </header>

      <div
        className={`glee-layout${!leftPanelOpen ? " left-collapsed" : ""}${!detailRailRendered ? " right-collapsed" : ""}${shellMode === "character" ? " character-focus" : ""}${compactDetailLayout ? " compact-detail" : ""}${compactShellLayout ? " compact-shell" : ""}`}
      >
      <button
        type="button"
        className={`rail-toggle rail-toggle-left${leftPanelOpen ? " open" : ""}`}
        aria-label={leftPanelOpen ? "Hide library panel" : "Show library panel"}
        aria-expanded={leftPanelOpen}
        onClick={onToggleLibraryPanel}
      >
        <GleeIcon name="panel-left" size={16} />
      </button>
      {shellMode !== "character" && (
        <button
          type="button"
          className={`rail-toggle rail-toggle-right${detailRailRendered ? " open" : ""}`}
          aria-label={detailRailRendered ? "Hide detail panel" : "Show detail panel"}
          aria-expanded={detailRailRendered}
          onClick={onToggleDetailPanel}
        >
          <GleeIcon name="panel-right" size={16} />
        </button>
      )}
      {compactShellLayout && leftPanelOpen && (
        <button
          type="button"
          className="rail-drawer-scrim"
          aria-label="Close library panel"
          onClick={() => setLeftPanelOpen(false)}
        />
      )}
      {compactDetailLayout && detailRailRendered && (
        <button
          type="button"
          className="rail-drawer-scrim"
          aria-label="Close detail panel"
          onClick={() => setRightPanelOpen(false)}
        />
      )}
      {leftPanelOpen ? (
      <aside className="glee-sidebar">
        <div className="brand-card">
          <div className="sidebar-brand-row">
            <button
              className={`ghost sidebar-hub-button${shellMode === "hub" ? " active" : ""}`}
              type="button"
              aria-current={shellMode === "hub" ? "page" : undefined}
              onClick={onReturnToHub}
            >
              <GleeIcon name="hub" size={16} className="sidebar-hub-icon" />
              <span>Hub</span>
            </button>
          </div>
          <div className="sidebar-create-row">
            {libraryTab === "characters" ? (
              <>
                <button className="primary sidebar-primary-cta" type="button" onClick={() => startCreateCharacter()}>
                  <IconLabel icon="create-character">New character</IconLabel>
                </button>
                <button
                  className="ghost sidebar-create-secondary"
                  type="button"
                  aria-label={importingCard ? "Importing character card" : "Import character card"}
                  title="Import character card"
                  disabled={importingCard}
                  onClick={() => void onImportCharacterCard()}
                >
                  <GleeIcon name="import-character" size={17} />
                </button>
              </>
            ) : (
              <>
                <button
                  className="primary sidebar-primary-cta"
                  type="button"
                  disabled={!activeCharacter}
                  onClick={() => activeCharacter && void onStartConversation(activeCharacter)}
                >
                  <IconLabel icon="new-chat">New chat</IconLabel>
                </button>
                <button
                  className="ghost sidebar-create-secondary"
                  type="button"
                  aria-label="Create group chat"
                  title="Create group chat"
                  onClick={() => openGroupBuilder()}
                >
                  <GleeIcon name="group-chat" size={17} />
                </button>
              </>
            )}
          </div>
          <div className="sidebar-search-shell">
            <GleeIcon name="search" size={16} className="search-field-icon" />
            <input
              className="search-input"
              placeholder={libraryTab === "characters" ? "Search characters..." : "Search conversations..."}
              aria-label={libraryTab === "characters" ? "Search characters" : "Search conversations"}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
          <nav className="library-tabs sidebar-switcher">
            <button
              type="button"
              className={libraryTab === "chats" ? "active" : ""}
              onClick={() => onShowChatLibrary()}
            >
              Chats
            </button>
            <button
              type="button"
              className={libraryTab === "characters" ? "active" : ""}
              onClick={() => onShowCharacterLibrary()}
            >
              Characters
            </button>
          </nav>
        </div>

        {libraryTab === "characters" ? (
          <section className="sidebar-panel sidebar-list-panel">
            <div className="panel-list">
              {filteredCharacters.map((character) => {
                const theme = themeForCharacter(character.id);
                const isDeleting = deletingCharacterId === character.id;
                return (
                  <div key={character.id} className={`panel-row-wrap${openCharacterMenuId === character.id ? " menu-open" : ""}`}>
                    <button
                      type="button"
                      className={`panel-row char-row${character.id === activeCharacter?.id ? " active" : ""}`}
                      onClick={() => {
                        setOpenCharacterMenuId(null);
                        onSelectCharacterForHub(character);
                      }}
                    >
                      <CharacterAvatar character={character} theme={theme} />
                       <div className="panel-row-copy char-copy">
                         <div className="panel-row-topline">
                           <strong>{character.name}</strong>
                         </div>
                         <small>{snippetPreview(textOr(character.description, "No description yet."), 54)}</small>
                       </div>
                    </button>
                    <div className="panel-row-actions">
                      <button
                        type="button"
                        className="ghost row-menu-trigger"
                        aria-label={`Open actions for ${character.name}`}
                        aria-expanded={openCharacterMenuId === character.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenChatMenuId(null);
                          setOpenCharacterMenuId((prev) => (prev === character.id ? null : character.id));
                        }}
                      >
                        <GleeIcon name="more" size={18} />
                      </button>
                      {openCharacterMenuId === character.id && (
                        <div className="row-menu">
                          <button
                            type="button"
                            className="ghost row-menu-item"
                            onClick={() => onOpenCharacterProfile(character)}
                          >
                            <IconLabel icon="profile">Open Profile</IconLabel>
                          </button>
                          <button
                            type="button"
                            className="ghost row-menu-item"
                            onClick={() => void onStartConversation(character)}
                          >
                            <IconLabel icon="new-chat">Start Chat</IconLabel>
                          </button>
                          <button
                            type="button"
                            className="ghost row-menu-item danger"
                            disabled={isDeleting}
                            onClick={() => void onDeleteCharacterClick(character)}
                          >
                            <IconLabel icon="delete">{isDeleting ? "Deleting..." : "Delete"}</IconLabel>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {filteredCharacters.length === 0 && <p className="empty-note">No characters yet.</p>}
            </div>
          </section>
        ) : (
          <section className="sidebar-panel sidebar-list-panel">
            <div className="panel-list">
              {filteredChats.map((chat) => {
                const ids = chatParticipantIds(chat, participantsByChat[chat.id]);
                const leadCharacter = ids.map((id) => charMap.get(id)).find((character): character is Character => Boolean(character));
                const leadTheme = themeForCharacter(leadCharacter?.id ?? chat.id);
                 const isDeleting = deletingChatId === chat.id;
                 const isClearing = clearingChatId === chat.id;
                 const isGenerating = Boolean(replyStateByChat[chat.id] || streamingByChat[chat.id]);
                 const chatMessages = messagesByChat[chat.id] ?? [];
                 const chatPreview = chatMessages[chatMessages.length - 1];
                 return (
                  <div key={chat.id} className={`panel-row-wrap${openChatMenuId === chat.id ? " menu-open" : ""}`}>
                    {renamingChatId === chat.id ? (
                      <div className={`panel-row chat-row${chat.id === activeChatId ? " active" : ""}`}>
                        <CharacterAvatar character={leadCharacter} theme={leadTheme} className="chat-row-avatar" />
                        <input
                          className="search-input chat-rename-input"
                          aria-label="Chat name"
                          value={renameDraft}
                          maxLength={120}
                          ref={(node) => {
                            if (node && document.activeElement !== node) {
                              node.focus();
                              node.select();
                            }
                          }}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onBlur={() => void onSaveChatRename(chat)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              event.currentTarget.blur();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              setRenameDraft(chat.title);
                              event.currentTarget.blur();
                            }
                          }}
                        />
                      </div>
                    ) : (
                    <button
                      type="button"
                      className={`panel-row chat-row${chat.id === activeChatId ? " active" : ""}`}
                      onClick={() => {
                        setOpenChatMenuId(null);
                        onOpenChatWorkspace(chat);
                      }}
                    >
                      <CharacterAvatar character={leadCharacter} theme={leadTheme} className="chat-row-avatar" />
                       <div className="panel-row-copy chat-row-copy">
                         <div className="panel-row-topline">
                           <span>{chat.title}</span>
                           <time>{displayTime(chat.updatedAt)}</time>
                         </div>
                         <small>
                           {chatPreview
                             ? isGenerationFailureContent(chatPreview.content)
                               ? "Reply interrupted"
                               : snippetPreview(chatPreview.content, 54)
                             : isGenerating
                               ? "Replying..."
                               : "Open conversation"}
                         </small>
                       </div>
                    </button>
                    )}
                    <div className="panel-row-actions">
                      <button
                        type="button"
                        className="ghost row-menu-trigger"
                        aria-label={`Open actions for ${chat.title}`}
                        aria-expanded={openChatMenuId === chat.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenCharacterMenuId(null);
                          setOpenChatMenuId((prev) => (prev === chat.id ? null : chat.id));
                        }}
                      >
                        <GleeIcon name="more" size={18} />
                      </button>
                      {openChatMenuId === chat.id && (
                        <div className="row-menu">
                          <button
                            type="button"
                            className="ghost row-menu-item"
                            onClick={() => onOpenChatWorkspace(chat)}
                          >
                            <IconLabel icon="new-chat">Open Chat</IconLabel>
                          </button>
                          <button
                            type="button"
                            className="ghost row-menu-item"
                            onClick={() => onStartRenameChat(chat)}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            className="ghost row-menu-item"
                            disabled={isClearing}
                            onClick={() => void onClearChatHistoryClick(chat)}
                          >
                            {isClearing
                              ? "Clearing..."
                              : isGenerating
                                ? "Clear & Stop"
                                : "Clear History"}
                          </button>
                          <button
                            type="button"
                            className="ghost row-menu-item danger"
                            disabled={isDeleting}
                            onClick={() => void onDeleteChatClick(chat)}
                          >
                            <IconLabel icon="delete">{isDeleting ? "Deleting..." : "Delete"}</IconLabel>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {filteredChats.length === 0 && <p className="empty-note">No chats yet.</p>}
            </div>
          </section>
        )}
        <div className="sidebar-footer">
          <div className="sidebar-footer-actions shell-dock">
            <button className="ghost sidebar-profile-button sidebar-profile-chip" type="button" onClick={() => openProfileEditor()}>
              <UserProfileAvatar
                imagePath={userProfile.avatar}
                name={sidebarProfileLabel}
                className="sidebar-profile-avatar"
              />
              <span className="sidebar-profile-copy">
                <strong>{sidebarProfileLabel}</strong>
                <small>{userProfile.gender?.trim() || "Profile"}</small>
              </span>
            </button>
            <button className="ghost sidebar-footer-link" type="button" onClick={() => openSettingsPanel()}>
              <IconLabel icon="settings">Settings</IconLabel>
            </button>
            <button className="ghost sidebar-footer-link" type="button" onClick={onOpenDiagnosticsWorkspace}>
              <IconLabel icon="diagnostics">Diagnostics &amp; recovery</IconLabel>
            </button>
          </div>
        </div>
      </aside>
      ) : null}

        <main
          ref={mainColumnRef}
          className={shellMode === "hub" ? "hub-column" : shellMode === "character" ? "character-page-column" : "chat-column"}
          onScroll={shellMode === "hub" ? onWorkspaceScroll : undefined}
        >
        <div className="app-banners">
          <UpdateBanner />
          <SetupBanner
            setup={resourceSetup}
            onStart={() => void resourceSetup.start()}
            onCancel={resourceSetup.cancel}
          />
        </div>
        {shellMode === "hub" ? (
          <>
            <div className="chat-notice-slot">
              {notice && <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"} aria-live={notice.kind === "error" ? "assertive" : "polite"}>{notice.message}</div>}
            </div>

            <section className="hub-hero">
              <div className="hub-hero-copy">
                <span className="hub-kicker">Character Hub</span>
                <h1>
                  {userProfile.name.trim()
                    ? `Welcome back, ${userProfile.name.trim()}.`
                    : "Welcome to Glee."}
                </h1>
                <p>
                  Pick a character, import a card, or reopen a recent thread.
                </p>
              </div>
            </section>

            <section className="hub-toolbar">
              <div className="hub-search-bar">
                <GleeIcon name="search" size={17} className="search-field-icon" />
                <input
                  className="search-input"
                  placeholder="Search characters..."
                  aria-label="Search characters"
                  value={hubSearchInput}
                  onChange={(event) => setHubSearchInput(event.target.value)}
                />
              </div>
              <div className="hub-hero-actions">
                <button className="primary" type="button" onClick={() => startCreateCharacter()}>
                  <IconLabel icon="create-character">Create Character</IconLabel>
                </button>
                <button className="ghost" type="button" onClick={() => openGroupBuilder()}>
                  <IconLabel icon="group-chat">Create Group Chat</IconLabel>
                </button>
                <button className="ghost" type="button" onClick={() => openProfileEditor()}>
                  <IconLabel icon="profile">Edit Profile</IconLabel>
                </button>
                <button className="ghost" type="button" disabled={importingCard} onClick={() => void onImportCharacterCard()}>
                  <IconLabel icon="import-character">{importingCard ? "Importing..." : "Import Card"}</IconLabel>
                </button>
              </div>
            </section>

            <section className="hub-grid">
              {filteredHubCharacters.length > 0 ? (
                <section className="hub-card-grid standard">
                  {filteredHubCharacters.map((character) => {
                      const theme = themeForCharacter(character.id);
                      return (
                        <article key={`hub-char-${character.id}`} className="hub-character-card standard">
                          <div className="hub-card-media">
                            <CharacterCardPortrait character={character} theme={theme} />
                            <div className="hub-tag-row">
                              {character.tags.slice(0, 2).map((tag) => (
                                <span key={`${character.id}-hub-${tag}`} className="trait-chip">
                                {tag}
                              </span>
                            ))}
                            </div>
                          </div>
                          <div className="hub-card-copy">
                            <h3>{character.name}</h3>
                          <p>{snippetPreview(textOr(character.description, "No description yet."), 120)}</p>
                        </div>
                        <div className="hub-card-actions">
                          <button className="primary" type="button" onClick={() => void onStartConversation(character)}>
                            Start Chat
                          </button>
                          <button className="ghost" type="button" onClick={() => onOpenCharacterProfile(character)}>
                            Open Profile
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </section>
              ) : (
                <div className="feed-empty hub-empty">
                  <div className="feed-empty-card">
                    <span className="feed-empty-eyebrow">Character Hub</span>
                    <h3>No characters yet</h3>
                    <p>Import a character card or create your first one to start using Glee.</p>
                  </div>
                </div>
              )}

              {hubRecentChats.length > 0 && (
                <section className="hub-section">
                  <div className="hub-section-head">
                    <h3>Recent Chats</h3>
                    <button className="ghost" type="button" onClick={() => setLibraryTab("chats")}>
                      Open Chat List
                    </button>
                  </div>
                  <div className="hub-chat-list">
                    {hubRecentChats.map((chat) => {
                      const ids = chatParticipantIds(chat, participantsByChat[chat.id]);
                      const leadCharacter = ids.map((id) => charMap.get(id)).find((entry): entry is Character => Boolean(entry));
                      const leadTheme = themeForCharacter(leadCharacter?.id ?? chat.id);
                      return (
                        <button
                          key={`hub-chat-${chat.id}`}
                          type="button"
                          className="hub-chat-card"
                          onClick={() => onOpenChatWorkspace(chat)}
                        >
                          <CharacterAvatar character={leadCharacter} theme={leadTheme} className="chat-row-avatar" />
                          <div>
                            <strong>{chat.title}</strong>
                            <small>{displayDate(chat.updatedAt)}</small>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}
            </section>
          </>
        ) : shellMode === "character" ? (
          <>
            <div className="chat-notice-slot">
              {notice && <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"} aria-live={notice.kind === "error" ? "assertive" : "polite"}>{notice.message}</div>}
            </div>

            <section className="character-page-hero">
              <div className="character-page-head">
                <div className="chat-ident-row character-page-title-row">
                  <button type="button" className="ghost chat-back-button" onClick={onReturnToHub}>
                    <IconLabel icon="hub">Hub</IconLabel>
                  </button>
                  <span className="detail-kicker">Character profile</span>
                </div>
                <div className="character-page-actions">
                  <button className="primary" type="button" onClick={() => activeCharacter && void onStartConversation(activeCharacter)}>
                    <IconLabel icon="new-chat">Start Chat</IconLabel>
                  </button>
                  <button className="ghost" type="button" onClick={() => activeCharacter && startEditCharacter(activeCharacter)}>
                    <IconLabel icon="edit">Edit</IconLabel>
                  </button>
                </div>
              </div>
              <div className="character-page-summary">
                <CharacterCardPortrait character={activeCharacter} theme={activeTheme} />
                <div className="character-page-copy">
                  <div className="character-page-title">
                    <h1>{activeCharacter?.name ?? "Character"}</h1>
                    {activeCharacter?.tags.length ? (
                      <div className="hub-tag-row">
                        {activeCharacter.tags.slice(0, 4).map((tag) => (
                          <span key={`character-page-${activeCharacter.id}-${tag}`} className="trait-chip">
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <p>{textOr(activeCharacter?.description, "No character description yet.")}</p>
                  <div className="character-page-meta">
                    <span><strong>Creator</strong> {textOr(activeCharacter?.creator, "Unknown")}</span>
                    <span><strong>Version</strong> {textOr(activeCharacter?.characterVersion, "Local")}</span>
                  </div>
                </div>
              </div>
            </section>

            <section className="character-page-grid">
              <article className="character-page-section">
                <span className="detail-kicker">Personality</span>
                <p>{textOr(activeCharacter?.personality || activeCharacter?.speechStyle, "No personality profile set.")}</p>
              </article>
              <article className="character-page-section">
                <span className="detail-kicker">Scenario</span>
                <p>{textOr(activeCharacter?.scenario, "No scenario framing set.")}</p>
              </article>
              <article className="character-page-section">
                <span className="detail-kicker">Backstory</span>
                <p>{textOr(activeCharacter?.backstory, "No backstory provided.")}</p>
              </article>
              <article className="character-page-section">
                <span className="detail-kicker">Boundaries</span>
                <p>{textOr(activeCharacter?.boundaries, "No explicit boundaries set.")}</p>
              </article>
              <article className="character-page-section">
                <span className="detail-kicker">Greeting</span>
                <p>{textOr(activeCharacter?.greeting, "No greeting set.")}</p>
              </article>
              <article className="character-page-section">
                <span className="detail-kicker">Alternate greetings</span>
                {activeCharacter?.alternateGreetings.length ? (
                  <div className="opening-choice-list">
                    {activeCharacter.alternateGreetings.map((greeting, index) => (
                      <button
                        className="ghost opening-choice"
                        key={`${activeCharacter.id}-opening-${index}`}
                        type="button"
                        onClick={() => void onStartConversation(activeCharacter, greeting)}
                      >
                        <span>{snippetPreview(greeting, 140)}</span>
                        <small>Start with this opening</small>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p>No alternate greetings.</p>
                )}
              </article>
              <article className="character-page-section full">
                <span className="detail-kicker">Example dialogue</span>
                <pre>{textOr(activeCharacter?.exampleDialogue, "No example dialogue set.")}</pre>
              </article>
              <article className="character-page-section">
                <span className="detail-kicker">Likes</span>
                <p>{activeCharacter?.likes.length ? activeCharacter.likes.join(" • ") : "No likes recorded."}</p>
              </article>
              <article className="character-page-section">
                <span className="detail-kicker">Dislikes</span>
                <p>{activeCharacter?.dislikes.length ? activeCharacter.dislikes.join(" • ") : "No dislikes recorded."}</p>
              </article>
              <article className="character-page-section full">
                <span className="detail-kicker">Advanced instructions</span>
                <p>{textOr(activeCharacter?.systemPrompt, "No advanced instructions set.")}</p>
                <p className="character-page-subnote">
                  {textOr(activeCharacter?.postHistoryInstructions, "No post-history instructions set.")}
                </p>
              </article>
            </section>
          </>
        ) : (
          <>
            <div className="chat-notice-slot">
              {notice && <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"} aria-live={notice.kind === "error" ? "assertive" : "polite"}>{notice.message}</div>}
            </div>

            <section
              ref={messageFeedRef}
              className="message-feed"
              onScroll={(event) => {
                const feed = event.currentTarget;
                const distanceFromBottom =
                  feed.scrollHeight - feed.scrollTop - feed.clientHeight;
                streamScrollPinnedRef.current = distanceFromBottom < 96;
              }}
            >
              {(currentMessages.length > 0 || replyPresentation) && <div className="day-divider">{currentMessages[0] ? displayDate(currentMessages[0].createdAt) : "Today"}</div>}
              {currentMessages.length === 0 && !replyPresentation && (
                <div className="feed-empty">
                  <div className="feed-empty-card">
                    <span className="feed-empty-eyebrow">Conversation</span>
                    <h3>No messages yet</h3>
                    <p>Start chatting to bring this character into the scene.</p>
                  </div>
                </div>
              )}

              {currentMessages.map((message, index) => {
                const isUser = message.role === "user";
                const isFailureEvent =
                  !isUser && isGenerationFailureContent(message.content);
                const isBusy = messageActionBusyId === message.id;
                if (isFailureEvent) {
                  return (
                    <GenerationFailureEvent
                      key={message.id}
                      message={message}
                      timeLabel={displayTime(message.createdAt)}
                      busy={isBusy}
                      sending={sending}
                      onRetry={() => void onRegenerateAssistantMessage(message)}
                      onBranch={() => void onBranchFromMessage(message)}
                    />
                  );
                }
                const speaker = message.speakerCharacterId ? charMap.get(message.speakerCharacterId) : (activeParticipants[0] ?? activeCharacter);
                const theme = themeForCharacter(speaker?.id ?? "assistant");
                const isLastMessage = index === currentMessages.length - 1;
                const isEditing = editingMessageId === message.id;
                const targetedStreaming =
                  !isUser && streaming?.targetMessageId === message.id ? streaming : null;
                return (
                  <article key={message.id} className={`bubble${isUser ? " user" : " assistant"}${isBusy ? " busy" : ""}`}>
                    {!isUser && <CharacterAvatar character={speaker} theme={theme} className="bubble-avatar" />}
                    <div className="bubble-inner">
                      <header>
                        <span>{isUser ? "You" : textOr(speaker?.name, "Assistant")}</span>
                        <time>{displayTime(message.createdAt)}</time>
                      </header>
                      {isEditing ? (
                        <div className="bubble-edit-wrap">
                          <textarea
                            className="bubble-edit-input"
                            value={editingMessageDraft}
                            onChange={(event) => setEditingMessageDraft(event.target.value)}
                            rows={3}
                          />
                          <div className="bubble-tools">
                            <button
                              type="button"
                              className="ghost"
                              disabled={isBusy}
                              onClick={() => void onSaveEditedMessageClick(message)}
                            >
                              {isBusy ? "Saving..." : "Save"}
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              disabled={isBusy}
                              onClick={() => onCancelEditUserMessage()}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : targetedStreaming ? (
                        <SmoothStreamingContent
                          content={targetedStreaming.content}
                          typingDotsStyle={activeVars}
                          onDisplayedContentChange={() => {
                            if (streamScrollPinnedRef.current) {
                              pinMessageFeedToEnd();
                            }
                          }}
                        />
                      ) : (
                        renderMessageContent(
                          message.content,
                          isUser ? "user" : "assistant",
                          message.id,
                          isUser ? undefined : speaker?.name,
                        )
                      )}
                      {!isEditing && (
                        <div className="bubble-tools">
                          <button
                            type="button"
                            className="ghost"
                            disabled={isBusy || sending || generating}
                            onClick={() => onStartEditUserMessage(message)}
                          >
                            <IconLabel icon="edit" size={13}>Edit</IconLabel>
                          </button>
                          {!isUser && (
                            isLastMessage && (
                              <button
                                type="button"
                                className="ghost"
                                disabled={isBusy || sending}
                                onClick={() => void onRegenerateAssistantMessage(message)}
                              >
                                <IconLabel icon="regenerate" size={13}>{isBusy ? "Regenerating..." : "Regenerate"}</IconLabel>
                              </button>
                            )
                          )}
                          <button
                            type="button"
                            className="ghost"
                            disabled={isBusy || sending}
                            onClick={() => void onBranchFromMessage(message)}
                          >
                            <IconLabel icon="branch" size={13}>Branch</IconLabel>
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={isBusy || sending || generating}
                            onClick={() => void onDeleteMessageClick(message)}
                          >
                            <IconLabel icon="delete" size={13}>Delete</IconLabel>
                          </button>
                          {activeChat && (
                            <MessageExtensionActions
                              message={{
                                id: message.id,
                                chatId: message.chatId,
                                role: message.role,
                                content: message.content,
                                speakerCharacterId: message.speakerCharacterId,
                                createdAt: message.createdAt,
                              }}
                              chat={{
                                id: activeChat.id,
                                title: activeChat.title,
                                mode: groupChatActive ? "group" : "single",
                                characterId: activeChat.characterId ?? undefined,
                                participantIds,
                              }}
                            />
                          )}
                          {isLastMessage && (
                            <button
                              type="button"
                              className="ghost"
                              disabled={sending}
                              onClick={() => void onExportChat()}
                            >
                              <IconLabel icon="export" size={13}>Export chat</IconLabel>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}

              {replyPresentation && !replyPresentation.targetMessageId && (
                <article
                  key={`stream-${activeChatId ?? "chat"}-${replyPresentation.speakerCharacterId ?? "assistant"}`}
                  className="bubble assistant streaming"
                >
                  <CharacterAvatar
                    character={charMap.get(replyPresentation.speakerCharacterId ?? "") ?? activeParticipants[0] ?? activeCharacter}
                    theme={themeForCharacter(replyPresentation.speakerCharacterId ?? "assistant")}
                    className="bubble-avatar"
                    style={activeVars}
                  />
                  <div className="bubble-inner">
                    <header>
                      <span>{textOr(charMap.get(replyPresentation.speakerCharacterId ?? "")?.name, "Assistant")}</span>
                      <time>now</time>
                    </header>
                    <SmoothStreamingContent
                      content={replyPresentation.content}
                      typingDotsStyle={activeVars}
                      onDisplayedContentChange={() => {
                        if (streamScrollPinnedRef.current) {
                          pinMessageFeedToEnd();
                        }
                      }}
                    />
                  </div>
                </article>
              )}
              <div ref={endRef} />
            </section>

            <form
              className="composer-box"
              onSubmit={(event) => {
                event.preventDefault();
                void sendWithResponderChoice();
              }}
            >
              <ComposerExtensionTools />
              {groupChatActive && activeChatId && (
                <GroupReplyControls
                  participants={activeParticipants.map((character) => ({
                    id: character.id,
                    name: character.name,
                  }))}
                  selectedIds={responderChoiceByChat[activeChatId] ?? []}
                  disabled={sending || generating || runtime.status !== "running"}
                  onChangeSelected={(ids) =>
                    setResponderChoiceByChat((prev) => ({ ...prev, [activeChatId]: ids }))
                  }
                  onRequestReply={(characterId) => void onRequestCharacterReply(characterId)}
                />
              )}
              <PersonaPicker
                personas={personas}
                selectedId={activeChatId ? presetProfileByChat[activeChatId]?.personaPresetId : undefined}
                defaultName={userProfile?.name ?? ""}
                disabled={!activeChat || sending || generating}
                onSelect={(personaId) => {
                  if (activeChatId) {
                    void choosePersonaForChat(activeChatId, personaId);
                  }
                }}
              />
              <div className="composer-row">
                <textarea
                  ref={composerRef}
                  value={composerInput}
                  disabled={!activeChat || sending || generating || Boolean(messageActionBusyId)}
                  placeholder={composerPlaceholder}
                  aria-label={composerPlaceholder}
                  onChange={(event) => {
                    setComposerInput(event.target.value);
                    event.target.style.height = "auto";
                    event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
                  }}
                  onKeyDown={onComposerKeyDown}
                />
                <div className="composer-actions">
                  {generating && (
                    <button type="button" className="ghost" onClick={() => onStopGeneration()}>
                      <IconLabel icon="stop">Stop</IconLabel>
                    </button>
                  )}
                  <button className="primary send" type="submit" disabled={!activeChat || !composerInput.trim() || sending || generating || Boolean(messageActionBusyId)}>
                    <IconLabel icon="send">{sending ? "Sending..." : "Send"}</IconLabel>
                  </button>
                </div>
              </div>
            </form>
          </>
        )}
      </main>

      {detailRailRendered ? (
      shellMode === "hub" ? (
      <aside className="detail-column hub-detail-column">
        {detailTab === "diagnostics" ? (
          <div
            ref={detailScrollRef}
            className="detail-scroll hub-diagnostics-scroll"
            role="region"
            aria-label="Diagnostics and recovery"
            tabIndex={0}
          >
            {renderDiagnosticsWorkspace(() => setDetailTab("overview"))}
          </div>
        ) : (
        <section className="hub-side-shell">
          <section className="hub-side-panel hub-system-panel">
            <span className="detail-kicker">Workspace</span>
            <h3>Private AI</h3>
            <div className="hub-stat-grid">
              <article>
                <HubRuntimeStatus runtime={runtime} startingRuntime={startingRuntime} />
                <span>Replies</span>
              </article>
              <article>
                <strong>{activeModel?.name ?? "No model"}</strong>
                <span>AI model</span>
              </article>
            </div>
            <div className="hub-side-actions">
              {runtime.status === "running" ? (
                <button className="ghost" type="button" disabled={stoppingRuntime} onClick={() => void onStopRuntime()}>
                  {stoppingRuntime ? "Pausing..." : "Pause AI"}
                </button>
              ) : (
                <button
                  className="primary"
                  type="button"
                  disabled={startingRuntime || !activeModel}
                  onClick={() => void onStartRuntime()}
                >
                  {startingRuntime ? "Starting..." : runtime.status === "error" ? "Try Again" : "Start AI"}
                </button>
              )}
              <button className="ghost" type="button" onClick={() => setSettingsOpen(true)}>
                AI &amp; Models
              </button>
              <button className="ghost" type="button" onClick={onOpenDiagnosticsWorkspace}>
                Diagnostics &amp; Recovery
              </button>
            </div>
          </section>

        </section>
        )}
      </aside>
      ) : (
      <aside className="detail-column">
        <section className="detail-hero">
          <div className="detail-hero-topline">
            <span className="detail-kicker">Character card</span>
          </div>
          <div className="detail-hero-core">
            <CharacterAvatar character={detailLeadCharacter ?? undefined} theme={detailTheme} className="hero-avatar" style={activeVars} />
            <div className="detail-hero-copy">
              <h3>
                {groupChatActive
                  ? activeChat?.title ?? "Group chat"
                  : detailLeadCharacter?.name ?? "No character selected"}
              </h3>
            </div>
          </div>
          {groupChatActive && detailRoster.length > 1 && (
            <div className="detail-participant-strip" aria-label="Participants">
              {detailRoster.map((participant) => (
                <button
                  key={`detail-participant-${participant.id}`}
                  type="button"
                  className={`detail-participant-pill${participant.id === detailLeadCharacter?.id ? " active" : ""}`}
                  onClick={() => setActiveCharacterId(participant.id)}
                >
                  {participant.name}
                </button>
              ))}
            </div>
          )}
          <div className={`detail-hero-actions${groupChatActive ? "" : " character-card-actions"}`}>
            <button
              type="button"
              className="ghost detail-edit-button"
              disabled={!detailLeadCharacter}
              onClick={() => detailLeadCharacter && startEditCharacter(detailLeadCharacter)}
            >
              <IconLabel icon="edit">Edit character</IconLabel>
            </button>
            <div className="character-export-menu-wrap">
              <button
                type="button"
                className="ghost character-actions-trigger"
                disabled={!detailLeadCharacter}
                aria-haspopup="menu"
                aria-label="More character actions"
                title="More character actions"
                aria-expanded={characterActionMenuOpen}
                onClick={() => setCharacterActionMenuOpen((open) => !open)}
              >
                <GleeIcon name="more" size={18} />
              </button>
              {characterActionMenuOpen && detailLeadCharacter && (
                <div className="character-export-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setCharacterActionMenuOpen(false);
                      void onExportCharacterCardJson(detailLeadCharacter);
                    }}
                  >
                    <IconLabel icon="export">Export JSON</IconLabel>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!detailCardCanExportPng}
                    title={
                      detailCardCanExportPng
                        ? "Export card as PNG"
                        : "PNG export needs a portrait PNG."
                    }
                    onClick={() => {
                      setCharacterActionMenuOpen(false);
                      void onExportCharacterCardPng(detailLeadCharacter);
                    }}
                  >
                    <IconLabel icon="export">Export PNG</IconLabel>
                  </button>
                  {!groupChatActive && (
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      disabled={deletingCharacterId === detailLeadCharacter.id}
                      onClick={() => {
                        setCharacterActionMenuOpen(false);
                        void onDeleteCharacterClick(detailLeadCharacter);
                      }}
                    >
                      <IconLabel icon="delete">
                        {deletingCharacterId === detailLeadCharacter.id ? "Deleting..." : "Delete character"}
                      </IconLabel>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          {(!detailLeadCharacter || !detailCardCanExportPng) && (
            <p className="detail-hero-note">
              {detailLeadCharacter
                ? "PNG export needs a portrait PNG. Add one in Character Studio for shareable card-image export."
                : "Select a character to inspect card compatibility and export options."}
            </p>
          )}
        </section>

        {showLegacyDetailTabs && (
          <div className="detail-tabs" aria-label="Detail panel sections" role="tablist">
            {([
              ["overview", "Overview"],
              ["identity", "Identity"],
              ["memory", "Memory"],
              ["diagnostics", "Diagnostics"],
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                id={`detail-tab-${tab}`}
                type="button"
                role="tab"
                className={detailTab === tab ? "active" : ""}
                aria-controls="detail-tabpanel"
                aria-selected={detailTab === tab}
                onClick={() => setDetailTab(tab)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div
          ref={detailScrollRef}
          id="detail-tabpanel"
          className="detail-scroll"
          role="tabpanel"
          aria-labelledby={`detail-tab-${detailTab}`}
          tabIndex={0}
        >
          {(!showLegacyDetailTabs || detailTab === "overview") && (
            detailLeadCharacter ? (
            <>
              {groupChatActive && activeChat && (
                <section className="detail-section character-card-detail">
                  <h4>Group Participants</h4>
                  <div className="inspector-card-grid">
                    <article className="inspector-card inspector-card-wide">
                      <span className="inspector-card-kicker">Selected card</span>
                      <p>{detailLeadCharacter.name}</p>
                    </article>
                    <article className="inspector-card inspector-card-wide">
                      <span className="inspector-card-kicker">Roster</span>
                      <p>
                        {textOr(
                          participantIds
                            .map((id) => charMap.get(id)?.name)
                            .filter((name): name is string => Boolean(name))
                            .join(", "),
                          "No group participants available.",
                        )}
                      </p>
                    </article>
                  </div>
                </section>
              )}

              <section className="detail-section character-card-detail">
                <h4>Conversation</h4>
                <div className="inspector-card-grid">
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Scenario</span>
                    <p>{textOr(detailLeadCharacter.scenario, "No scenario framing set.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Speech style</span>
                    <p>{textOr(detailLeadCharacter.speechStyle, "No speech style guidance set.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Greeting</span>
                    <p>{textOr(detailLeadCharacter.greeting, "No greeting set.")}</p>
                  </article>
                </div>
              </section>

              <section className="detail-section character-card-detail">
                <h4>Character</h4>
                <div className="inspector-card-grid">
                  <article className="inspector-card inspector-card-wide">
                    <span className="inspector-card-kicker">About</span>
                    <p>{textOr(detailLeadCharacter.description, "No description set.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Personality</span>
                    <p>{textOr(detailLeadCharacter.personality, "No personality guidance set.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Backstory</span>
                    <p>{textOr(detailLeadCharacter.backstory, "No backstory set.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Boundaries</span>
                    <p>{textOr(detailLeadCharacter.boundaries, "No character boundaries set.")}</p>
                  </article>
                </div>
              </section>

              <section className="detail-section character-card-detail">
                <h4>Voice &amp; openings</h4>
                <div className="inspector-card-grid">
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Alternate greetings</span>
                    <p>
                      {detailLeadCharacter.alternateGreetings.length
                        ? detailLeadCharacter.alternateGreetings.join(" | ")
                        : "No alternate greetings saved."}
                    </p>
                  </article>
                  <article className="inspector-card inspector-card-wide">
                    <span className="inspector-card-kicker">Example dialogue</span>
                    <pre className="inspector-card-text">{textOr(detailLeadCharacter.exampleDialogue, "No example dialogue set.")}</pre>
                  </article>
                </div>
              </section>

              <section className="detail-section character-card-detail">
                <h4>Instructions</h4>
                <div className="inspector-card-grid">
                  <article className="inspector-card inspector-card-wide">
                    <span className="inspector-card-kicker">Advanced character instructions</span>
                    <pre className="inspector-card-text">{textOr(detailLeadCharacter.systemPrompt, "No advanced character instructions set.")}</pre>
                  </article>
                  <article className="inspector-card inspector-card-wide">
                    <span className="inspector-card-kicker">Post-history instructions</span>
                    <pre className="inspector-card-text">{textOr(detailLeadCharacter.postHistoryInstructions, "No post-history instructions set.")}</pre>
                  </article>
                  <article className="inspector-card inspector-card-wide">
                    <span className="inspector-card-kicker">Creator notes</span>
                    <pre className="inspector-card-text">{textOr(detailLeadCharacter.creatorNotes, "No creator notes set.")}</pre>
                  </article>
                </div>
              </section>

              <section className="detail-section character-card-detail">
                <h4>Metadata</h4>
                <div className="inspector-card-grid">
                  <article className="inspector-card inspector-card-wide">
                    <span className="inspector-card-kicker">Tags</span>
                    {detailLeadCharacter.tags.length ? (
                      <div className="trait-wrap character-card-chip-list">
                        {detailLeadCharacter.tags.map((tag, index) => (
                          <span key={`detail-tag-${detailLeadCharacter.id}-${tag}-${index}`} className="trait-chip">
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p>No tags set.</p>
                    )}
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Likes</span>
                    <p>{detailLeadCharacter.likes.length ? detailLeadCharacter.likes.join(", ") : "No likes set."}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Dislikes</span>
                    <p>{detailLeadCharacter.dislikes.length ? detailLeadCharacter.dislikes.join(", ") : "No dislikes set."}</p>
                  </article>
                  <article className="inspector-card inspector-card-wide">
                    <span className="inspector-card-kicker">Card info</span>
                    <ul className="meta-list character-card-meta">
                      <li><span>Creator</span><strong>{textOr(detailLeadCharacter.creator, "Unknown")}</strong></li>
                      <li><span>Version</span><strong>{textOr(detailLeadCharacter.characterVersion, "Local")}</strong></li>
                      <li><span>Created</span><strong>{displayDate(detailLeadCharacter.createdAt)}</strong></li>
                      <li><span>Updated</span><strong>{displayDate(detailLeadCharacter.updatedAt)}</strong></li>
                    </ul>
                  </article>
                </div>
              </section>
            </>
          ) : (
            <section className="detail-section character-card-detail">
              <h4>Card Details</h4>
              <p className="empty-note">Select a character to inspect its card details.</p>
            </section>
            )
          )}

          {showLegacyDetailTabs && detailTab === "overview" && (
            <>
              {groupChatActive && activeChat && (
                <section className="detail-section">
                  <h4>Group Setup</h4>
                  <div className="inspector-panel-note">
                    <strong>Shared conversation roster</strong>
                    <p>
                      Group chats support any roster with at least 2 characters. Each selected participant can answer in this shared thread, and the roster order is preserved.
                    </p>
                  </div>
                  <div className="trait-wrap group-participant-chips">
                    {groupEditSelection.map((id) => {
                      const participant = charMap.get(id);
                      return (
                        <span key={`group-chip-${id}`} className="trait-chip">
                          {participant?.name ?? id}
                        </span>
                      );
                    })}
                  </div>
                  <label className="preset-field">
                    <span>Group title</span>
                    <input
                      className="search-input"
                      value={groupEditTitle}
                      onChange={(event) => setGroupEditTitle(event.target.value)}
                    />
                  </label>
                  <div className="group-member-list inspector-group-member-list">
                    {characters.map((character) => {
                      const selected = groupEditSelection.includes(character.id);
                      return (
                        <label
                          key={`inspector-group-${character.id}`}
                          className={`group-member-option${selected ? " active" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => onToggleGroupEditMember(character.id)}
                          />
                          {character.name}
                        </label>
                      );
                    })}
                  </div>
                  <div className="preset-form-actions">
                    <button
                      type="button"
                      className="ghost"
                      disabled={savingGroupChat || groupEditSelection.length < 2 || !groupEditTitle.trim()}
                      onClick={() => void onSaveGroupChat()}
                    >
                      {savingGroupChat ? "Saving..." : "Save Group"}
                    </button>
                  </div>
                </section>
              )}
              <section className="detail-section">
                <h4>Overview</h4>
                <div className="inspector-panel-note">
                  <strong>What affects replies here</strong>
                  <p>
                    Scene, relationship, your identity in this chat, and live memory all feed the Response System directly. The rest of the character authoring data lives in the Identity tab.
                  </p>
                </div>
                <div className="inspector-card-grid">
                  <article className="inspector-card inspector-card-wide">
                    <span className="inspector-card-kicker">
                      {groupChatActive ? "Group roster" : "Character summary"}
                    </span>
                    <p>
                      {groupChatActive
                        ? textOr(
                            participantIds
                              .map((id) => charMap.get(id)?.name)
                              .filter((name): name is string => Boolean(name))
                              .join(", "),
                            "No group participants available.",
                          )
                        : snippetPreview(
                            textOr(activeCharacter?.description, "No character summary set."),
                            260,
                          )}
                    </p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Current scene</span>
                    <p>{textOr(compiledRelationshipState?.currentScene || activeCharacter?.scenario, "No live scene framing yet.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Relationship</span>
                    <p>{textOr(compiledRelationshipState?.summary, "No relationship state saved yet.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Interaction tone</span>
                    <p>{textOr(compiledRelationshipState?.interactionTone, "No interaction tone saved yet.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Identity in chat</span>
                    <p>{textOr(compiledRelationshipState?.userRoleName, textOr(userProfile.name, "No user identity set."))}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Live memory</span>
                    <p>{textOr(activeMemory?.summary, "No live memory summary yet.")}</p>
                  </article>
                </div>
              </section>

            </>
          )}
          {showLegacyDetailTabs && detailTab === "identity" && (
            <>
              {groupChatActive ? (
                <section className="detail-section">
                  <h4>Participants</h4>
                  <div className="inspector-panel-note">
                    <strong>Character-level detail</strong>
                    <p>
                      Group chats use multiple characters. Open an individual profile from here when you want to inspect or edit one character in depth.
                    </p>
                  </div>
                  <div className="inspector-card-grid">
                    {participantIds.map((id) => {
                      const participant = charMap.get(id);
                      if (!participant) {
                        return null;
                      }
                      return (
                        <article key={`group-identity-${participant.id}`} className="inspector-card">
                          <span className="inspector-card-kicker">{participant.name}</span>
                          <p>{textOr(participant.description, "No description set.")}</p>
                          <button
                            type="button"
                            className="ghost inspector-inline-button"
                            onClick={() => onOpenCharacterProfile(participant)}
                          >
                            Open Profile
                          </button>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ) : (
                <>
              <section className="detail-section">
                <h4>Identity</h4>
                <div className="inspector-panel-note">
                  <strong>Static authoring data</strong>
                  <p>
                    These fields define the character itself. They shape replies continuously, but they usually stay fixed until you edit the character.
                  </p>
                </div>
                <div className="inspector-card-grid">
                  <article className="inspector-card inspector-card-wide">
                    <span className="inspector-card-kicker">About</span>
                    <p>{textOr(activeCharacter?.description, "No description set.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Personality</span>
                    <p>{textOr(activeCharacter?.personality, "No personality guidance set.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Backstory</span>
                    <p>{textOr(activeCharacter?.backstory, "No backstory set.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Scenario</span>
                    <p>{textOr(activeCharacter?.scenario, "No scenario framing set.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Speech style</span>
                    <p>{textOr(activeCharacter?.speechStyle, "No speech style guidance set.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Boundaries</span>
                    <p>{textOr(activeCharacter?.boundaries, "No character boundaries set.")}</p>
                  </article>
                  <article className="inspector-card inspector-card-wide">
                    <span className="inspector-card-kicker">Creator notes (metadata only)</span>
                    <p>{textOr(activeCharacter?.creatorNotes, "No creator notes set. Metadata only; not used directly in replies.")}</p>
                  </article>
                </div>
              </section>

              <section className="detail-section">
                <h4>Behavior</h4>
                <div className="inspector-card-grid">
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Likes</span>
                    <p>{activeCharacter?.likes.length ? activeCharacter.likes.join(", ") : "No likes set."}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Dislikes</span>
                    <p>{activeCharacter?.dislikes.length ? activeCharacter.dislikes.join(", ") : "No dislikes set."}</p>
                  </article>
                  <article className="inspector-card inspector-card-wide">
                    <span className="inspector-card-kicker">Tags</span>
                    <p>{activeCharacter?.tags.length ? activeCharacter.tags.join(", ") : "No tags set."}</p>
                  </article>
                </div>
              </section>

              <section className="detail-section">
                <h4>Voice and Prompting</h4>
                <div className="inspector-card-grid">
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Greeting</span>
                    <p>{textOr(activeCharacter?.greeting, "No greeting set.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Alternate greetings</span>
                    <p>{activeCharacter?.alternateGreetings.length ? activeCharacter?.alternateGreetings.join(" | ") : "No alternate greetings saved."}</p>
                  </article>
                  <article className="inspector-card inspector-card-wide">
                    <span className="inspector-card-kicker">Example dialogue</span>
                    <p>{textOr(activeCharacter?.exampleDialogue, "No example dialogue set.")}</p>
                  </article>
                  <article className="inspector-card inspector-card-wide">
                    <span className="inspector-card-kicker">Advanced character instructions</span>
                    <p>{textOr(activeCharacter?.systemPrompt, "No advanced character instructions set.")}</p>
                  </article>
                  <article className="inspector-card inspector-card-wide">
                    <span className="inspector-card-kicker">Post-history instructions</span>
                    <p>{textOr(activeCharacter?.postHistoryInstructions, "No post-history instructions set.")}</p>
                  </article>
                </div>
              </section>
                </>
              )}
            </>
          )}
          {showLegacyDetailTabs && detailTab === "memory" && (
            <>
              <section className="detail-section">
                <h4>Relationship State</h4>
                <div className="inspector-card-grid">
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Default identity</span>
                    <p>{textOr(userProfile.name, "No global user profile name set.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Summary</span>
                    <p>{textOr(compiledRelationshipState?.summary, "No relationship state saved for this chat yet.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Current scene</span>
                    <p>{textOr(compiledRelationshipState?.currentScene, "No current scene saved yet.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Character state</span>
                    <p>{textOr(compiledRelationshipState?.characterState, "No character state saved yet.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">User state</span>
                    <p>{textOr(compiledRelationshipState?.userState, "No user state saved yet.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Chat-specific role</span>
                    <p>{textOr(compiledRelationshipState?.userRoleName, "Using the default identity for this chat.")}</p>
                  </article>
                  <article className="inspector-card">
                    <span className="inspector-card-kicker">Chat role details</span>
                    <p>{textOr(compiledRelationshipState?.userRoleDescription, "No chat-specific role details saved.")}</p>
                  </article>
                </div>
                <form className="preset-form inspector-form" onSubmit={(event) => void onSaveRelationshipState(event)}>
                  <div className="inspector-role-note">
                    <strong>Identity for this chat</strong>
                    <p>
                      Default profile: {textOr(userProfile.name, "Unnamed user")}. Only set a chat-specific role when the imported card clearly expects you to be someone else.
                    </p>
                  </div>
                  {suggestedUserRole && (
                    <div className="inspector-helper-card">
                      <div>
                        <strong>Suggested role from card: {suggestedUserRole.name}</strong>
                        <p>
                          {suggestedUserRole.description
                            ? suggestedUserRole.description
                            : `The imported card explicitly defines the user as ${suggestedUserRole.name}.`}
                        </p>
                      </div>
                      <button type="button" className="ghost" onClick={onApplySuggestedUserRole}>
                        Use Suggested Role
                      </button>
                    </div>
                  )}
                  <label className="preset-field">
                    <span>Optional chat-specific role</span>
                    <input
                      className="search-input"
                      placeholder="Leave blank to use your default identity"
                      value={relationshipDraft.userRoleName}
                      onChange={(event) =>
                        setRelationshipDraft((prev) => ({ ...prev, userRoleName: event.target.value }))
                      }
                    />
                  </label>
                  <label className="preset-field">
                    <span>Optional role details</span>
                    <textarea
                      className="search-input"
                      rows={2}
                      placeholder="Describe who you are in this chat only if you need an override"
                      value={relationshipDraft.userRoleDescription}
                      onChange={(event) =>
                        setRelationshipDraft((prev) => ({ ...prev, userRoleDescription: event.target.value }))
                      }
                    />
                  </label>
                  <textarea
                    className="search-input"
                    rows={3}
                    placeholder="Relationship summary"
                    value={relationshipDraft.summary}
                    onChange={(event) =>
                      setRelationshipDraft((prev) => ({ ...prev, summary: event.target.value }))
                    }
                  />
                  <textarea
                    className="search-input"
                    rows={2}
                    placeholder="Current scene"
                    value={relationshipDraft.currentScene}
                    onChange={(event) =>
                      setRelationshipDraft((prev) => ({ ...prev, currentScene: event.target.value }))
                    }
                  />
                  <textarea
                    className="search-input"
                    rows={2}
                    placeholder="Interaction tone"
                    value={relationshipDraft.interactionTone}
                    onChange={(event) =>
                      setRelationshipDraft((prev) => ({ ...prev, interactionTone: event.target.value }))
                    }
                  />
                  <textarea
                    className="search-input"
                    rows={2}
                    placeholder="Character state"
                    value={relationshipDraft.characterState}
                    onChange={(event) =>
                      setRelationshipDraft((prev) => ({ ...prev, characterState: event.target.value }))
                    }
                  />
                  <textarea
                    className="search-input"
                    rows={2}
                    placeholder="User state"
                    value={relationshipDraft.userState}
                    onChange={(event) =>
                      setRelationshipDraft((prev) => ({ ...prev, userState: event.target.value }))
                    }
                  />
                  <div className="preset-form-actions">
                    <button type="button" className="ghost" onClick={onClearChatSpecificUserRole}>
                      Use Default Identity
                    </button>
                    <button type="submit" className="ghost" disabled={savingRelationship || loadingRelationship || !activeChat}>
                      {savingRelationship ? "Saving..." : loadingRelationship ? "Loading..." : "Save Relationship"}
                    </button>
                  </div>
                </form>
              </section>

              <section className="detail-section">
                <h4><IconLabel icon="memory">Memory</IconLabel></h4>
                <p>{textOr(activeMemory?.summary, "No memory summary yet.")}</p>
                {activeMemory?.summary && activeMemory.summaryAuto && (
                  <small className="settings-note">Written automatically as the chat grows.</small>
                )}
                {activeMemory && activeMemory.facts.length > 0 && (
                  <div className="trait-wrap" style={{ marginTop: 9 }}>
                    {activeMemory.facts.map((fact) => (
                      <span key={fact} className="trait-chip memory-chip">{fact}</span>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 10 }}>
                  <button type="button" className="ghost" disabled={savingMemory} onClick={() => void onRefreshMemory()}>
                    <IconLabel icon="memory">{savingMemory ? "Refreshing..." : "Refresh Memory"}</IconLabel>
                  </button>
                </div>
              </section>
              <section className="detail-section">
                <h4>Memories</h4>
                <p className="settings-note">
                  What characters remember, about you and about each other. Edit, pin, or delete anything.
                </p>
                <MemoryManager
                  {...chatMemory}
                  characters={memoryCharacters}
                  chatId={activeChatId ?? undefined}
                />
              </section>

              <section className="detail-section">
                <h4>Context Bank</h4>
                <form className="context-form inspector-form" onSubmit={(event) => void onCreateContextEntry(event)}>
                  <select
                    className="search-input"
                    value={contextDraft.scope}
                    onChange={(event) =>
                      setContextDraft((prev) => ({
                        ...prev,
                        scope: event.target.value === "global" ? "global" : "character",
                      }))
                    }
                  >
                    <option value="character">Character Scope</option>
                    <option value="global">Global Scope</option>
                  </select>
                  <input
                    className="search-input"
                    placeholder="Entry title"
                    value={contextDraft.title}
                    onChange={(event) =>
                      setContextDraft((prev) => ({ ...prev, title: event.target.value }))
                    }
                  />
                  <input
                    className="search-input"
                    placeholder="Keywords (comma separated)"
                    value={contextDraft.keywords}
                    onChange={(event) =>
                      setContextDraft((prev) => ({ ...prev, keywords: event.target.value }))
                    }
                  />
                  <textarea
                    className="search-input"
                    rows={3}
                    placeholder="Context content"
                    value={contextDraft.content}
                    onChange={(event) =>
                      setContextDraft((prev) => ({ ...prev, content: event.target.value }))
                    }
                  />
                  <label className="context-toggle">
                    <input
                      type="checkbox"
                      checked={contextDraft.enabled}
                      onChange={(event) =>
                        setContextDraft((prev) => ({ ...prev, enabled: event.target.checked }))
                      }
                    />
                    Enabled
                  </label>
                  <button type="submit" className="ghost" disabled={savingContext}>
                    {savingContext ? "Saving..." : "Add Context"}
                  </button>
                </form>

                <div className="context-list">
                  {contextEntries.length === 0 && <p className="empty-note">No context entries yet.</p>}
                  {contextEntries.map((entry) => (
                    <div key={entry.id} className={`context-entry${entry.enabled ? "" : " disabled"}`}>
                      <div className="context-entry-head">
                        <strong>{entry.title}</strong>
                        <div className="context-entry-actions">
                          <button type="button" className="ghost" onClick={() => void onToggleContextEntry(entry)}>
                            {entry.enabled ? "Disable" : "Enable"}
                          </button>
                          <button type="button" className="ghost danger" onClick={() => void onDeleteContextEntry(entry)}>
                            Delete
                          </button>
                        </div>
                      </div>
                      <p>{entry.content}</p>
                      {entry.keywords.length > 0 && (
                        <div className="trait-wrap">
                          {entry.keywords.map((keyword) => (
                            <span key={`${entry.id}-${keyword}`} className="trait-chip memory-chip">{keyword}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              {activeContextHits.length > 0 && (
                <section className="detail-section">
                  <h4>Active Context Hits</h4>
                  <div className="context-list">
                    {activeContextHits.map((entry) => (
                      <div key={`hit-${entry.id}`} className="context-entry">
                        <div className="context-entry-head">
                          <strong>{entry.title}</strong>
                          <small>{entry.scope}</small>
                        </div>
                        <p>{entry.content}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {activeMemoryHits.length > 0 && (
                <section className="detail-section">
                  <h4>Active Memory Hits</h4>
                  <div className="context-list">
                    {activeMemoryHits.map((snippet, index) => (
                      <div
                        key={`memory-hit-${snippet.messageId ?? snippet.createdAt ?? "unknown"}-${index}`}
                        className="context-entry"
                      >
                        <div className="context-entry-head">
                          <strong>{snippet.source === "memory-item" ? "memory" : snippet.role}</strong>
                          <small>score {snippet.score}</small>
                        </div>
                        <p>{snippetPreview(snippet.content)}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
          {showLegacyDetailTabs && detailTab === "diagnostics" && (
            renderDiagnosticsWorkspace()
          )}
        </div>
      </aside>
      )
      ) : null}
      </div>

      {groupBuilderOpen && (
        <dialog
          open
          className="modal-overlay"
          aria-label="Create group chat"
        >
          <div className="settings-modal group-builder-modal" tabIndex={-1}>
            <header className="settings-header onboarding-header">
              <div>
                <p className="settings-eyebrow">Group Chat</p>
                <h3>Create a shared conversation</h3>
              </div>
              <button type="button" className="ghost" onClick={closeGroupBuilder}>
                Close
              </button>
            </header>

            <form className="onboarding-body group-builder-body" onSubmit={(event) => void onCreateGroup(event)}>
              <section className="detail-section settings-section">
                <h4>Core setup</h4>
                <p className="settings-note">
                  Pick 2 or more characters, give the chat a name, and optionally define the live scene so the group starts with better context.
                </p>
                <label className="preset-field">
                  <span>Group title</span>
                  <input
                    className="search-input"
                    placeholder="Midnight Council"
                    value={groupTitle}
                    onChange={(event) => setGroupTitle(event.target.value)}
                  />
                </label>
                <label className="preset-field">
                  <span>Scene setup</span>
                  <textarea
                    className="search-input"
                    rows={3}
                    placeholder="Where is the group, what just happened, and what tension is in the room?"
                    value={groupSceneDraft}
                    onChange={(event) => setGroupSceneDraft(event.target.value)}
                  />
                </label>
                <label className="preset-field">
                  <span>Group dynamic</span>
                  <textarea
                    className="search-input"
                    rows={2}
                    placeholder="Allies under pressure, hostile standoff, uneasy collaboration..."
                    value={groupSummaryDraft}
                    onChange={(event) => setGroupSummaryDraft(event.target.value)}
                  />
                </label>
                <div className="preset-inline-grid">
                  <label className="preset-field">
                    <span>Interaction tone</span>
                    <input
                      className="search-input"
                      placeholder="Tense, playful, wary..."
                      value={groupToneDraft}
                      onChange={(event) => setGroupToneDraft(event.target.value)}
                    />
                  </label>
                  <label className="preset-field">
                    <span>Your state</span>
                    <input
                      className="search-input"
                      placeholder="Armed, cornered, calm, bluffing..."
                      value={groupUserStateDraft}
                      onChange={(event) => setGroupUserStateDraft(event.target.value)}
                    />
                  </label>
                </div>
              </section>

              <section className="detail-section settings-section">
                <h4>Participants</h4>
                <p className="builder-note">Choose 2 or more characters. Everyone in the roster can answer inside the same chat thread.</p>
                <div className="group-member-list group-builder-member-list">
                  {characters.map((character) => {
                    const selected = groupSelection.includes(character.id);
                    return (
                      <label
                        key={`create-group-${character.id}`}
                        className={`group-member-option${selected ? " active" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => {
                            setGroupSelection((prev) =>
                              prev.includes(character.id)
                                ? prev.filter((id) => id !== character.id)
                                : dedupeIds([...prev, character.id]),
                            );
                          }}
                        />
                        <span>{character.name}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="trait-wrap group-participant-chips">
                  {groupSelection.map((id) => (
                    <span key={`group-create-chip-${id}`} className="trait-chip">
                      {charMap.get(id)?.name ?? id}
                    </span>
                  ))}
                </div>
              </section>

              <div className="settings-footer group-builder-footer">
                <button
                  className="primary"
                  type="submit"
                  disabled={creatingGroup || groupSelection.length < 2 || !groupTitle.trim()}
                >
                  {creatingGroup ? "Creating..." : "Create Group Chat"}
                </button>
                <button className="ghost" type="button" onClick={closeGroupBuilder}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </dialog>
      )}

      {showFirstRunOnboarding && (
        <dialog
          open
          className="modal-overlay onboarding-overlay"
          aria-label="First-run setup"
        >
          <div
            className="settings-modal onboarding-modal"
            tabIndex={-1}
          >
            <header className="settings-header onboarding-header">
              <div>
                <p className="settings-eyebrow">Private chat</p>
                <h3>{activeModel ? "Private AI needs attention" : "Glee needs to finish setting up"}</h3>
              </div>
              <button type="button" className="ghost" onClick={() => setFirstRunSetupDismissed(true)}>
                Open Without Replies
              </button>
            </header>

            <div className="onboarding-body">
              <section className="detail-section settings-section">
                {activeModel ? (
                  <>
                    <h4>The AI could not start</h4>
                    <p className="settings-note">
                      Your characters and conversations are safe. Try starting the AI again, or open Diagnostics to see what went wrong.
                    </p>
                    <RuntimeStartupSummaryCard runtime={runtime} />
                    <div className="settings-inline-row">
                      <button
                        type="button"
                        className="primary"
                        disabled={startingRuntime}
                        onClick={() => void onCompleteFirstRunRuntimeStart()}
                      >
                        {startingRuntime ? "Starting..." : "Try Again"}
                      </button>
                      <button type="button" className="ghost" onClick={onOpenDiagnosticsWorkspace}>
                        Diagnostics &amp; Recovery
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h4>Glee still needs to download its AI</h4>
                    <p className="settings-note">
                      Glee downloads its AI model and engine once (about 1.3 GB) and then works without an internet connection. Connect to the internet and choose Download, or pick a model file you already have.
                    </p>
                    {resourceSetup.running && (
                      <div role="status" aria-live="polite">
                        <progress max={100} value={resourceSetup.percent} aria-label="Download progress" />
                        <p className="settings-note">{resourceSetup.detail}</p>
                      </div>
                    )}
                    {resourceSetup.error && !resourceSetup.running && (
                      <p className="settings-note">{resourceSetup.error}</p>
                    )}
                    <div className="settings-inline-row">
                      {resourceSetup.running ? (
                        <button type="button" className="ghost" onClick={resourceSetup.cancel}>
                          Pause
                        </button>
                      ) : (
                        <button type="button" className="primary" onClick={() => void resourceSetup.start()}>
                          {resourceSetup.partialBytes > 0 ? "Resume Download" : "Download AI Files"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="ghost"
                        disabled={importingModel}
                        onClick={() => void onImportModel()}
                      >
                        {importingModel ? "Adding..." : "Use a Model File I Have"}
                      </button>
                    </div>
                  </>
                )}
              </section>
            </div>
          </div>
        </dialog>
      )}

      {settingsOpen && (
        <dialog
          open
          className="modal-overlay"
          aria-label="Settings"
        >
          <div className="settings-modal" tabIndex={-1}>
            <header className="settings-header">
              <div>
                <p className="settings-eyebrow">Settings</p>
                <h3>Workspace</h3>
              </div>
              <button type="button" className="ghost" onClick={() => closeSettingsPanel()}>
                Close
              </button>
            </header>

            <div className="settings-grid">
              <UpdateSettingsSection />
              <section className="detail-section settings-section theme-settings-section">
                <h4>Theme</h4>
                <p className="settings-note">
                  Choose the color palette used across your workspace. Changes apply immediately and remain selected after restart.
                </p>
                <div className="theme-option-grid" role="radiogroup" aria-label="Workspace theme">
                  {THEME_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`theme-option${theme === option.id ? " active" : ""}`}
                      data-theme-option={option.id}
                      role="radio"
                      aria-checked={theme === option.id}
                      onClick={() => onSelectTheme(option.id)}
                    >
                      <span className="theme-option-swatches" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="theme-option-copy">
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                      <span className="theme-option-radio" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </section>

              <section className="detail-section settings-section">
                <h4>Privacy &amp; Private AI</h4>
                <p className="settings-note">
                  Glee generates replies and stores character chats on this computer. No account is required.
                </p>
                <ul className="meta-list">
                  <li><span>Private AI</span><strong>{runtime.status === "running" ? "Ready" : runtime.status === "starting" ? "Preparing" : runtime.status === "error" ? "Needs attention" : "Not running"}</strong></li>
                  <li><span>Chat storage</span><strong>On this device</strong></li>
                </ul>
                <div className="settings-inline-row">
                  {runtime.status !== "running" && (
                    <button
                      type="button"
                      className="primary"
                      disabled={startingRuntime || !activeModel}
                      onClick={() => void onStartRuntime()}
                    >
                      {startingRuntime ? "Preparing..." : "Prepare Private AI"}
                    </button>
                  )}
                  <button type="button" className="ghost" onClick={onOpenDiagnosticsWorkspace}>
                    <IconLabel icon="diagnostics">Diagnostics &amp; Recovery</IconLabel>
                  </button>
                </div>
              </section>

              <section className="detail-section settings-section">
                <h4>My Data</h4>
                <p className="settings-note">
                  Create a backup before major edits, save a copy somewhere safe, or restore an earlier workspace (including one from another computer) if something goes wrong.
                </p>
                <div className="settings-inline-row">
                  <button type="button" className="ghost" disabled={creatingDatabaseBackup} onClick={() => void onBackupDatabase()}>
                    {creatingDatabaseBackup ? "Backing up..." : "Back Up My Data"}
                  </button>
                  <button type="button" className="ghost" onClick={() => void onAddBackupFromFile()}>
                    Restore From a File...
                  </button>
                </div>
                <div className="database-backup-list" aria-label="Available database backups">
                  {databaseBackups.length === 0 ? (
                    <p className="empty-note">No backups are available yet.</p>
                  ) : (
                    databaseBackups.map((backup) => (
                      <div className="context-entry" key={`settings-${backup.fileName}`}>
                        <div className="context-entry-head">
                          <span>
                            <strong>{backup.reason === "manual" ? "Manual backup" : backup.reason.replace(/-/g, " ")}</strong>
                            <small>{displayDate(backup.modifiedAt)} · {formatBytes(backup.sizeBytes)}</small>
                          </span>
                          <span className="settings-inline-row">
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => void onSaveBackupCopy(backup.fileName)}
                            >
                              Save a Copy...
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              disabled={restoringDatabase}
                              onClick={() => {
                                if (window.confirm("Restore this backup? Glee will first preserve your current data, then restart.")) {
                                  void onRestoreDatabase(backup.fileName);
                                }
                              }}
                            >
                              {restoringDatabase ? "Restoring..." : "Restore"}
                            </button>
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="detail-section settings-section">
                <h4>Support &amp; Diagnostics</h4>
                <p className="settings-note">Health checks and recovery remain available even when technical controls are hidden.</p>
                <p>{summarizeDiagnostics(diagnostics)}</p>
                <div className="settings-inline-row">
                  <button type="button" className="ghost" disabled={loadingDiagnostics} onClick={() => void onRefreshDiagnostics()}>
                    {loadingDiagnostics ? "Refreshing..." : "Refresh Health"}
                  </button>
                  <button type="button" className="ghost" disabled={exportingDiagnostics} onClick={() => void onExportDiagnostics()}>
                    {exportingDiagnostics ? "Exporting..." : "Export Support Files"}
                  </button>
                </div>
              </section>

              <section className="detail-section settings-section">
                <h4>AI model</h4>
                <p className="settings-note">
                  Glee&apos;s AI runs on this computer. Pause it to free memory; resume it when you want replies again.
                </p>
                <ul className="meta-list">
                  <li><span>Status</span><strong>{runtimeStatusText(runtime)}</strong></li>
                  <li><span>Running on</span><strong>{runtime.status === "running" ? `${runtimeAccelerationText(runtime)}${runtimeHardwareText(runtime) !== "Automatic" ? ` (${runtimeHardwareText(runtime)})` : ""}` : "-"}</strong></li>
                </ul>
                <label className="preset-field">
                  <span>Model</span>
                  <select
                    className="search-input model-select"
                    value={activeModel?.id ?? ""}
                    onChange={(event) => void onSetActiveModel(event.target.value)}
                  >
                    {models.length === 0 && <option value="">No model installed</option>}
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="preset-field">
                  <span>Run the AI on</span>
                  <select
                    className="search-input"
                    value={runtimeSettings.performanceMode}
                    disabled={startingRuntime || stoppingRuntime}
                    onChange={(event) => void onChangePerformanceMode(event.target.value as RuntimePerformanceMode)}
                  >
                    <option value="auto">Automatic (recommended)</option>
                    <option value="cpu">Processor only</option>
                    <option value="gpu">Graphics card</option>
                  </select>
                </label>
                <div className="settings-inline-row">
                  {runtime.status === "running" ? (
                    <button type="button" className="ghost" disabled={stoppingRuntime} onClick={() => void onStopRuntime()}>
                      {stoppingRuntime ? "Pausing..." : "Pause AI"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      disabled={startingRuntime || !activeModel}
                      onClick={() => void onStartRuntime()}
                    >
                      {startingRuntime ? "Starting..." : "Resume AI"}
                    </button>
                  )}
                  <button type="button" className="ghost" disabled={importingModel} onClick={() => void onImportModel()}>
                    {importingModel ? "Adding..." : "Add a Model File..."}
                  </button>
                </div>
                <p className="settings-note">
                  Glee is tuned for its built-in model, Ternary Bonsai 2 4B. Other <code>.gguf</code> models can be added, but they may reply differently and some chat templates do not work in group chats.
                </p>
              </section>

              <section className="detail-section settings-section">
                <h4>Memories</h4>
                <p className="settings-note">
                  Everything Glee&apos;s characters remember, stored only on this computer.
                </p>
                <MemoryManager
                  {...allMemory}
                  characters={memoryCharacters}
                  chatTitles={memoryChatTitles}
                  showCharacterFilter
                />
              </section>

              <ExtensionSettings />

              <details className="settings-advanced">
                <summary>Advanced</summary>
              <section className="detail-section settings-section">
                <h4>Model Library</h4>
                <p className="settings-note">
                  Imported models appear here. Add a local GGUF by file/path or download one directly from a hosted HTTPS URL.
                </p>
                {recommendedModel && (
                  <div className="inspector-helper-card onboarding-card">
                    <div>
                      <strong>Recommended download: {recommendedModel.name}</strong>
                      <p>{recommendedModel.description}</p>
                      {recommendedModel.sizeLabel && <p>Approx size: {recommendedModel.sizeLabel}</p>}
                    </div>
                    <button
                      type="button"
                      className="ghost"
                      disabled={downloadingModel || importingModel}
                      onClick={() => void onDownloadRecommendedModel()}
                    >
                      {downloadingModel ? "Downloading..." : "Download"}
                    </button>
                  </div>
                )}
                {modelDownloadProgress && (
                  <div className="inspector-helper-card onboarding-card" role="status" aria-live="polite">
                    <div>
                      <strong>Model download</strong>
                      <p>{modelDownloadProgressText(modelDownloadProgress)}</p>
                    </div>
                    {downloadingModel && (
                      <button type="button" className="ghost" onClick={() => void onCancelModelDownload()}>
                        Cancel Download
                      </button>
                    )}
                  </div>
                )}
                <label className="preset-field">
                  <span>Active Model</span>
                  <select
                    className="search-input model-select"
                    value={activeModel?.id ?? ""}
                    onChange={(event) => void onSetActiveModel(event.target.value)}
                  >
                    {models.length === 0 && <option value="">No model imported</option>}
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                        {model.isActive ? " (Active)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="preset-field">
                  <span>Import By Path</span>
                  <input
                    className="search-input"
                    placeholder="D:\\Models\\your-model.gguf"
                    value={modelPathDraft}
                    onChange={(event) => setModelPathDraft(event.target.value)}
                  />
                </label>
                <label className="preset-field">
                  <span>Download By URL</span>
                  <input
                    className="search-input"
                    placeholder="https://your-domain/model.gguf"
                    value={modelUrlDraft}
                    onChange={(event) => setModelUrlDraft(event.target.value)}
                  />
                </label>
                <div className="settings-inline-row">
                  <button className="ghost" type="button" disabled={importingModel} onClick={() => void onImportModel()}>
                    {importingModel ? "Importing..." : "Import GGUF"}
                  </button>
                  <button className="ghost" type="button" disabled={importingModel || !modelPathDraft.trim()} onClick={() => void onImportModelFromPath()}>
                    {importingModel ? "Importing..." : "Import Path"}
                  </button>
                  <button className="ghost" type="button" disabled={downloadingModel || !modelUrlDraft.trim()} onClick={() => void onDownloadModelFromDraft()}>
                    {downloadingModel ? "Downloading..." : "Download URL"}
                  </button>
                  <button className="ghost" type="button" onClick={() => void onRefreshModelLibrary()}>
                    Refresh
                  </button>
                   <button type="button" className="ghost" onClick={onOpenDiagnosticsWorkspace}>
                    <IconLabel icon="diagnostics">Diagnostics</IconLabel>
                  </button>
                </div>
                <div className="preset-list model-library-list">
                  {models.length === 0 && <p className="empty-note">No models imported yet.</p>}
                  {models.map((model) => (
                    <div
                      key={model.id}
                      className={`preset-row${model.isActive ? " active" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => void onSetActiveModel(model.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          void onSetActiveModel(model.id);
                        }
                      }}
                    >
                      <button
                        type="button"
                        className="preset-main"
                        onClick={(event) => {
                          event.stopPropagation();
                          void onSetActiveModel(model.id);
                        }}
                      >
                        <strong>{model.name}{model.isActive ? " (Active)" : ""}</strong>
                        <small>{displayPath(model.path)}</small>
                      </button>
                      <div className="preset-row-actions">
                        <button
                          type="button"
                          className="ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            void onSetActiveModel(model.id);
                          }}
                        >
                          {model.isActive ? "Selected" : "Use"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <ul className="meta-list">
                  <li><span>Path</span><strong>{displayPath(activeModel?.path)}</strong></li>
                  <li><span>Updated</span><strong>{activeModel ? displayDate(activeModel.updatedAt) : "-"}</strong></li>
                  <li><span>Hash</span><strong>{activeModel?.sha256.slice(0, 12) ?? "-"}</strong></li>
                </ul>
              </section>

              <section className="detail-section settings-section">
                <h4>Runtime</h4>
                <p>{buildRuntimeRecoveryMessage(runtime)}</p>
                <RuntimeStartupSummaryCard runtime={runtime} />
                {runtime.status === "error" && (
                  <RuntimeRecoverySupportCard
                    plan={runtimeRecoveryPlan}
                    runtime={runtime}
                    canRetryStart={Boolean(activeModel)}
                    startingRuntime={startingRuntime}
                    exportingDiagnostics={exportingDiagnostics}
                    creatingDatabaseBackup={creatingDatabaseBackup}
                    onRetryStart={() => void onStartRuntime()}
                    onOpenDiagnostics={onOpenDiagnosticsWorkspace}
                    onExportDiagnostics={() => void onExportDiagnostics()}
                    onBackupDatabase={() => void onBackupDatabase()}
                    onCopySupportSummary={() => void onCopyRuntimeSupportSummary()}
                    onCopyRuntimeLog={() => void onCopyRuntimeLogPath()}
                  />
                )}
                <div className="settings-inline-row">
                  <span className={`runtime-chip ${runtime.status === "running" ? "running" : runtime.status === "error" ? "error" : ""}`}>
                    Runtime: {runtimeStatusText(runtime)}
                  </span>
                  <button
                    className="primary"
                    type="button"
                    disabled={startingRuntime || !activeModel || runtime.status === "running"}
                    onClick={() => void onStartRuntime()}
                  >
                    {startingRuntime ? "Starting..." : "Start"}
                  </button>
                  <button
                    type="button"
                    disabled={stoppingRuntime || runtime.status !== "running"}
                    onClick={() => void onStopRuntime()}
                  >
                    {stoppingRuntime ? "Stopping..." : "Stop"}
                  </button>
                </div>
                <ul className="meta-list">
                  <li><span>Endpoint</span><strong>{resolveChatCompletionsUrl(runtime.endpoint)}</strong></li>
                  <li><span>Runtime log</span><strong>{runtime.logFile ?? "Unavailable"}</strong></li>
                  <li><span>Safe context</span><strong>{SAFE_RUNTIME_CONTEXT_SIZE.toLocaleString()} tokens</strong></li>
                </ul>
                <p className="settings-note">
                  Glee now starts llama.cpp with a safe default context window to avoid 128k models allocating workstation-scale KV caches on startup.
                </p>
              </section>

              <section className="detail-section settings-section">
                <h4>Generation Controls</h4>
                <p>Technical sampling controls only. These do not define the character identity.</p>
                <label className="preset-field">
                  <span>Active Generation Preset</span>
                  <select
                    className="search-input"
                    value={activeGenerationPresetId}
                    onChange={(event) => onSelectGenerationPreset(event.target.value)}
                  >
                    <option value="">Default</option>
                    {generationPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name} (T {preset.temperature.toFixed(2)} | P {preset.topP.toFixed(2)})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="preset-section-head">
                  <h4>Generation Presets</h4>
                  <button type="button" className="ghost" onClick={() => onStartCreateGenerationPreset()}>
                    New
                  </button>
                </div>
                <div className="preset-list">
                  {generationPresets.length === 0 && <p className="empty-note">No generation presets yet.</p>}
                  {generationPresets.map((preset) => {
                    const isDeleting = deletingPresetKey === `generation:${preset.id}`;
                    return (
                      <div
                        key={preset.id}
                        className={`preset-row${preset.id === activeGenerationPresetId ? " active" : ""}`}
                      >
                        <button
                          type="button"
                          className="preset-main"
                          onClick={() => onSelectGenerationPreset(preset.id)}
                        >
                          <strong>{preset.name}</strong>
                          <small>
                            T {preset.temperature.toFixed(2)} | P {preset.topP.toFixed(2)}
                            {` | RP ${preset.repeatPenalty.toFixed(2)}`}
                            {preset.maxTokens ? ` | Max ${preset.maxTokens}` : ""}
                          </small>
                        </button>
                        <div className="preset-row-actions">
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => onStartEditGenerationPreset(preset)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={isDeleting}
                            onClick={() => void onDeleteGenerationPresetClick(preset)}
                          >
                            {isDeleting ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <form className="preset-form" onSubmit={(event) => void onSaveGenerationPreset(event)}>
                  <input
                    className="search-input"
                    placeholder="Preset name"
                    value={generationPresetDraft.name}
                    onChange={(event) =>
                      setGenerationPresetDraft((prev) => ({ ...prev, name: event.target.value }))
                    }
                  />
                  <input
                    className="search-input"
                    placeholder="Description (optional)"
                    value={generationPresetDraft.description}
                    onChange={(event) =>
                      setGenerationPresetDraft((prev) => ({ ...prev, description: event.target.value }))
                    }
                  />
                  <div className="preset-inline-grid">
                    <input
                      className="search-input"
                      type="number"
                      min={0.01}
                      max={2}
                      step={0.01}
                      placeholder="Temperature"
                      value={generationPresetDraft.temperature}
                      onChange={(event) =>
                        setGenerationPresetDraft((prev) => ({ ...prev, temperature: event.target.value }))
                      }
                    />
                    <input
                      className="search-input"
                      type="number"
                      min={0.01}
                      max={1}
                      step={0.01}
                      placeholder="Top P"
                      value={generationPresetDraft.topP}
                      onChange={(event) =>
                        setGenerationPresetDraft((prev) => ({ ...prev, topP: event.target.value }))
                      }
                    />
                  </div>
                  <input
                    className="search-input"
                    type="number"
                    min={1}
                    step={1}
                    placeholder="Max tokens (optional)"
                    value={generationPresetDraft.maxTokens}
                    onChange={(event) =>
                      setGenerationPresetDraft((prev) => ({ ...prev, maxTokens: event.target.value }))
                    }
                  />
                  <input
                    className="search-input"
                    type="number"
                    min={0.01}
                    max={3}
                    step={0.01}
                    placeholder="Repeat penalty"
                    value={generationPresetDraft.repeatPenalty}
                    onChange={(event) =>
                      setGenerationPresetDraft((prev) => ({ ...prev, repeatPenalty: event.target.value }))
                    }
                  />
                  <div className="preset-form-actions">
                    <button type="submit" className="primary" disabled={savingGenerationPreset}>
                      {savingGenerationPreset
                        ? "Saving..."
                        : generationEditorMode === "edit"
                          ? "Update Generation"
                          : "Create Generation"}
                    </button>
                    {generationEditorMode === "edit" && (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => onStartCreateGenerationPreset()}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </form>
              </section>
              </details>
            </div>
          </div>
        </dialog>
      )}

      {profileOpen && (
        <dialog
          open
          className="modal-overlay"
          aria-label="Your profile"
        >
          <div className="settings-modal profile-modal" tabIndex={-1}>
            <header className="settings-header onboarding-header">
              <div>
                <p className="settings-eyebrow">User Profile</p>
                <h3>Default identity</h3>
              </div>
              <button type="button" className="ghost" onClick={() => void closeProfileEditor()}>
                Close
              </button>
            </header>

            <div className="settings-grid profile-settings-grid">
              <section className="detail-section settings-section">
                <h4>How Glee should know you</h4>
                <p className="settings-note">
                  These details follow you across chats unless you set a chat-specific role in the relationship panel.
                </p>
                <div className="profile-portrait-card">
                  <UserProfileAvatar
                    imagePath={userProfileDraft.avatar}
                    name={userProfileDraft.name || userProfile.name}
                    className="profile-portrait-avatar"
                  />
                  <div className="profile-portrait-copy">
                    <span className="detail-kicker">Profile image</span>
                    <p>Use a local image for your default identity across the app.</p>
                    <div className="profile-portrait-actions">
                      <button type="button" className="ghost" onClick={() => void onChooseUserProfileImage()}>
                        Choose Image
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={!userProfileDraft.avatar.trim()}
                        onClick={onClearUserProfileImage}
                      >
                        Remove
                      </button>
                    </div>
                    <small className="profile-portrait-meta">
                      {userProfileDraft.avatar.trim()
                        ? `Selected: ${fileBaseName(userProfileDraft.avatar)}`
                        : "No profile image selected yet."}
                    </small>
                  </div>
                </div>
                <form className="preset-form profile-form" onSubmit={(event) => void onSaveUserProfile(event)}>
                  <div className="preset-inline-grid">
                    <label className="preset-field">
                      <span>Name</span>
                      <input
                        className="search-input"
                        placeholder="Your name"
                        value={userProfileDraft.name}
                        onChange={(event) =>
                          setUserProfileDraft((prev) => ({ ...prev, name: event.target.value }))
                        }
                      />
                    </label>
                    <label className="preset-field">
                      <span>Gender</span>
                      <input
                        className="search-input"
                        placeholder="Woman, man, nonbinary, or however you want to be described"
                        value={userProfileDraft.gender}
                        onChange={(event) =>
                          setUserProfileDraft((prev) => ({ ...prev, gender: event.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <label className="preset-field">
                    <span>About you</span>
                    <textarea
                      className="search-input"
                      rows={4}
                      placeholder="What should characters know about you by default?"
                      value={userProfileDraft.about}
                      onChange={(event) =>
                        setUserProfileDraft((prev) => ({ ...prev, about: event.target.value }))
                      }
                    />
                  </label>
                  <label className="preset-field">
                    <span>Traits</span>
                    <input
                      className="search-input"
                      placeholder="curious, guarded, intense"
                      value={userProfileDraft.traits}
                      onChange={(event) =>
                        setUserProfileDraft((prev) => ({ ...prev, traits: event.target.value }))
                      }
                    />
                  </label>
                  <label className="preset-field">
                    <span>Preferences</span>
                    <textarea
                      className="search-input"
                      rows={3}
                      placeholder="Preferred tone, pacing, themes, or interaction style"
                      value={userProfileDraft.preferences}
                      onChange={(event) =>
                        setUserProfileDraft((prev) => ({ ...prev, preferences: event.target.value }))
                      }
                    />
                  </label>
                  <label className="preset-field">
                    <span>Boundaries</span>
                    <textarea
                      className="search-input"
                      rows={3}
                      placeholder="Content or dynamics you want characters to avoid"
                      value={userProfileDraft.boundaries}
                      onChange={(event) =>
                        setUserProfileDraft((prev) => ({ ...prev, boundaries: event.target.value }))
                      }
                    />
                  </label>
                  <div className="preset-form-actions">
                    <button type="submit" className="primary" disabled={savingUserProfile}>
                      {savingUserProfile ? "Saving..." : "Save Profile"}
                    </button>
                    <button type="button" className="ghost" onClick={() => void closeProfileEditor()}>
                      Done
                    </button>
                  </div>
                </form>
                <ul className="meta-list">
                  <li><span>Current name</span><strong>{userProfile?.name || "-"}</strong></li>
                  <li><span>Gender</span><strong>{userProfile?.gender || "-"}</strong></li>
                  <li><span>Image</span><strong>{userProfile?.avatar ? fileBaseName(userProfile.avatar) : "-"}</strong></li>
                  <li><span>Traits</span><strong>{userProfile?.traits.join(", ") || "-"}</strong></li>
                </ul>
              </section>
              <PersonaManager
                personas={personas}
                editingPersonaId={editingPersonaId}
                draft={personaDraft}
                saving={savingPersona}
                onChangeDraft={(patch) => setPersonaDraft((prev) => ({ ...prev, ...patch }))}
                onEdit={startEditPersona}
                onCancelEdit={startCreatePersona}
                onSave={savePersona}
                onDelete={(persona) => removePersona(persona.id)}
              />
            </div>
          </div>
        </dialog>
      )}

      {characterProfileOpen && activeCharacter && (
        <dialog
          open
          className="modal-overlay"
          aria-label="Character profile"
        >
          <div className="settings-modal character-profile-modal" tabIndex={-1}>
            <div className="character-profile-modal-head">
              <div className="character-profile-modal-copy">
                <p className="settings-eyebrow">Character profile</p>
                <h3>{activeCharacter.name}</h3>
                <p className="character-profile-modal-note">
                  Inspect the authored card in a contained view without leaving the hub or chat workspace.
                </p>
              </div>
              <div className="character-profile-modal-actions">
                <button className="primary" type="button" onClick={() => void onStartConversation(activeCharacter)}>
                  Start Chat
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    setCharacterProfileOpen(false);
                    startEditCharacter(activeCharacter);
                  }}
                >
                  Edit
                </button>
                <button type="button" className="ghost" onClick={() => setCharacterProfileOpen(false)}>
                  Close
                </button>
              </div>
            </div>
            <div className="character-profile-modal-body">
              <section className="character-profile-summary">
                <CharacterCardPortrait character={activeCharacter} theme={activeTheme} />
                <div className="character-profile-summary-copy">
                  <div className="character-profile-summary-title">
                    <h4>{activeCharacter.name}</h4>
                    {activeCharacter.tags.length ? (
                      <div className="hub-tag-row">
                        {activeCharacter.tags.slice(0, 4).map((tag) => (
                          <span key={`character-profile-${activeCharacter.id}-${tag}`} className="trait-chip">
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <p>{textOr(activeCharacter.description, "No character description yet.")}</p>
                  <div className="character-profile-meta">
                    <span><strong>Creator</strong> {textOr(activeCharacter.creator, "Unknown")}</span>
                    <span><strong>Version</strong> {textOr(activeCharacter.characterVersion, "Local")}</span>
                  </div>
                </div>
              </section>

              <div className="character-profile-grid">
                <article className="character-profile-card">
                  <span className="detail-kicker">Personality</span>
                  <p>{textOr(activeCharacter.personality || activeCharacter.speechStyle, "No personality profile set.")}</p>
                </article>
                <article className="character-profile-card">
                  <span className="detail-kicker">Scenario</span>
                  <p>{textOr(activeCharacter.scenario, "No scenario framing set.")}</p>
                </article>
                <article className="character-profile-card">
                  <span className="detail-kicker">Backstory</span>
                  <p>{textOr(activeCharacter.backstory, "No backstory provided.")}</p>
                </article>
                <article className="character-profile-card">
                  <span className="detail-kicker">Boundaries</span>
                  <p>{textOr(activeCharacter.boundaries, "No explicit boundaries set.")}</p>
                </article>
                <article className="character-profile-card">
                  <span className="detail-kicker">Greeting</span>
                  <p>{textOr(activeCharacter.greeting, "No greeting set.")}</p>
                </article>
                <article className="character-profile-card">
                  <span className="detail-kicker">Alternate greetings</span>
                  {activeCharacter.alternateGreetings.length ? (
                    <div className="opening-choice-list">
                      {activeCharacter.alternateGreetings.map((greeting, index) => (
                        <button
                          className="ghost opening-choice"
                          key={`${activeCharacter.id}-modal-opening-${index}`}
                          type="button"
                          onClick={() => void onStartConversation(activeCharacter, greeting)}
                        >
                          <span>{snippetPreview(greeting, 120)}</span>
                          <small>Start with this opening</small>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p>No alternate greetings.</p>
                  )}
                </article>
                <article className="character-profile-card wide">
                  <span className="detail-kicker">Example dialogue</span>
                  <pre>{textOr(activeCharacter.exampleDialogue, "No example dialogue set.")}</pre>
                </article>
                <article className="character-profile-card">
                  <span className="detail-kicker">Likes</span>
                  <p>{activeCharacter.likes.length ? activeCharacter.likes.join(" • ") : "No likes recorded."}</p>
                </article>
                <article className="character-profile-card">
                  <span className="detail-kicker">Dislikes</span>
                  <p>{activeCharacter.dislikes.length ? activeCharacter.dislikes.join(" • ") : "No dislikes recorded."}</p>
                </article>
                <article className="character-profile-card wide">
                  <span className="detail-kicker">Advanced instructions</span>
                  <p>{textOr(activeCharacter.systemPrompt, "No advanced instructions set.")}</p>
                  <p className="character-profile-subnote">
                    {textOr(activeCharacter.postHistoryInstructions, "No post-history instructions set.")}
                  </p>
                </article>
              </div>
            </div>
          </div>
        </dialog>
      )}

      {editorMode && (
        <dialog
          open
          className="modal-overlay"
          aria-label="Character Studio"
        >
          <div
            className="character-editor-modal"
            tabIndex={-1}
          >
            <div className="character-editor-modal-head">
              <div className="character-editor-modal-copy">
                <p className="settings-eyebrow">Character Studio</p>
                <h3>{editorMode === "create" ? "Create Character" : "Edit Character"}</h3>
                <p className="character-editor-modal-note">
                  Build identity, scene, and voice first. Use advanced controls only when the core writing is not enough.
                </p>
              </div>
              <span className="character-editor-modal-pill">
                {editorMode === "create" ? "New draft" : "Editing live profile"}
              </span>
              <button type="button" className="ghost" onClick={requestCloseCharacterEditor}>
                Close
              </button>
            </div>
            <div className="character-editor-modal-body">
              <Suspense fallback={<p className="empty-note">Loading Character Studio...</p>}>
                <CharacterEditorPanel
                  editorMode={editorMode}
                  draft={draft}
                  savingCharacter={savingCharacter}
                  activeCharacter={activeCharacter}
                  onChange={(field, value) =>
                    setDraft((prev) => ({
                      ...prev,
                      [field]: value,
                    }))
                  }
                  onSubmit={(event) => void onSaveCharacter(event)}
                  onCancel={requestCloseCharacterEditor}
                  onChoosePortrait={async () => {
                    const selected = await onChooseCharacterPortrait();
                    if (!selected) {
                      return;
                    }
                    setDraft((prev) => ({
                      ...prev,
                      avatar: selected,
                    }));
                  }}
                  onClearPortrait={() =>
                    setDraft((prev) => ({
                      ...prev,
                      avatar: "",
                    }))
                  }
                  onEditCurrent={
                    activeCharacter ? () => startEditCharacter(activeCharacter) : undefined
                  }
                />
              </Suspense>
            </div>
          </div>
        </dialog>
      )}

      {commandPaletteOpen && (
        <dialog
          open
          className="command-overlay"
          aria-label="Command palette"
        >
          <div className="command-modal" tabIndex={-1}>
            <div className="command-modal-head">
              <strong>Commands</strong>
              <button
                type="button"
                className="ghost"
                onClick={() => setCommandPaletteOpen(false)}
              >
                Close
              </button>
            </div>
            <input
              ref={commandInputRef}
              className="search-input command-input"
              placeholder="Type an action..."
              aria-label="Search commands"
              value={commandFilter}
              onChange={(event) => setCommandFilter(event.target.value)}
            />
            <div className="command-list">
              {filteredCommands.length === 0 && <p className="empty-note">No matching actions.</p>}
              {filteredCommands.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="command-item"
                  onClick={() => void onRunCommand(action)}
                >
                  <strong>{action.label}</strong>
                  <small>{action.hint}</small>
                </button>
              ))}
            </div>
          </div>
        </dialog>
      )}
    </div>
  );
}
