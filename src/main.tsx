import { initI18n } from "@invai/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startOutboxSync } from "./outbox/sync";
import "./styles.css";

void initI18n((localStorage.getItem("lang") as "en" | "es" | null) ?? "en");
startOutboxSync();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
