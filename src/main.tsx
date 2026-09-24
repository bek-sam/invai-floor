import { registerSW } from "virtual:pwa-register";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootstrap, engine } from "./app/actions";
import { setupI18n } from "./i18n";
import { unlockAudioOnGesture } from "./lib/feedback";
import "./styles.css";

registerSW({ immediate: true });
unlockAudioOnGesture();

async function main() {
  await setupI18n();
  await bootstrap();
  engine.start();
  const root = document.getElementById("root");
  if (root) {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }
}

void main();
