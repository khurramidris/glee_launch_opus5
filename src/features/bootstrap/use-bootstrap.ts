import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelFirstRunProvisioning,
  bootstrapState,
  getChatMessages,
  listChatParticipants,
  listGenerationPresets,
  getRuntimeLaunchSettings,
  prepareFirstRunResources,
  resourceStatus,
} from "../../api/tauri";
import { dedupeIds } from "../../lib/chat-domain";
import {
  setBootOverlayCancelAction,
  setBootOverlayError,
  setBootOverlayProgress,
  setBootOverlayText,
  waitForBootOverlayChoice,
} from "../../lib/boot-overlay";
import { describeTransfer, formatBytes, TransferRateMeter } from "../../lib/download-progress";
import {
  useAppStore,
  useCharacterStore,
  useChatStore,
  useContextStore,
  useModelStore,
  useProfileStore,
  usePresetStore,
  useRuntimeSettingsStore,
} from "../../stores";
import type { ProvisioningProgress } from "../../types";
import { normalizeError, sortByRecent, sortChatsByRecent } from "../app/app-domain";

const PROVISIONING_PROGRESS_EVENT = "provisioning-progress";

function waitForBootOverlayPaint(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.setTimeout(resolve, 120);
    });
  });
}

function setupStatus(progress: ProvisioningProgress): string {
  switch (progress.phase) {
    case "planning":
    case "checking_disk":
      return "Getting ready to download...";
    case "downloading":
      return progress.currentFile ? `Downloading ${progress.currentFile}...` : "Downloading...";
    case "verifying":
      return "Checking the download...";
    case "installing":
      return "Installing the AI engine...";
    case "ready":
      return "Almost ready...";
    case "cancelled":
      return "Setup was paused.";
    case "failed":
      return progress.message?.trim() || "Setup could not finish.";
    default:
      return "Setting up...";
  }
}

/**
 * Makes sure the AI model and engine are installed before the workspace
 * opens. Returns false when the user chooses to continue without them.
 */
async function ensureAiResources(): Promise<boolean> {
  const status = await resourceStatus().catch(() => null);
  if (status?.ready && status.items.every((item) => item.installed)) {
    return true;
  }
  if (status && !status.platformSupported) {
    setBootOverlayError(true);
    setBootOverlayProgress({
      progress: 100,
      status: `Glee doesn't support this computer yet (${status.platform}).`,
    });
    await waitForBootOverlayChoice();
    return false;
  }
  if (status?.ready) {
    // Only optional extras (such as GPU acceleration) are missing; fetch them
    // without holding up the app.
    void prepareFirstRunResources().catch(() => undefined);
    return true;
  }

  const total = status?.missingRequiredBytes ?? 0;
  setBootOverlayText({
    subtitle: total
      ? `Setting up Glee. This one-time download is about ${formatBytes(total)}.`
      : "Setting up Glee.",
    detail: "",
  });
  const meter = new TransferRateMeter();
  let jobId: string | null = null;
  const dispose = await listen<ProvisioningProgress>(PROVISIONING_PROGRESS_EVENT, (event) => {
    const progress = event.payload;
    jobId = progress.jobId;
    const done = progress.aggregateBytes;
    const all = progress.aggregateTotalBytes ?? 0;
    const percent = all > 0 ? Math.min(100, (done / all) * 100) : 0;
    setBootOverlayProgress({ progress: 4 + percent * 0.88, status: setupStatus(progress) });
    if (progress.phase === "downloading" && all > 0) {
      setBootOverlayText({ detail: describeTransfer(done, all, meter.update(done)) });
    } else if (progress.phase !== "downloading") {
      setBootOverlayText({ detail: "" });
    }
  }).catch(() => undefined);

  try {
    for (;;) {
      setBootOverlayError(false);
      setBootOverlayProgress({ progress: 4, status: "Connecting..." });
      setBootOverlayCancelAction(() => {
        void cancelFirstRunProvisioning(jobId).catch(() => undefined);
      }, "Cancel");
      try {
        await prepareFirstRunResources();
        return true;
      } catch (error) {
        setBootOverlayCancelAction(null);
        setBootOverlayError(true);
        setBootOverlayText({ detail: "" });
        setBootOverlayProgress({ progress: 100, status: friendlySetupError(error) });
        if ((await waitForBootOverlayChoice()) === "continue") {
          return false;
        }
      }
    }
  } finally {
    setBootOverlayCancelAction(null);
    setBootOverlayError(false);
    dispose?.();
  }
}

function friendlySetupError(error: unknown): string {
  const message = normalizeError(error);
  // The backend writes setup errors for people; drop the technical details.
  const details = message.indexOf(" Details:");
  return details > 0 ? message.slice(0, details) : message;
}

export function useBootstrap(): void {
  const { setBooting, setNotice } = useAppStore();
  const { setModels, setRuntime } = useModelStore();
  const { setCharacters, setActiveCharacterId } = useCharacterStore();
  const {
    activeChatId,
    setChats,
    setActiveChatId,
    setMessagesByChat,
    setParticipantsByChat,
    setEditingMessageId,
    setEditingMessageDraft,
  } = useChatStore();
  const { setActiveContextHits, setActiveMemoryHits } = useContextStore();
  const { setGenerationPresets } = usePresetStore();
  const { hydrateUserProfile } = useProfileStore();
  const { hydrateFromLaunchSettings } = useRuntimeSettingsStore();

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      setBooting(true);
      setBootOverlayProgress({ progress: 4, status: "Starting Glee..." });
      await waitForBootOverlayPaint();
      try {
        const aiReady = await ensureAiResources();
        setBootOverlayProgress({
          progress: 92,
          status: "Opening your workspace...",
        });
        await waitForBootOverlayPaint();
        const snapshotPromise = bootstrapState();
        const generationPresetsPromise = listGenerationPresets();
        const runtimeLaunchSettingsPromise = getRuntimeLaunchSettings().catch(() => null);

        const snapshot = await snapshotPromise;
        const generationList = await generationPresetsPromise;
        const runtimeLaunchSettings = await runtimeLaunchSettingsPromise;
        if (cancelled) {
          return;
        }
        const sortedChats = sortChatsByRecent(snapshot.chats);
        setModels(snapshot.models);
        setRuntime(snapshot.runtime);
        setCharacters(snapshot.characters);
        setChats(sortedChats);
        setGenerationPresets(sortByRecent(generationList));
        hydrateUserProfile(snapshot.userProfile);
        if (runtimeLaunchSettings) {
          hydrateFromLaunchSettings(runtimeLaunchSettings);
        }
        if (!aiReady) {
          setNotice({
            kind: "error",
            message:
              "Glee's AI isn't installed yet, so characters can't reply. Restart Glee when you're online to finish setup.",
          });
        }
        setActiveCharacterId(snapshot.characters[0]?.id ?? null);
        setActiveChatId(null);
        setBootOverlayProgress({
          progress: 100,
          status: "Finishing startup...",
        });
        await waitForBootOverlayPaint();
      } catch (error) {
        if (!cancelled) {
          setBootOverlayProgress({
            progress: 100,
            status: "Startup hit an error. Opening recovery view...",
          });
          await waitForBootOverlayPaint();
          setNotice({ kind: "error", message: normalizeError(error) });
        }
      } finally {
        if (!cancelled) {
          setBooting(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
      setBootOverlayCancelAction(null);
    };
  }, [
    setActiveCharacterId,
    setActiveChatId,
    setBooting,
    setCharacters,
    setChats,
    setGenerationPresets,
    hydrateUserProfile,
    hydrateFromLaunchSettings,
    setModels,
    setNotice,
    setRuntime,
  ]);

  useEffect(() => {
    if (!activeChatId) {
      return;
    }
    let cancelled = false;

    async function hydrate(chatId: string): Promise<void> {
      try {
        const [messages, participants] = await Promise.all([
          getChatMessages(chatId),
          listChatParticipants(chatId),
        ]);
        if (cancelled) {
          return;
        }
        setMessagesByChat((prev) => ({ ...prev, [chatId]: messages }));
        setParticipantsByChat((prev) => ({ ...prev, [chatId]: dedupeIds(participants) }));
      } catch (error) {
        if (!cancelled) {
          setNotice({ kind: "error", message: normalizeError(error) });
        }
      }
    }

    void hydrate(activeChatId);
    return () => {
      cancelled = true;
    };
  }, [activeChatId, setMessagesByChat, setNotice, setParticipantsByChat]);

  useEffect(() => {
    setEditingMessageId(null);
    setEditingMessageDraft("");
    setActiveContextHits([]);
    setActiveMemoryHits([]);
  }, [
    activeChatId,
    setActiveContextHits,
    setActiveMemoryHits,
    setEditingMessageDraft,
    setEditingMessageId,
  ]);
}
