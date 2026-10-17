import { describe, expect, it } from "vitest";
import { __testing } from "./tauri";

describe("tauri api mapping", () => {
  it("maps chat epochs and canonical mutation results", () => {
    const chat = __testing.mapChat({
      id: "chat-1",
      title: "Epoch chat",
      chat_mode: "single",
      participant_ids: [],
      history_epoch: 4,
      created_at: "2000-01-01T00:00:00.000Z",
      updated_at: "2000-01-01T00:00:01.000Z",
    });
    expect(chat.historyEpoch).toBe(4);

    const mutation = __testing.mapHistoryMutation({
      chat_id: "chat-1",
      history_epoch: 5,
      updated_at: "2000-01-01T00:00:02.000Z",
      messages: [],
    });
    expect(mutation).toMatchObject({
      chatId: "chat-1",
      historyEpoch: 5,
      messages: [],
    });
  });

  it("normalizes character records with csv tags", () => {
    const character = __testing.mapCharacter({
      id: "char-1",
      name: "Aria",
      description: "Helpful",
      system_prompt: "Stay practical",
      greeting: null,
      avatar: null,
      tags: "friend, helper, friend",
      example_dialogue: null,
      created_at: "2000-01-01T00:00:00.000Z",
      updated_at: "2000-01-01T00:00:00.000Z",
    });
    expect(character.tags).toEqual(["friend", "helper", "friend"]);
    expect(character.systemPrompt).toBe("Stay practical");
  });

  it("maps chat memory and context entries defensively", () => {
    const memory = __testing.mapChatMemory({
      chat_id: "chat-1",
      summary: "summary",
      facts_json: '["alpha","beta","alpha"]',
      updated_at: "2000-01-01T00:00:00.000Z",
    });
    expect(memory.facts).toEqual(["alpha", "beta"]);
    expect(memory.summaryAuto).toBe(false);
    expect(memory.summarizedThroughMessageId).toBeNull();

    const automatic = __testing.mapChatMemory({
      chat_id: "chat-1",
      summary: "  written by the app ",
      summary_auto: true,
      summarized_through_message_id: "msg-9",
      updated_at: "2000-01-01T00:00:00.000Z",
    });
    expect(automatic.summary).toBe("written by the app");
    expect(automatic.summaryAuto).toBe(true);
    expect(automatic.summarizedThroughMessageId).toBe("msg-9");

    const context = __testing.mapContextEntry({
      id: "ctx-1",
      scope: "global",
      title: "World",
      keywords_json: '["rain","city","rain"]',
      content: "Rainy city",
      enabled: 1,
      created_at: "2000-01-01T00:00:00.000Z",
      updated_at: "2000-01-01T00:00:00.000Z",
    });
    expect(context.keywords).toEqual(["rain", "city"]);
    expect(context.enabled).toBe(true);
  });

  it("maps auto summary batches", () => {
    const batch = __testing.mapAutoSummaryBatch({
      chat_id: "chat-1",
      history_epoch: 2,
      writable: true,
      previous_summary: " earlier ",
      summarized_through_message_id: null,
      pending_count: 13,
      messages: [
        {
          id: "msg-1",
          chat_id: "chat-1",
          role: "user",
          content: "hello",
          speaker_character_id: null,
          created_at: "2000-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(batch).toMatchObject({
      chatId: "chat-1",
      historyEpoch: 2,
      writable: true,
      previousSummary: "earlier",
      summarizedThroughMessageId: null,
      pendingCount: 13,
    });
    expect(batch.messages[0]).toMatchObject({ id: "msg-1", role: "user" });
  });

  it("maps diagnostics snapshots into camelCase frontend types", () => {
    const diagnostics = __testing.mapDiagnosticsSnapshot({
      app_version: "0.1.0",
      platform: "windows-x64",
      runtime: {
        state: "error",
        endpoint: "http://127.0.0.1:8080",
        log_file: "D:/logs/llama.log",
        error: "crashed",
        selection: {
          performance_mode: "gpu",
          backend: "cpu",
          attempted_backend: "cuda",
          binary_path: "D:/runtime/cpu/llama-server.exe",
          variant_id: "windows-x64-cpu",
          runtime_version: "b8179",
          requested_gpu_layers: 0,
          actual_gpu_layers: 0,
          fallback_reason: "GPU runtime startup failed; fell back to CPU.",
          detected_gpus: [
            {
              id: "0",
              name: "NVIDIA GeForce 920MX",
              vendor: "NVIDIA",
              driver_version: "576.57",
              total_vram_mb: 2048,
              free_vram_mb: 1024,
              supported_backends: ["cuda", "vulkan"],
            },
          ],
          backend_log_summary: "loaded backends: Cpu",
        },
      },
      startup: {
        checked_at: "2000-03-09T00:00:00.000Z",
        overall_status: "warn",
        app_data_dir: "D:/data",
        database_path: "D:/data/glee.sqlite3",
        backup_dir: "D:/data/backups",
        runtime_binary_path: "D:/runtime/llama-server.exe",
        sqlite_vec_available: false,
        embedding_available: true,
        indexing: {
          status: "degraded",
          updated_at: "2000-03-09T00:00:00.000Z",
          last_error: "sqlite-vec missing",
        },
        checks: [
          {
            key: "db",
            label: "Database",
            status: "ok",
            detail: "ready",
            required: true,
            recoverable: true,
          },
        ],
      },
      settings: [
        {
          key: "active_model_id",
          value: "model-1",
          updated_at: "2000-03-09T00:00:00.000Z",
        },
      ],
      feature_exposure: {
        stable: ["memory"],
        labs: ["semantic vector retrieval"],
      },
      recent_errors: ["Runtime: crashed"],
    });

    expect(diagnostics.appVersion).toBe("0.1.0");
    expect(diagnostics.runtime.status).toBe("error");
    expect(diagnostics.runtime.selection?.backend).toBe("cpu");
    expect(diagnostics.runtime.selection?.attemptedBackend).toBe("cuda");
    expect(diagnostics.runtime.selection?.detectedGpus[0]?.totalVramMb).toBe(2048);
    expect(diagnostics.startup.appDataDir).toBe("D:/data");
    expect(diagnostics.settings[0]?.updatedAt).toBe("2000-03-09T00:00:00.000Z");
    expect(diagnostics.featureExposure.labs).toContain("semantic vector retrieval");
  });

  it("maps runtime launch settings with performance mode fallback", () => {
    expect(
      __testing.mapRuntimeLaunchSettings({
        warmup_enabled: true,
        performance_mode: "auto",
        gpu_layers: 0,
        updated_at: "2000-04-06T00:00:00.000Z",
      }),
    ).toEqual({
      warmupEnabled: true,
      performanceMode: "auto",
      gpuLayers: 0,
      updatedAt: "2000-04-06T00:00:00.000Z",
    });

    expect(
      __testing.mapRuntimeLaunchSettings({
        warmup_enabled: true,
        gpu_layers: "16",
        updated_at: "2000-04-06T00:00:00.000Z",
      }),
    ).toMatchObject({
      performanceMode: "gpu",
      gpuLayers: 16,
    });
  });

  it("maps export and backup responses", () => {
    const exported = __testing.mapDiagnosticsExportResponse({
      directory: "D:/diag",
      summary_path: "D:/diag/summary.json",
      runtime_log_path: "D:/diag/runtime.log",
      database_backup_path: null,
    });
    const backup = __testing.mapDatabaseBackupResponse({ path: "D:/backup.sqlite3" });
    const listedBackup = __testing.mapDatabaseBackup({
      file_name: "glee-manual-20260714.sqlite3",
      path: "D:/data/backups/glee-manual-20260714.sqlite3",
      reason: "manual",
      size_bytes: 4096,
      modified_at: "2000-07-14T12:00:00.000Z",
    });
    const restored = __testing.mapDatabaseRestoreResponse({
      restored_from: "D:/data/backups/glee-manual-20260714.sqlite3",
      safety_backup_path: "D:/data/backups/glee-pre-restore-20260714.sqlite3",
    });
    expect(exported.summaryPath).toBe("D:/diag/summary.json");
    expect(exported.runtimeLogPath).toBe("D:/diag/runtime.log");
    expect(backup.path).toBe("D:/backup.sqlite3");
    expect(listedBackup).toEqual({
      fileName: "glee-manual-20260714.sqlite3",
      path: "D:/data/backups/glee-manual-20260714.sqlite3",
      reason: "manual",
      sizeBytes: 4096,
      modifiedAt: "2000-07-14T12:00:00.000Z",
    });
    expect(restored.safetyBackupPath).toBe(
      "D:/data/backups/glee-pre-restore-20260714.sqlite3",
    );
  });
});
