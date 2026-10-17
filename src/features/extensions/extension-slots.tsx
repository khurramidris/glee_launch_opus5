import { Fragment } from "react";
import {
  PERMISSION_INFO,
  type ChatView,
  type MessageView,
} from "../../extensions";
import {
  useComposerTools,
  useExtensionRegistry,
  useExtensions,
  useMessageActions,
  useSettingsSections,
} from "../../extensions/react";

/** Buttons that extensions add to a message's toolbar. */
export function MessageExtensionActions({
  message,
  chat,
}: {
  message: MessageView;
  chat: ChatView;
}) {
  const actions = useMessageActions(message, chat);
  return (
    <>
      {actions.map((action) => (
        <button key={action.id} type="button" className="ghost" onClick={() => void action.run()}>
          {action.label}
        </button>
      ))}
    </>
  );
}

/** Small controls that extensions add above the message field. */
export function ComposerExtensionTools() {
  const tools = useComposerTools();
  return (
    <>
      {tools.map((tool) => (
        <Fragment key={tool.id}>{tool.node}</Fragment>
      ))}
    </>
  );
}

/** Settings sections contributed by extensions, plus the on/off list. */
export function ExtensionSettings() {
  const sections = useSettingsSections();
  const extensions = useExtensions();
  const registry = useExtensionRegistry();
  const wording = new Map(PERMISSION_INFO.map((info) => [info.permission, info.description]));

  return (
    <>
      {sections.map((section) => (
        <section key={section.id} className="detail-section settings-section">
          <h4>{section.title}</h4>
          {section.node}
        </section>
      ))}
      <section className="detail-section settings-section">
        <h4>Extensions</h4>
        <p className="settings-note">
          Features that plug into Glee. Turn one off here if you do not want it.
        </p>
        <div className="preset-list">
          {extensions.map((extension) => {
            const enabled = extension.status === "active";
            return (
              <div key={extension.id} className={`preset-row${enabled ? " active" : ""}`}>
                <div className="preset-main">
                  <strong>
                    {extension.name} <small>v{extension.version}</small>
                  </strong>
                  <small>{extension.description}</small>
                  {extension.statusReason && <small>{extension.statusReason}</small>}
                  {extension.permissions.length > 0 && (
                    <small>
                      Can: {extension.permissions.map((p) => wording.get(p) ?? p).join(" ")}
                    </small>
                  )}
                </div>
                <div className="preset-row-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      void (enabled ? registry.disable(extension.id) : registry.enable(extension.id))
                    }
                  >
                    {enabled ? "Turn off" : "Turn on"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
