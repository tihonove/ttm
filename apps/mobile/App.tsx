import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
    ActivityIndicator,
    AppState,
    Platform,
    Pressable,
    RefreshControl,
    SectionList,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { ApiError, fetchTodos } from "./src/api.ts";
import { useAppUpdate } from "./src/appUpdate.ts";
import { buildSections, countOpen, parsePairing, type Filter, type Row, type TodosResponse } from "./src/model.ts";
import { clearSettings, DEFAULT_SERVER, loadSettings, saveSettings, type Settings } from "./src/settings.ts";

const light = { bg: "#ffffff", surface: "#f4f4f6", text: "#16161a", muted: "#7a7a85", accent: "#3b6fe0", line: "#e4e4e8", danger: "#c4362f" };
const dark = { bg: "#121214", surface: "#1d1d21", text: "#ececf0", muted: "#8b8b96", accent: "#7aa2ff", line: "#2a2a30", danger: "#ff7a70" };
type Palette = typeof light;

function usePalette(): Palette {
    return useColorScheme() === "dark" ? dark : light;
}

export default function App() {
    const palette = usePalette();
    const [settings, setSettings] = useState<Settings | null | undefined>(undefined);

    useEffect(() => {
        void loadSettings().then(setSettings);
    }, []);

    return (
        <SafeAreaProvider>
            <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
                <StatusBar style={palette === dark ? "light" : "dark"} />
                {settings === undefined ? (
                    <ActivityIndicator style={{ flex: 1 }} color={palette.accent} />
                ) : settings === null ? (
                    <SetupScreen
                        palette={palette}
                        onDone={async next => {
                            await saveSettings(next);
                            setSettings(next);
                        }}
                    />
                ) : (
                    <TodoScreen
                        palette={palette}
                        settings={settings}
                        onSignOut={async () => {
                            await clearSettings();
                            setSettings(null);
                        }}
                    />
                )}
            </SafeAreaView>
        </SafeAreaProvider>
    );
}

function SetupScreen({ palette, onDone }: { palette: Palette; onDone: (settings: Settings) => void }) {
    const [server, setServer] = useState(DEFAULT_SERVER);
    const [token, setToken] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [checking, setChecking] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [permission, requestPermission] = useCameraPermissions();
    // The camera keeps reporting the same code until it closes; take it once.
    const scanned = useRef(false);

    const connect = async (next: Settings) => {
        setChecking(true);
        setError(null);
        try {
            await fetchTodos(next);
            onDone(next);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setChecking(false);
        }
    };

    const startScan = async () => {
        const granted = permission?.granted || (await requestPermission()).granted;
        scanned.current = false;
        if (granted) setScanning(true);
        else setError("Нет доступа к камере");
    };

    if (scanning) {
        return (
            <View style={{ flex: 1 }}>
                <CameraView
                    style={{ flex: 1 }}
                    barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                    onBarcodeScanned={({ data }) => {
                        const pairing = parsePairing(data);
                        if (!pairing || scanned.current) return;
                        scanned.current = true;
                        setScanning(false);
                        setServer(pairing.server);
                        setToken(pairing.token);
                        void connect(pairing);
                    }}
                />
                <Text style={[styles.scanHint, { color: "#fff" }]}>Наведите на QR-код из `ttm-sync pair`</Text>
                <Pressable style={[styles.button, { backgroundColor: palette.surface, margin: 24 }]} onPress={() => setScanning(false)}>
                    <Text style={[styles.buttonText, { color: palette.text }]}>Отмена</Text>
                </Pressable>
            </View>
        );
    }

    const input = [styles.input, { color: palette.text, backgroundColor: palette.surface, borderColor: palette.line }];
    return (
        <View style={styles.setup}>
            <Text style={[styles.title, { color: palette.text }]}>ttm</Text>
            <Text style={{ color: palette.muted, marginBottom: 24 }}>Подключение к серверу заметок</Text>
            {Platform.OS !== "web" && (
                <>
                    <Pressable style={[styles.button, { backgroundColor: palette.accent, marginTop: 0 }]} onPress={() => void startScan()}>
                        <Text style={styles.buttonText}>Сканировать QR-код</Text>
                    </Pressable>
                    <Text style={{ color: palette.muted, marginTop: 8, marginBottom: 8 }}>на компьютере: ttm-sync pair · или вручную:</Text>
                </>
            )}
            <Text style={[styles.label, { color: palette.muted }]}>Сервер</Text>
            <TextInput style={input} value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
            <Text style={[styles.label, { color: palette.muted }]}>Токен</Text>
            <TextInput
                style={input}
                value={token}
                onChangeText={setToken}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                placeholder="из ~/.config/ttm/token"
                placeholderTextColor={palette.muted}
            />
            {error && <Text style={{ color: palette.danger, marginTop: 12 }}>{error}</Text>}
            <Pressable
                style={[styles.button, { backgroundColor: palette.accent, opacity: checking || !token ? 0.5 : 1 }]}
                disabled={checking || !token}
                onPress={() => void connect({ server: server.trim(), token: token.trim() })}
            >
                <Text style={styles.buttonText}>{checking ? "Проверяю…" : "Подключиться"}</Text>
            </Pressable>
        </View>
    );
}

function TodoScreen({ palette, settings, onSignOut }: { palette: Palette; settings: Settings; onSignOut: () => void }) {
    const [todos, setTodos] = useState<TodosResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [filter, setFilter] = useState<Filter>("open");
    const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
    const appUpdate = useAppUpdate();

    const load = useCallback(async () => {
        setRefreshing(true);
        try {
            setTodos(await fetchTodos(settings));
            setUpdatedAt(new Date());
            setError(null);
        } catch (e) {
            setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
        } finally {
            setRefreshing(false);
        }
    }, [settings]);

    useEffect(() => {
        void load();
        // Coming back to the app is when fresh data matters most.
        const subscription = AppState.addEventListener("change", state => {
            if (state !== "active") return;
            void load();
            void appUpdate.check();
        });
        return () => subscription.remove();
    }, [load, appUpdate.check]);

    const sections = useMemo(() => (todos ? buildSections(todos, filter) : []), [todos, filter]);
    const open = countOpen(sections);

    return (
        <View style={{ flex: 1 }}>
            <View style={[styles.header, { borderColor: palette.line }]}>
                <View style={{ flex: 1 }}>
                    <Text style={[styles.title, { color: palette.text }]}>Задачи</Text>
                    <Text style={{ color: palette.muted }}>
                        {todos ? `${open} открытых` : " "}
                        {updatedAt ? ` · ${updatedAt.toLocaleTimeString().slice(0, 5)}` : ""}
                    </Text>
                </View>
                <Segmented palette={palette} value={filter} onChange={setFilter} />
            </View>
            {appUpdate.pending && (
                <Pressable onPress={() => void appUpdate.apply()} style={[styles.banner, { backgroundColor: palette.surface }]}>
                    <Text style={{ color: palette.accent }}>Новая версия приложения скачана · перезапустить</Text>
                </Pressable>
            )}
            {error && (
                <Pressable onPress={() => void load()} style={[styles.banner, { backgroundColor: palette.surface }]}>
                    <Text style={{ color: palette.danger }}>{error} · повторить</Text>
                </Pressable>
            )}
            <SectionList
                sections={sections}
                keyExtractor={row => row.key}
                stickySectionHeadersEnabled
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} tintColor={palette.accent} />}
                renderSectionHeader={({ section }) => (
                    <View style={[styles.sectionHeader, { backgroundColor: palette.bg, borderColor: palette.line }]}>
                        <Text style={[styles.sectionFile, { color: palette.accent }]}>{section.file}</Text>
                        {section.title ? <Text style={[styles.sectionTitle, { color: palette.text }]}>{section.title}</Text> : null}
                        <Text style={{ color: palette.muted, marginLeft: "auto" }}>{section.open || ""}</Text>
                    </View>
                )}
                renderItem={({ item }) => <TodoRow row={item} palette={palette} />}
                ListEmptyComponent={
                    todos ? <Text style={[styles.empty, { color: palette.muted }]}>Открытых задач нет</Text> : <ActivityIndicator style={{ marginTop: 48 }} color={palette.accent} />
                }
                ListFooterComponent={
                    <Pressable onPress={onSignOut} style={styles.footer}>
                        <Text style={{ color: palette.muted }}>
                            {settings.server.replace(/^https?:\/\//, "")}
                            {todos?.head ? ` @ ${todos.head.slice(0, 7)}` : ""} · отключиться
                        </Text>
                        <Text style={{ color: palette.muted, marginTop: 4, fontSize: 12 }}>{appUpdate.label}</Text>
                    </Pressable>
                }
            />
        </View>
    );
}

const GLYPH: Record<string, string> = { open: "○", done: "✓", cancelled: "✕", question: "?" };

function TodoRow({ row, palette }: { row: Row; palette: Palette }) {
    if (row.kind === "text") {
        return <Text style={[styles.textRow, { color: palette.muted }]}>{row.text}</Text>;
    }
    const closed = row.status === "done" || row.status === "cancelled";
    return (
        <View style={[styles.row, { paddingLeft: 16 + row.depth * 20 }]}>
            <Text style={[styles.glyph, { color: closed ? palette.muted : palette.accent }]}>{GLYPH[row.status]}</Text>
            <Text style={[styles.rowText, { color: closed ? palette.muted : palette.text }, closed && styles.struck]}>{row.text}</Text>
        </View>
    );
}

function Segmented({ palette, value, onChange }: { palette: Palette; value: Filter; onChange: (value: Filter) => void }) {
    const options: [Filter, string][] = [
        ["open", "Открытые"],
        ["all", "Все"],
    ];
    return (
        <View style={[styles.segmented, { backgroundColor: palette.surface }]}>
            {options.map(([key, label]) => (
                <Pressable key={key} onPress={() => onChange(key)} style={[styles.segment, value === key && { backgroundColor: palette.bg }]}>
                    <Text style={{ color: value === key ? palette.text : palette.muted, fontWeight: value === key ? "600" : "400" }}>{label}</Text>
                </Pressable>
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    setup: { flex: 1, padding: 24, justifyContent: "center" },
    title: { fontSize: 28, fontWeight: "700" },
    label: { fontSize: 13, marginTop: 16, marginBottom: 6 },
    input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
    button: { marginTop: 24, borderRadius: 10, paddingVertical: 14, alignItems: "center" },
    buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
    header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
    banner: { paddingHorizontal: 16, paddingVertical: 10 },
    sectionHeader: { flexDirection: "row", alignItems: "baseline", gap: 8, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth },
    sectionFile: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
    sectionTitle: { fontSize: 15, fontWeight: "600" },
    row: { flexDirection: "row", paddingRight: 16, paddingVertical: 9 },
    glyph: { width: 22, fontSize: 15 },
    rowText: { flex: 1, fontSize: 16, lineHeight: 22 },
    struck: { textDecorationLine: "line-through" },
    textRow: { paddingHorizontal: 16, paddingVertical: 8, fontStyle: "italic", fontSize: 15 },
    empty: { textAlign: "center", marginTop: 48 },
    scanHint: { position: "absolute", top: 48, left: 24, right: 24, textAlign: "center", fontSize: 16, textShadowColor: "#000", textShadowRadius: 4 },
    footer: { padding: 24, alignItems: "center" },
    segmented: { flexDirection: "row", borderRadius: 9, padding: 2 },
    segment: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 7 },
});
