package notesync

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tihonove/ttm/packages/sync/internal/git"
)

func TestPropagatesANewFile(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	write(t, a, "Home.md", "- task\n")
	result := syncOK(t, a)
	if !result.Pushed || !result.Committed || result.Merged {
		t.Fatalf("first sync: %+v", result)
	}
	if result := syncOK(t, b); !result.Merged || result.Pushed || result.Committed {
		t.Fatalf("second machine: %+v", result)
	}
	if got := read(t, b, "Home.md"); got != "- task\n" {
		t.Fatalf("got %q", got)
	}
	if got := mustGit(t, a.Dir, "log", "-1", "--format=%s %an"); got != "sync(a): Home.md ttm-sync@a" {
		t.Fatalf("commit: %q", got)
	}
}

func TestSummarizesSeveralFilesInCommitMessage(t *testing.T) {
	w := makeWorld(t, "a")
	a := w.machines["a"]
	write(t, a, "One.md", "1\n")
	write(t, a, "Two.md", "2\n")
	syncOK(t, a)
	if got := mustGit(t, a.Dir, "log", "-1", "--format=%s"); got != "sync(a): 2 files" {
		t.Fatalf("commit: %q", got)
	}
	write(t, a, "One.md", "1!\n")
	syncOK(t, a)
	if got := mustGit(t, a.Dir, "log", "-1", "--format=%s"); got != "sync(a): One.md" {
		t.Fatalf("commit on existing head: %q", got)
	}
}

func TestNothingToDoLeavesNoCommit(t *testing.T) {
	w := makeWorld(t, "a")
	a := w.machines["a"]
	if result := syncOK(t, a); result.Committed || result.Pushed || result.Merged {
		t.Fatalf("empty repo: %+v", result)
	}
	write(t, a, "Home.md", "x\n")
	syncOK(t, a)
	head := mustGit(t, a.Dir, "rev-parse", "HEAD")
	if result := syncOK(t, a); result.Committed || result.Pushed || result.Merged {
		t.Fatalf("idle: %+v", result)
	}
	if got := mustGit(t, a.Dir, "rev-parse", "HEAD"); got != head {
		t.Fatal("an idle sync moved HEAD")
	}
}

func TestFastForwardsEvenWithGlobalMergeFFNo(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	global := filepath.Join(w.root, "global.gitconfig")
	if err := os.WriteFile(global, []byte("[merge]\n\tff = no\n"), 0o666); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", global)
	write(t, a, "Home.md", "- one\n")
	syncOK(t, a)
	syncOK(t, b)
	write(t, a, "Home.md", "- one\n- two\n")
	syncOK(t, a)
	syncOK(t, b)
	if mustGit(t, a.Dir, "rev-parse", "HEAD") != mustGit(t, b.Dir, "rev-parse", "HEAD") {
		t.Fatal("expected a fast-forward")
	}
}

func TestMergesSameLineEditsKeepingBoth(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	write(t, a, "Home.md", "NOW:\n- one\n- two\n")
	syncOK(t, a)
	syncOK(t, b)
	write(t, a, "Home.md", "NOW:\n+ one\n- two\n")
	write(t, b, "Home.md", "NOW:\n- one (edited)\n- two\n")
	syncOK(t, a)
	if result := syncOK(t, b); !result.Merged || !result.Pushed || !result.Committed || len(result.ConflictCopies) != 0 {
		t.Fatalf("merging machine: %+v", result)
	}
	syncOK(t, a)
	merged := read(t, a, "Home.md")
	if merged != read(t, b, "Home.md") {
		t.Fatal("machines diverged")
	}
	// b merged, so its version comes first.
	if want := "NOW:\n- one (edited)\n+ one\n- two\n"; merged != want {
		t.Fatalf("got %q, want %q", merged, want)
	}
	if got := mustGit(t, b.Dir, "log", "-1", "--format=%s"); got != "merge(b)" {
		t.Fatalf("merge commit: %q", got)
	}
}

func TestMergesNonOverlappingEdits(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	write(t, a, "Home.md", "NOW:\n- one\n\nNEXT:\n- two\n")
	syncOK(t, a)
	syncOK(t, b)
	write(t, a, "Home.md", "NOW:\n+ one\n\nNEXT:\n- two\n")
	write(t, b, "Home.md", "NOW:\n- one\n\nNEXT:\n- two\n- three\n")
	syncOK(t, a)
	syncOK(t, b)
	if got := read(t, b, "Home.md"); got != "NOW:\n+ one\n\nNEXT:\n- two\n- three\n" {
		t.Fatalf("got %q", got)
	}
}

func TestModifyWinsOverDelete(t *testing.T) {
	for _, deleter := range []string{"a", "b"} {
		t.Run("deleted on "+deleter, func(t *testing.T) {
			w := makeWorld(t, "a", "b")
			a, b := w.machines["a"], w.machines["b"]
			write(t, a, "Diode.md", "- x\n")
			syncOK(t, a)
			syncOK(t, b)
			editor := b
			if deleter == "b" {
				editor = a
			}
			if err := os.Remove(filepath.Join(w.machines[deleter].Dir, "Diode.md")); err != nil {
				t.Fatal(err)
			}
			write(t, editor, "Diode.md", "- x\n- y\n")
			syncOK(t, a)
			syncOK(t, b)
			syncOK(t, a)
			for _, machine := range []*Target{a, b} {
				if got := read(t, machine, "Diode.md"); got != "- x\n- y\n" {
					t.Fatalf("%s: got %q", machine.Host, got)
				}
			}
		})
	}
}

func TestBothDeletingAFileIsFine(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	write(t, a, "Gone.md", "x\n")
	write(t, a, "Keep.md", "y\n")
	syncOK(t, a)
	syncOK(t, b)
	for _, machine := range []*Target{a, b} {
		if err := os.Remove(filepath.Join(machine.Dir, "Gone.md")); err != nil {
			t.Fatal(err)
		}
		write(t, machine, "Keep.md", "y from "+machine.Host+"\n")
		syncOK(t, machine)
	}
	syncOK(t, a)
	if _, err := os.Stat(filepath.Join(a.Dir, "Gone.md")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Gone.md came back: %v", err)
	}
}

func TestNewerSideWinsForBinaryFiles(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	write(t, a, "scan.pdf", "\x00\x01\x02")
	syncOK(t, a)
	syncOK(t, b)
	write(t, a, "scan.pdf", "\x00\x01\x02\x03")
	syncOK(t, a)
	// Commit timestamps have one-second resolution.
	time.Sleep(1100 * time.Millisecond)
	write(t, b, "scan.pdf", "\x00\x09\x09")
	syncOK(t, b)
	syncOK(t, a)
	for _, machine := range []*Target{a, b} {
		if got := read(t, machine, "scan.pdf"); got != "\x00\x09\x09" {
			t.Fatalf("%s: got %q", machine.Host, got)
		}
	}
}

func TestJoinsExistingFolderToRemoteWithSameFiles(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	write(t, a, "Home.md", "- one\n")
	syncOK(t, a)
	write(t, b, "Home.md", "- one\n- local only\n")
	write(t, b, "Other.md", "text\n")
	syncOK(t, b)
	syncOK(t, a)
	if got := read(t, a, "Home.md"); got != "- one\n- local only\n" {
		t.Fatalf("got %q", got)
	}
	if got := read(t, a, "Other.md"); got != "text\n" {
		t.Fatalf("got %q", got)
	}
}

func TestRecoversFromInterruptedMerge(t *testing.T) {
	w := makeWorld(t, "a")
	a := w.machines["a"]
	write(t, a, "Home.md", "- one\n")
	syncOK(t, a)
	head := mustGit(t, a.Dir, "rev-parse", "HEAD")
	gitDir := filepath.Join(a.Dir, ".git")
	if err := os.WriteFile(filepath.Join(gitDir, "MERGE_HEAD"), []byte(head+"\n"), 0o666); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(gitDir, "index.lock")
	if err := os.WriteFile(lock, nil, 0o666); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-5 * time.Minute)
	if err := os.Chtimes(lock, old, old); err != nil {
		t.Fatal(err)
	}
	var logged []string
	a.Log = func(message string) { logged = append(logged, message) }
	write(t, a, "Home.md", "- one\n- two\n")
	if !syncOK(t, a).Pushed {
		t.Fatal("expected a push")
	}
	if exists(filepath.Join(gitDir, "MERGE_HEAD")) {
		t.Fatal("MERGE_HEAD left behind")
	}
	if got := read(t, a, "Home.md"); got != "- one\n- two\n" {
		t.Fatalf("got %q", got)
	}
	if got := mustGit(t, a.Dir, "log", "-1", "--format=%s"); got != "merge(a): finish interrupted" {
		t.Fatalf("commit: %q", got)
	}
	if !slices.Contains(logged, "finishing an interrupted merge") {
		t.Fatalf("log: %v", logged)
	}
}

func TestLeavesAFreshIndexLockAlone(t *testing.T) {
	w := makeWorld(t, "a")
	a := w.machines["a"]
	write(t, a, "Home.md", "x\n")
	syncOK(t, a)
	lock := filepath.Join(a.Dir, ".git", "index.lock")
	if err := os.WriteFile(lock, nil, 0o666); err != nil {
		t.Fatal(err)
	}
	write(t, a, "Home.md", "y\n")
	if _, err := SyncOnce(a); err == nil {
		t.Fatal("a fresh lock belongs to a running git; the sync must fail, not remove it")
	}
	if !exists(lock) {
		t.Fatal("the fresh lock was removed")
	}
}

func TestRefusesToSyncDuringARebase(t *testing.T) {
	for _, name := range []string{"rebase-merge", "rebase-apply"} {
		t.Run(name, func(t *testing.T) {
			w := makeWorld(t, "a")
			a := w.machines["a"]
			if err := os.Mkdir(filepath.Join(a.Dir, ".git", name), 0o777); err != nil {
				t.Fatal(err)
			}
			_, err := SyncOnce(a)
			if err == nil || !strings.Contains(err.Error(), "a rebase is in progress") {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestPrepareRepoIsIdempotentAndConfigures(t *testing.T) {
	w := makeWorld(t, "a")
	a := w.machines["a"]
	if err := PrepareRepo(a); err != nil {
		t.Fatal(err)
	}
	if got := mustGit(t, a.Dir, "symbolic-ref", "HEAD"); got != "refs/heads/main" {
		t.Fatalf("branch: %q", got)
	}
	for key, want := range map[string]string{
		"merge.ttm.driver": a.DriverCommand + " %O %A %B %P",
		"merge.ttm.name":   "ttm sync merge (never conflicts)",
		"user.name":        "ttm-sync@a",
		"user.email":       "ttm-sync@a",
		"core.quotePath":   "false",
		"pull.rebase":      "false",
		"merge.ff":         "true",
		"rerere.enabled":   "false",
		"commit.gpgSign":   "false",
	} {
		if got := mustGit(t, a.Dir, "config", key); got != want {
			t.Errorf("%s: got %q, want %q", key, got, want)
		}
	}
	if got := read(t, a, ".git/info/attributes"); got != Attributes {
		t.Fatalf("attributes: %q", got)
	}
	if got := read(t, a, ".git/info/exclude"); got != Exclude {
		t.Fatalf("exclude: %q", got)
	}
}

func TestPrepareRepoUsesACustomBranch(t *testing.T) {
	dir := t.TempDir()
	if err := PrepareRepo(&Target{Dir: dir, Host: "a", Branch: "notes", DriverCommand: "true"}); err != nil {
		t.Fatal(err)
	}
	if got := mustGit(t, dir, "symbolic-ref", "HEAD"); got != "refs/heads/notes" {
		t.Fatalf("branch: %q", got)
	}
}

func TestPrepareRepoFailures(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing")
	if err := PrepareRepo(&Target{Dir: missing, Host: "a"}); err == nil {
		t.Fatal("init in a missing directory must fail")
	}
	t.Run("broken config", func(t *testing.T) {
		dir := t.TempDir()
		mustGit(t, dir, "init", "-q")
		if err := os.WriteFile(filepath.Join(dir, ".git", "config"), []byte("[broken"), 0o666); err != nil {
			t.Fatal(err)
		}
		if err := PrepareRepo(&Target{Dir: dir, Host: "a"}); err == nil {
			t.Fatal("expected an error")
		}
	})
	t.Run("info is a file", func(t *testing.T) {
		dir := t.TempDir()
		mustGit(t, dir, "init", "-q")
		info := filepath.Join(dir, ".git", "info")
		if err := os.RemoveAll(info); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(info, nil, 0o666); err != nil {
			t.Fatal(err)
		}
		if err := PrepareRepo(&Target{Dir: dir, Host: "a"}); err == nil || !strings.Contains(err.Error(), "mkdir") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("attributes is a directory", func(t *testing.T) {
		dir := t.TempDir()
		mustGit(t, dir, "init", "-q")
		if err := os.MkdirAll(filepath.Join(dir, ".git", "info", "attributes"), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := PrepareRepo(&Target{Dir: dir, Host: "a"}); err == nil {
			t.Fatal("expected an error")
		}
	})
}

func TestSetRemote(t *testing.T) {
	dir := t.TempDir()
	mustGit(t, dir, "init", "-q")
	for _, url := range []string{"https://one/x.git", "https://one/x.git", "https://two/x.git"} {
		if err := SetRemote(dir, url); err != nil {
			t.Fatal(err)
		}
		if got := mustGit(t, dir, "remote", "get-url", "origin"); got != url {
			t.Fatalf("got %q, want %q", got, url)
		}
	}
	if err := SetRemote(filepath.Join(dir, "missing"), "x"); err == nil {
		t.Fatal("expected an error in a missing directory")
	}
}

func TestExtname(t *testing.T) {
	for file, want := range map[string]string{
		"a.md": ".md", "dir/a.tar.gz": ".gz", ".bashrc": "", "dir/.bashrc": "", ".foo.md": ".md", "plain": "", "a.": ".",
	} {
		if got := extname(file); got != want {
			t.Errorf("%s: got %q, want %q", file, got, want)
		}
	}
}

func TestConflictCopyName(t *testing.T) {
	now := time.Date(2026, 10, 30, 12, 34, 56, 789_000_000, time.FixedZone("x", 3*3600))
	for file, want := range map[string]string{
		"Home.md":     "Home.conflict-h-2026-10-30T09-34-56-789Z.md",
		"sub/Home.md": "sub/Home.conflict-h-2026-10-30T09-34-56-789Z.md",
		".bashrc":     ".bashrc.conflict-h-2026-10-30T09-34-56-789Z",
	} {
		if got := conflictCopyName(file, "h", now); got != want {
			t.Errorf("%s: got %q, want %q", file, got, want)
		}
	}
}

// Builds a real merge conflict left for the sync to resolve: the driver fails, as if it crashed.
func TestBrokenDriverLeavesAConflictCopy(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	if err := os.Mkdir(filepath.Join(a.Dir, "sub"), 0o777); err != nil {
		t.Fatal(err)
	}
	write(t, a, "sub/Home.md", "base\n")
	syncOK(t, a)
	syncOK(t, b)
	mustGit(t, b.Dir, "config", "merge.ttm.driver", "false")
	write(t, a, "sub/Home.md", "from a\n")
	syncOK(t, a)
	write(t, b, "sub/Home.md", "from b\n")
	var logged []string
	b.Log = func(message string) { logged = append(logged, message) }
	result := syncOK(t, b)
	if !result.Merged || !result.Pushed || len(result.ConflictCopies) != 1 {
		t.Fatalf("got %+v", result)
	}
	conflictCopy := result.ConflictCopies[0]
	if !strings.HasPrefix(conflictCopy, "sub/Home.conflict-b-") || !strings.HasSuffix(conflictCopy, ".md") {
		t.Fatalf("copy: %q", conflictCopy)
	}
	if got := read(t, b, "sub/Home.md"); got != "from b\n" {
		t.Fatalf("ours: %q", got)
	}
	if got := read(t, b, conflictCopy); got != "from a\n" {
		t.Fatalf("theirs: %q", got)
	}
	if want := "merged with leftovers resolved, conflict copies: " + conflictCopy; !slices.Contains(logged, want) {
		t.Fatalf("log: %v", logged)
	}
	syncOK(t, a)
	if got := read(t, a, conflictCopy); got != "from a\n" {
		t.Fatalf("copy did not reach the other machine: %q", got)
	}
}

func TestInterruptedConflictedMergeIsResolved(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	write(t, a, "Home.md", "base\n")
	write(t, a, "Del.md", "base\n")
	write(t, a, "Del2.md", "base\n")
	syncOK(t, a)
	syncOK(t, b)
	write(t, a, "Home.md", "from a\n")
	write(t, a, "Del.md", "edited by a\n")
	if err := os.Remove(filepath.Join(a.Dir, "Del2.md")); err != nil {
		t.Fatal(err)
	}
	syncOK(t, a)
	write(t, b, "Home.md", "from b\n")
	if err := os.Remove(filepath.Join(b.Dir, "Del.md")); err != nil {
		t.Fatal(err)
	}
	write(t, b, "Del2.md", "edited by b\n")
	mustGit(t, b.Dir, "add", "-A")
	mustGit(t, b.Dir, "commit", "-qm", "b")
	mustGit(t, b.Dir, "config", "merge.ttm.driver", "false")
	mustGit(t, b.Dir, "fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main")
	// The crash: git stopped with unmerged paths and the daemon died before resolving them.
	if result, err := git.Raw(b.Dir, []string{"merge", "--no-edit", "origin/main"}); err != nil || result.Code == 0 {
		t.Fatalf("expected a stopped merge: %+v, %v", result, err)
	}
	syncOK(t, b)
	if got := read(t, b, "Home.md"); got != "from b\n" {
		t.Fatalf("ours: %q", got)
	}
	if got := read(t, b, "Del.md"); got != "edited by a\n" {
		t.Fatalf("their edit lost to our delete: %q", got)
	}
	if got := read(t, b, "Del2.md"); got != "edited by b\n" {
		t.Fatalf("our edit lost to their delete: %q", got)
	}
	matches, _ := filepath.Glob(filepath.Join(b.Dir, "Home.conflict-b-*.md"))
	if len(matches) != 1 {
		t.Fatalf("conflict copies: %v", matches)
	}
}

func TestFetchFailureIsReported(t *testing.T) {
	w := makeWorld(t, "a")
	a := w.machines["a"]
	if err := SetRemote(a.Dir, filepath.Join(w.root, "gone.git")); err != nil {
		t.Fatal(err)
	}
	_, err := SyncOnce(a)
	var gitErr *git.Error
	if !errors.As(err, &gitErr) || gitErr.Args[0] != "fetch" {
		t.Fatalf("got %v", err)
	}
}

func TestPushFailureThatIsNotARaceIsReported(t *testing.T) {
	w := makeWorld(t, "a")
	a := w.machines["a"]
	hook := filepath.Join(w.remote, "hooks", "pre-receive")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, a, "Home.md", "x\n")
	// A declined hook says "pre-receive hook declined", and "rejected" for the ref: treated as a race.
	_, err := SyncOnce(a)
	if err == nil || !strings.Contains(err.Error(), "push still rejected after 5 attempts") {
		t.Fatalf("got %v", err)
	}
	mustGit(t, a.Dir, "config", "remote.origin.pushurl", filepath.Join(w.root, "gone.git"))
	_, err = SyncOnce(a)
	var gitErr *git.Error
	if !errors.As(err, &gitErr) || gitErr.Args[0] != "push" {
		t.Fatalf("got %v", err)
	}
}

func TestPushLosingARaceGoesRoundAgain(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	write(t, a, "A.md", "a\n")
	syncOK(t, a)
	syncOK(t, b)
	// A hook on the remote rejects the first push, the way losing a race would.
	hook := filepath.Join(w.remote, "hooks", "pre-receive")
	marker := filepath.Join(w.root, "rejected")
	script := fmt.Sprintf("#!/bin/sh\nif [ ! -e %q ]; then touch %q; exit 1; fi\n", marker, marker)
	if err := os.WriteFile(hook, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	var logged []string
	a.Log = func(message string) { logged = append(logged, message) }
	write(t, a, "A.md", "a2\n")
	result := syncOK(t, a)
	if !result.Pushed || !result.Committed {
		t.Fatalf("got %+v", result)
	}
	if !slices.Contains(logged, "push lost a race (attempt 1), syncing again") {
		t.Fatalf("log: %v", logged)
	}
	if got := mustGit(t, a.Dir, "rev-parse", "refs/remotes/origin/main"); got != mustGit(t, a.Dir, "rev-parse", "HEAD") {
		t.Fatal("the remote-tracking ref must follow a successful push")
	}
}

func TestFreshRepoAdoptsRemoteBranch(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	write(t, a, "A.md", "a\n")
	syncOK(t, a)
	write(t, b, "A.md", "untracked and different\n")
	mustGit(t, b.Dir, "rm", "-q", "--cached", "--ignore-unmatch", "A.md")
	// With an unborn HEAD the local file gets committed first, so the histories are unrelated.
	result := syncOK(t, b)
	if !result.Merged || !result.Pushed {
		t.Fatalf("got %+v", result)
	}
	syncOK(t, a)
	for _, want := range []string{"a\n", "untracked and different\n"} {
		if got := read(t, a, "A.md"); !strings.Contains(got, want) {
			t.Fatalf("lost %q in %q", want, got)
		}
	}
}

func TestCheckoutFailureOnAdoptionIsReported(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	write(t, a, "A.md", "a\n")
	syncOK(t, a)
	// git checkout exits with the status of this hook.
	hook := filepath.Join(b.Dir, ".git", "hooks", "post-checkout")
	if err := os.MkdirAll(filepath.Dir(hook), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := SyncOnce(b); err == nil {
		t.Fatal("expected the checkout to fail")
	}
}

func TestMergeThatCannotStartIsReported(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	write(t, a, "A.md", "a\n")
	syncOK(t, a)
	syncOK(t, b)
	write(t, a, "A.md", "a2\n")
	syncOK(t, a)
	write(t, b, "B.md", "b\n")
	syncOK(t, b)
	write(t, a, "A.md", "a3\n")
	syncOK(t, a)
	// git add skips an assume-unchanged file, so the merge refuses to overwrite it and never starts.
	write(t, b, "A.md", "b dirty\n")
	mustGit(t, b.Dir, "update-index", "--assume-unchanged", "A.md")
	_, err := SyncOnce(b)
	var gitErr *git.Error
	if !errors.As(err, &gitErr) || gitErr.Args[0] != "merge" {
		t.Fatalf("got %v", err)
	}
}

// A hand-made MERGE_HEAD pointing nowhere makes the resolving commit fail.
func TestBadMergeHeadIsReported(t *testing.T) {
	w := makeWorld(t, "a")
	a := w.machines["a"]
	write(t, a, "A.md", "a\n")
	syncOK(t, a)
	if err := os.WriteFile(filepath.Join(a.Dir, ".git", "MERGE_HEAD"), []byte("nonsense\n"), 0o666); err != nil {
		t.Fatal(err)
	}
	if _, err := SyncOnce(a); err == nil {
		t.Fatal("expected an error")
	}
}

func listFiles(t *testing.T, dir string) []string {
	t.Helper()
	var files []string
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Name() == ".git" {
			return filepath.SkipDir
		}
		if !entry.IsDir() {
			rel, _ := filepath.Rel(dir, path)
			files = append(files, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func TestConvergesWithoutLosingLinesUnderRandomEdits(t *testing.T) {
	hosts := []string{"a", "b", "c"}
	w := makeWorld(t, hosts...)
	files := []string{"Home.md", "NebiusNow.md", "Diode.md"}
	seed := int64(42)
	random := func(n int) int {
		seed = (seed*1103515245 + 12345) % (1 << 31)
		return int(seed % int64(n))
	}
	var added []string
	for round := range 12 {
		for _, host := range hosts {
			target := w.machines[host]
			file := files[random(len(files))]
			var lines []string
			if data, err := os.ReadFile(filepath.Join(target.Dir, file)); err == nil {
				for _, line := range strings.Split(string(data), "\n") {
					if line != "" {
						lines = append(lines, line)
					}
				}
			}
			// Mark some task done (an edit that can collide) and always add a unique line.
			if len(lines) > 0 {
				i := random(len(lines))
				if rest, ok := strings.CutPrefix(lines[i], "- "); ok {
					lines[i] = "+ " + rest
				}
			}
			text := fmt.Sprintf("%s round %d", host, round)
			lines = slices.Insert(lines, random(len(lines)+1), "- "+text)
			added = append(added, text)
			write(t, target, file, strings.Join(lines, "\n")+"\n")
		}
		// Machines sync concurrently, so pushes race each other.
		var wg sync.WaitGroup
		for _, host := range hosts {
			wg.Go(func() {
				if _, err := SyncOnce(w.machines[host]); err != nil {
					t.Error(err)
				}
			})
		}
		wg.Wait()
	}
	for range 2 {
		for _, host := range hosts {
			syncOK(t, w.machines[host])
		}
	}
	snapshot := func(target *Target) string {
		var out strings.Builder
		for _, name := range listFiles(t, target.Dir) {
			out.WriteString(name + "\n" + read(t, target, name))
		}
		return out.String()
	}
	reference := snapshot(w.machines["a"])
	for _, host := range hosts {
		if got := snapshot(w.machines[host]); got != reference {
			t.Fatalf("%s diverged:\n%s\nvs\n%s", host, got, reference)
		}
	}
	for _, text := range added {
		if !strings.Contains(reference, text) {
			t.Errorf("lost line: %s", text)
		}
	}
	if strings.Contains(reference, "<<<<<<<") || strings.Contains(reference, ">>>>>>>") {
		t.Fatal("conflict markers in the notes")
	}
}
