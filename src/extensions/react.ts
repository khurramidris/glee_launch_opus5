// React-facing helpers. Kept apart from the core so the registry stays usable
// (and testable) without React.
import {
  Component,
  createContext,
  createElement,
  lazy,
  Suspense,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ComponentType,
  type ErrorInfo,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ExtensionRegistry } from "./registry";
import type {
  CommandView,
  ExtensionInfo,
  MessageActionView,
  RegistrySnapshot,
} from "./registry-types";
import type { ChatView, MessageView } from "./types";

const RegistryContext = createContext<ExtensionRegistry | null>(null);

export interface ExtensionProviderProps {
  registry: ExtensionRegistry;
  children?: ReactNode;
}

export function ExtensionProvider(props: ExtensionProviderProps): ReactElement {
  return createElement(RegistryContext.Provider, { value: props.registry }, props.children);
}

export function useExtensionRegistry(): ExtensionRegistry {
  const registry = useContext(RegistryContext);
  if (!registry) {
    throw new Error("useExtensionRegistry must be used inside <ExtensionProvider>.");
  }
  return registry;
}

export function useRegistrySnapshot(): RegistrySnapshot {
  const registry = useExtensionRegistry();
  return useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.getSnapshot(),
    () => registry.getSnapshot(),
  );
}

export function useExtensions(): readonly ExtensionInfo[] {
  return useRegistrySnapshot().extensions;
}

export function useRegisteredCommands(): readonly CommandView[] {
  return useRegistrySnapshot().commands;
}

export function useMessageActions(message: MessageView, chat: ChatView): MessageActionView[] {
  const registry = useExtensionRegistry();
  const snapshot = useRegistrySnapshot();
  // `when` callbacks run in the memo; the snapshot changes whenever the set of
  // contributions does, so the list stays fresh without re-running per render.
  return useMemo(
    () => registry.listMessageActions(message, chat),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registry, snapshot, message, chat],
  );
}

interface BoundaryProps {
  registry: ExtensionRegistry;
  extensionId: string;
  children?: ReactNode;
}

/** Contains a crashing extension component so it cannot take the app down. */
export class ExtensionBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    queueMicrotask(() => this.props.registry.reportFailure(this.props.extensionId, error));
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export interface SettingsSectionNode {
  id: string;
  extensionId: string;
  title: string;
  node: ReactNode;
}

export interface ComposerToolNode {
  id: string;
  extensionId: string;
  node: ReactNode;
}

function boundary(registry: ExtensionRegistry, extensionId: string, child: ReactNode): ReactNode {
  return createElement(
    ExtensionBoundary,
    { registry, extensionId },
    createElement(Suspense, { fallback: null }, child),
  );
}

export function useSettingsSections(): SettingsSectionNode[] {
  const registry = useExtensionRegistry();
  const { settingsSections } = useRegistrySnapshot();
  return useMemo(
    () =>
      settingsSections.map((section) => ({
        id: section.id,
        extensionId: section.extensionId,
        title: section.title,
        node: boundary(registry, section.extensionId, section.render()),
      })),
    [registry, settingsSections],
  );
}

export function useComposerTools(): ComposerToolNode[] {
  const registry = useExtensionRegistry();
  const { composerTools } = useRegistrySnapshot();
  return useMemo(
    () =>
      composerTools.map((tool) => ({
        id: tool.id,
        extensionId: tool.extensionId,
        node: boundary(registry, tool.extensionId, tool.render()),
      })),
    [registry, composerTools],
  );
}

/** Lets an extension ship a heavy component without loading it up front. */
export function lazyRender<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  props: P,
): () => ReactNode {
  const Lazy = lazy(load);
  return () => createElement(Lazy as ComponentType<P>, props);
}
