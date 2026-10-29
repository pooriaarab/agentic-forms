import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastProvider, TooltipProvider } from "agentic-design/react";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <TooltipProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </TooltipProvider>
  </ThemeProvider>,
);
