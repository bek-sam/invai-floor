import { registerSW } from "virtual:pwa-register";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootstrap, engine } from "./app/actions";
import { reloadIfAsked, setUpdateReady } from "./components/UpdatePrompt";
import { setupI18n } from "./i18n";
import { unlockAudioOnGesture } from "./lib/feedback";
import "./styles.css";

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh: () => setUpdateReady(() => void updateSW(true)),
  onNeedReload: reloadIfAsked,
});
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
