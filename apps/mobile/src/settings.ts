import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

export interface Settings {
    server: string;
    token: string;
}

export const DEFAULT_SERVER = "https://ttm.tihonove.dev";
const KEY = "ttm.settings";

// The web build (used to check screens in a browser) has no keystore; localStorage stands in.
const storage = Platform.OS === "web"
    ? {
          get: async () => globalThis.localStorage?.getItem(KEY) ?? null,
          set: async (value: string) => globalThis.localStorage?.setItem(KEY, value),
          clear: async () => globalThis.localStorage?.removeItem(KEY),
      }
    : {
          get: () => SecureStore.getItemAsync(KEY),
          set: (value: string) => SecureStore.setItemAsync(KEY, value),
          clear: () => SecureStore.deleteItemAsync(KEY),
      };

export async function loadSettings(): Promise<Settings | null> {
    const raw = await storage.get();
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<Settings>;
        return parsed.server && parsed.token ? { server: parsed.server, token: parsed.token } : null;
    } catch {
        return null;
    }
}

export async function saveSettings(settings: Settings): Promise<void> {
    await storage.set(JSON.stringify(settings));
}

export async function clearSettings(): Promise<void> {
    await storage.clear();
}
