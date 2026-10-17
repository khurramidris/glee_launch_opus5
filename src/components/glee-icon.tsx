import type { CSSProperties, HTMLAttributes } from "react";
import branchIcon from "../assets/icons/branch.svg";
import createCharacterIcon from "../assets/icons/create-character.svg";
import deleteIcon from "../assets/icons/delete.svg";
import diagnosticsIcon from "../assets/icons/diagnostics.svg";
import editIcon from "../assets/icons/edit.svg";
import exportIcon from "../assets/icons/export.svg";
import groupChatIcon from "../assets/icons/group-chat.svg";
import hubIcon from "../assets/icons/hub.svg";
import importCharacterIcon from "../assets/icons/import-character.svg";
import memoryIcon from "../assets/icons/memory.svg";
import moreIcon from "../assets/icons/more.svg";
import newChatIcon from "../assets/icons/new-chat.svg";
import panelLeftIcon from "../assets/icons/panel-left.svg";
import panelRightIcon from "../assets/icons/panel-right.svg";
import profileIcon from "../assets/icons/profile.svg";
import regenerateIcon from "../assets/icons/regenerate.svg";
import searchIcon from "../assets/icons/search.svg";
import sendIcon from "../assets/icons/send.svg";
import settingsIcon from "../assets/icons/settings.svg";
import stopIcon from "../assets/icons/stop.svg";

const ICON_URLS = {
  branch: branchIcon,
  "create-character": createCharacterIcon,
  delete: deleteIcon,
  diagnostics: diagnosticsIcon,
  edit: editIcon,
  export: exportIcon,
  "group-chat": groupChatIcon,
  hub: hubIcon,
  "import-character": importCharacterIcon,
  memory: memoryIcon,
  more: moreIcon,
  "new-chat": newChatIcon,
  "panel-left": panelLeftIcon,
  "panel-right": panelRightIcon,
  profile: profileIcon,
  regenerate: regenerateIcon,
  search: searchIcon,
  send: sendIcon,
  settings: settingsIcon,
  stop: stopIcon,
} as const;

export type GleeIconName = keyof typeof ICON_URLS;

type GleeIconProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  name: GleeIconName;
  size?: number;
};

export function GleeIcon({
  name,
  size = 18,
  className = "",
  style,
  ...props
}: GleeIconProps) {
  const iconStyle = {
    ...style,
    width: size,
    height: size,
    "--glee-icon-url": `url("${ICON_URLS[name]}")`,
  } as CSSProperties;

  return (
    <span
      {...props}
      aria-hidden="true"
      className={`glee-icon${className ? ` ${className}` : ""}`}
      style={iconStyle}
    />
  );
}
