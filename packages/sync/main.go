// ttm-sync keeps a notes directory in sync between machines through the ttm server.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/tihonove/ttm/packages/sync/internal/notesync"
	"github.com/tihonove/ttm/packages/sync/internal/qrterm"
)

// version is set at build time (scripts/build-bin.ts).
var version = "dev"

const (
	unitName = "ttm-sync.service"
	// binaryCheck is how often the running daemon checks whether its binary was replaced by an update.
	binaryCheck = 30 * time.Second
)

func configDir() (string, error) {
	if dir := os.Getenv("XDG_CONFIG_HOME"); dir != "" {
		return filepath.Join(dir, "ttm"), nil
	}
	home, err := os.UserHomeDir()
	return filepath.Join(home, ".config", "ttm"), err
}

func shellJoin(args ...string) string {
	quoted := make([]string, len(args))
	for i, arg := range args {
		var out bytes.Buffer
		encoder := json.NewEncoder(&out)
		encoder.SetEscapeHTML(false)
		// A string always encodes.
		_ = encoder.Encode(arg)
		quoted[i] = strings.TrimSpace(out.String())
	}
	return strings.Join(quoted, " ")
}

func driverCommand() (string, error) {
	self, err := os.Executable()
	return shellJoin(self, "merge-driver"), err
}

func loadConfig() (notesync.DaemonConfig, error) {
	var config notesync.DaemonConfig
	dir, err := configDir()
	if err != nil {
		return config, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "sync.json"))
	if err != nil {
		return config, err
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return config, err
	}
	token := os.Getenv("TTM_TOKEN")
	if token == "" {
		data, err := os.ReadFile(filepath.Join(dir, "token"))
		if err != nil {
			return config, err
		}
		token = string(data)
	}
	config.Token = strings.TrimSpace(token)
	return config, nil
}

func prepare(config notesync.DaemonConfig) (*notesync.Target, error) {
	command, err := driverCommand()
	if err != nil {
		return nil, err
	}
	target := &notesync.Target{
		Dir: config.Dir, Host: config.Host, DriverCommand: command,
		NetworkEnv: notesync.AuthEnv(config.Token),
		Log:        func(message string) { fmt.Fprintln(os.Stderr, message) },
	}
	return target, notesync.PrepareRepo(target)
}

func initCommand(args []string) error {
	hostname, _ := os.Hostname()
	flags := flag.NewFlagSet("init", flag.ContinueOnError)
	dir := flags.String("dir", "", "notes directory")
	server := flags.String("server", "", "server URL")
	host := flags.String("host", hostname, "machine name")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *dir == "" || *server == "" {
		return fmt.Errorf("usage: ttm-sync init --dir <notes dir> --server <url> [--host <name>]")
	}
	abs, err := filepath.Abs(*dir)
	if err != nil {
		return err
	}
	config := notesync.DaemonConfig{Dir: abs, Server: *server, Host: *host}
	base, err := configDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(base, 0o777); err != nil {
		return err
	}
	data, err := json.MarshalIndent(config, "", "    ")
	if err != nil {
		return err
	}
	configFile := filepath.Join(base, "sync.json")
	if err := os.WriteFile(configFile, append(data, '\n'), 0o666); err != nil {
		return err
	}
	if _, err := prepare(config); err != nil {
		return err
	}
	if err := notesync.SetRemote(config.Dir, notesync.RemoteURL(config.Server)); err != nil {
		return err
	}
	fmt.Println("configured " + configFile)
	tokenFile := filepath.Join(base, "token")
	if _, err := os.Stat(tokenFile); err != nil {
		fmt.Printf("put the server token into %s (chmod 600)\n", tokenFile)
	}
	fmt.Println("next: ttm-sync once && ttm-sync install")
	return nil
}

func onceCommand([]string) error {
	config, err := loadConfig()
	if err != nil {
		return err
	}
	// Re-applied on every run so the merge driver always points at the current binary.
	target, err := prepare(config)
	if err != nil {
		return err
	}
	result, err := notesync.SyncOnce(target)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

// binaryID changes when an update replaces the file; "" while it cannot be read.
func binaryID(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	inode := uint64(0)
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		inode = stat.Ino
	}
	return fmt.Sprintf("%d/%d", inode, info.ModTime().UnixNano())
}

func runCommand([]string) error {
	config, err := loadConfig()
	if err != nil {
		return err
	}
	target, err := prepare(config)
	if err != nil {
		return err
	}
	stop, err := notesync.RunDaemon(config, target.Log, target.DriverCommand)
	if err != nil {
		return err
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	self, err := os.Executable()
	if err != nil {
		return err
	}
	started := binaryID(self)
	ticker := time.NewTicker(binaryCheck)
	defer ticker.Stop()
	for {
		select {
		case received := <-signals:
			fmt.Fprintf(os.Stderr, "%s, stopping\n", received)
			stop()
			return nil
		case <-ticker.C:
			// An apt upgrade replaces the binary; exit between syncs and let systemd start the new one.
			if current := binaryID(self); current != "" && current != started {
				fmt.Fprintln(os.Stderr, "binary updated, restarting")
				stop()
				return nil
			}
		}
	}
}

func installCommand([]string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	unit := strings.Join([]string{
		"[Unit]",
		"Description=ttm notes sync (git)",
		"After=network-online.target",
		"",
		"[Service]",
		"ExecStart=" + shellJoin(self, "run"),
		"Restart=always",
		"RestartSec=5",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	}, "\n")
	unitDir := filepath.Join(home, ".config", "systemd", "user")
	if err := os.MkdirAll(unitDir, 0o777); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(unitDir, unitName), []byte(unit), 0o666); err != nil {
		return err
	}
	for _, args := range [][]string{{"--user", "daemon-reload"}, {"--user", "enable", unitName}, {"--user", "restart", unitName}} {
		cmd := exec.Command("systemctl", args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			return err
		}
	}
	fmt.Printf("installed and started %s; logs: journalctl --user -u %s -f\n", unitName, unitName)
	return nil
}

// pairCommand shows a QR code the mobile app scans to connect: server and token, nothing else.
func pairCommand([]string) error {
	config, err := loadConfig()
	if err != nil {
		return err
	}
	picture, err := qrterm.Render(notesync.PairURL(config.Server, config.Token))
	if err != nil {
		return err
	}
	fmt.Print(picture)
	fmt.Println("Scan it in the ttm app: Сканировать QR-код. The code holds the server token — don't share it.")
	return nil
}

func versionCommand([]string) error {
	fmt.Println(version)
	return nil
}

func main() {
	commands := map[string]func([]string) error{
		"init":         initCommand,
		"once":         onceCommand,
		"run":          runCommand,
		"install":      installCommand,
		"pair":         pairCommand,
		"merge-driver": notesync.MergeDriverCommand,
		"--version":    versionCommand,
	}
	var handler func([]string) error
	if len(os.Args) > 1 {
		handler = commands[os.Args[1]]
	}
	if handler == nil {
		fmt.Fprintln(os.Stderr, "usage: ttm-sync <init|once|run|install|pair|merge-driver|--version>")
		os.Exit(2)
	}
	if err := handler(os.Args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
