import { initI18n } from "@invai/ui";
import i18n from "i18next";
import { en } from "./en";
import { es } from "./es";

export type Lang = "en" | "es";
const DEVICE_LANG_KEY = "invai-floor:lang";

export function deviceLang(): Lang {
  try {
    return localStorage.getItem(DEVICE_LANG_KEY) === "es" ? "es" : "en";
  } catch {
    return "en";
  }
}

/** Shared strings come from @invai/ui; floor strings live under the `floor` key. */
export async function setupI18n() {
  const lang = deviceLang();
  // <html lang> follows the device language from the start (screen readers, hyphenation).
  document.documentElement.lang = lang;
  await initI18n(lang);
  i18n.addResourceBundle("en", "translation", { floor: en }, true, true);
  i18n.addResourceBundle("es", "translation", { floor: es }, true, true);
}

export async function setLang(lang: Lang, rememberForDevice = true) {
  if (rememberForDevice) {
    try {
      localStorage.setItem(DEVICE_LANG_KEY, lang);
    } catch {
      // private mode: fine, the per-staff preference still applies
    }
  }
  document.documentElement.lang = lang;
  await i18n.changeLanguage(lang);
}

export { i18n };
