import { useCallback } from "react";
import { Platform } from "react-native";
import * as Updates from "expo-updates";

export interface AppUpdate {
    /** A downloaded update waits for a restart. */
    pending: boolean;
    /** Checks the server and downloads a newer update if there is one. */
    check: () => Promise<void>;
    apply: () => Promise<void>;
    /** Which JS the app runs right now, for the footer. */
    label: string;
}

// Updates exist only in release builds on a device: not on the web or in development.
const supported = Platform.OS !== "web" && Updates.isEnabled && !__DEV__;

function runningLabel(): string {
    if (!supported) return "dev";
    if (Updates.isEmbeddedLaunch || !Updates.createdAt) return "встроенная версия";
    return `версия ${Updates.createdAt.toISOString().slice(0, 16).replace("T", " ")}`;
}

export function useAppUpdate(): AppUpdate {
    // `supported` never changes while the app runs, so the hook order is stable.
    const state = supported ? Updates.useUpdates() : undefined;
    const check = useCallback(async () => {
        if (!supported) return;
        try {
            const result = await Updates.checkForUpdateAsync();
            if (result.isAvailable) await Updates.fetchUpdateAsync();
        } catch {
            // Offline or the server is restarting: the next check will try again.
        }
    }, []);
    const apply = useCallback(async () => {
        await Updates.reloadAsync();
    }, []);
    return { pending: state?.isUpdatePending ?? false, check, apply, label: runningLabel() };
}
