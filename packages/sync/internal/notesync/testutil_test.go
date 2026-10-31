package notesync

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/tihonove/ttm/packages/sync/internal/git"
)

// TestMain lets the test binary serve as the merge driver git calls back into, like the real one.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "merge-driver" {
		if err := MergeDriverCommand(os.Args[2:]); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(runWithoutDesktop(m))
}

// runWithoutDesktop shadows notify-send: a failing test daemon must not pop up on the real desktop.
func runWithoutDesktop(m *testing.M) int {
	dir, err := os.MkdirTemp("", "ttm-test-bin-")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)
	if err := os.WriteFile(filepath.Join(dir, "notify-send"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		panic(err)
	}
	os.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return m.Run()
}

func driverCommand(t *testing.T) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return `"` + self + `" merge-driver`
}

func mustGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := git.Run(dir, args)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

type world struct {
	root, remote string
	machines     map[string]*Target
}

func makeWorld(t *testing.T, hosts ...string) *world {
	t.Helper()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	mustGit(t, root, "init", "-q", "--bare", "-b", "main", remote)
	w := &world{root: root, remote: remote, machines: map[string]*Target{}}
	for _, host := range hosts {
		dir := filepath.Join(root, host)
		if err := os.Mkdir(dir, 0o777); err != nil {
			t.Fatal(err)
		}
		target := &Target{Dir: dir, Host: host, DriverCommand: driverCommand(t)}
		if err := PrepareRepo(target); err != nil {
			t.Fatal(err)
		}
		if err := SetRemote(dir, remote); err != nil {
			t.Fatal(err)
		}
		w.machines[host] = target
	}
	return w
}

func write(t *testing.T, target *Target, file, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(target.Dir, file), []byte(content), 0o666); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, target *Target, file string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(target.Dir, file))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func syncOK(t *testing.T, target *Target) Result {
	t.Helper()
	result, err := SyncOnce(target)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
