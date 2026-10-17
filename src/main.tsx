import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/app-error-boundary";
import { ExtensionProvider } from "./extensions/react";
import { extensionRegistry } from "./extensions-runtime";
import { initializeTheme } from "./features/theme/theme-domain";

initializeTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <ExtensionProvider registry={extensionRegistry}>
        <App />
      </ExtensionProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
