import { useUpdateStore } from "../../stores/update-store";
import "./updates.css";

function formatChecked(timestamp: number | null): string {
  if (timestamp === null) return "Not checked yet";
  return new Date(timestamp).toLocaleString();
}

/** Settings section for update preferences. Wrap it in the settings grid like the other sections. */
export function UpdateSettingsSection() {
  const status = useUpdateStore((state) => state.status);
  const info = useUpdateStore((state) => state.info);
  const settings = useUpdateStore((state) => state.settings);
  const lastCheckedAt = useUpdateStore((state) => state.lastCheckedAt);
  const error = useUpdateStore((state) => state.error);
  const { check, setAutoCheck } = useUpdateStore.getState();

  const enabled = settings?.updatesEnabled ?? true;
  const currentVersion = settings?.currentVersion ?? info?.currentVersion ?? "";
  const checking = status === "checking";
  let result = "";
  if (status === "error" && error) result = error;
  else if (info?.available) result = `Glee ${info.latestVersion} is available.`;
  else if (lastCheckedAt !== null && status === "idle") result = "You have the latest version.";

  return (
    <section className="detail-section settings-section update-settings-section">
      <h4>Updates</h4>
      <p className="settings-note">
        {currentVersion ? `Glee ${currentVersion}` : "Glee"} · Last checked: {formatChecked(lastCheckedAt)}
      </p>
      <div className="settings-inline-row">
        <button type="button" className="ghost" disabled={checking || !enabled} onClick={() => void check(true)}>
          {checking ? "Checking..." : "Check for updates"}
        </button>
        {result ? (
          <span className="update-settings-result" role={status === "error" ? "alert" : "status"}>
            {result}
          </span>
        ) : null}
      </div>
      {!enabled ? <p className="settings-note">Update checks are not available in this build.</p> : null}
      <label className="update-settings-toggle">
        <input
          type="checkbox"
          checked={settings?.autoCheck ?? true}
          disabled={!settings}
          onChange={(event) => void setAutoCheck(event.target.checked)}
        />
        <span>Check for updates automatically</span>
      </label>
      <p className="settings-note">Glee checks GitHub for new versions. Nothing about you or your chats is sent.</p>
    </section>
  );
}
