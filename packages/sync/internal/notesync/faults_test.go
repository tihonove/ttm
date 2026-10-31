package notesync

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// installVanishingGit puts a git on PATH that runs `allowed` commands and then is gone, and returns
// the file it logs them to. Git can vanish before any command, so a failure anywhere is reachable.
func installVanishingGit(t *testing.T, allowed int) string {
	t.Helper()
	real, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	log := filepath.Join(t.TempDir(), "commands")
	if allowed > 0 {
		script := fmt.Sprintf(`#!/bin/sh
PATH=%q
echo "$*" >> %q
%q "$@"
code=$?
if [ "$(wc -l < %q)" -ge %d ]; then rm -f "$0"; fi
exit $code
`, os.Getenv("PATH"), log, real, log, allowed)
		if err := os.WriteFile(filepath.Join(dir, "git"), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	return log
}

var volatileArgs = regexp.MustCompile(`[0-9a-f]{40}|\d{4}-\d\d-\d\dT[\d-]+Z`)

func normalize(text string) string { return volatileArgs.ReplaceAllString(text, "<volatile>") }

// divergedMachines leaves b with an edit of its own, and with one from a still to be merged.
func divergedMachines(t *testing.T, edit func(a, b *Target)) *Target {
	t.Helper()
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	write(t, a, "Home.md", "base\n")
	syncOK(t, a)
	syncOK(t, b)
	edit(a, b)
	syncOK(t, a)
	return b
}

func renameInBoth(t *testing.T, a, b *Target) {
	t.Helper()
	for target, name := range map[*Target]string{a: "FromA.md", b: "FromB.md"} {
		if err := os.Rename(filepath.Join(target.Dir, "Home.md"), filepath.Join(target.Dir, name)); err != nil {
			t.Fatal(err)
		}
	}
}

func editInBothWithBrokenDriver(t *testing.T, a, b *Target) {
	t.Helper()
	mustGit(t, b.Dir, "config", "merge.ttm.driver", "false")
	write(t, a, "Home.md", "from a\n")
	write(t, b, "Home.md", "from b\n")
}

// Whichever git command cannot run, the round stops right there and says which one it was, rather
// than going on with an empty answer.
func TestEveryGitCommandFailureStopsTheRound(t *testing.T) {
	syncOnce := func(target *Target) func() error {
		return func() error { _, err := SyncOnce(target); return err }
	}
	scenarios := map[string]func(t *testing.T) (root string, action func() error){
		"setting up": func(t *testing.T) (string, func() error) {
			root := t.TempDir()
			return root, func() error {
				if err := PrepareRepo(&Target{Dir: root, Host: "a"}); err != nil {
					return err
				}
				return SetRemote(root, "/nowhere")
			}
		},
		"commit, merge and push": func(t *testing.T) (string, func() error) {
			b := divergedMachines(t, func(a, b *Target) {
				write(t, a, "A.md", "a\n")
				write(t, b, "B.md", "b\n")
			})
			return filepath.Dir(b.Dir), syncOnce(b)
		},
		"adopting the remote branch": func(t *testing.T) (string, func() error) {
			w := makeWorld(t, "a", "b")
			write(t, w.machines["a"], "Home.md", "a\n")
			syncOK(t, w.machines["a"])
			return w.root, syncOnce(w.machines["b"])
		},
		"conflict copies": func(t *testing.T) (string, func() error) {
			b := divergedMachines(t, func(a, b *Target) { editInBothWithBrokenDriver(t, a, b) })
			return filepath.Dir(b.Dir), syncOnce(b)
		},
		"renamed on both sides": func(t *testing.T) (string, func() error) {
			b := divergedMachines(t, func(a, b *Target) { renameInBoth(t, a, b) })
			return filepath.Dir(b.Dir), syncOnce(b)
		},
		"interrupted merge": func(t *testing.T) (string, func() error) {
			b := divergedMachines(t, func(a, b *Target) { editInBothWithBrokenDriver(t, a, b) })
			mustGit(t, b.Dir, "add", "-A")
			mustGit(t, b.Dir, "commit", "-qm", "local")
			mustGit(t, b.Dir, "fetch", "-q", "origin")
			if _, err := exec.Command("git", "-C", b.Dir, "merge", "origin/main").CombinedOutput(); err == nil {
				t.Fatal("the merge was meant to stop on a conflict")
			}
			return filepath.Dir(b.Dir), syncOnce(b)
		},
	}
	for name, setup := range scenarios {
		t.Run(name, func(t *testing.T) {
			root, action := setup(t)
			// One setup restored for every command: building it anew each time takes most of a minute.
			snapshot := t.TempDir()
			copyTree(t, root, snapshot)
			restore := func(t *testing.T) {
				t.Helper()
				if err := os.RemoveAll(root); err != nil {
					t.Fatal(err)
				}
				copyTree(t, snapshot, root)
			}
			var commands []string
			t.Run("baseline", func(t *testing.T) {
				log := installVanishingGit(t, 1_000_000)
				if err := action(); err != nil {
					t.Fatal(err)
				}
				data, err := os.ReadFile(log)
				if err != nil {
					t.Fatal(err)
				}
				commands = strings.Split(strings.TrimSpace(string(data)), "\n")
			})
			for i, command := range commands {
				t.Run(strconv.Itoa(i), func(t *testing.T) {
					restore(t)
					installVanishingGit(t, i)
					err := action()
					if err == nil {
						t.Fatalf("no error without git at %q", command)
					}
					if want := "git " + normalize(command) + ":"; !strings.Contains(normalize(err.Error()), want) {
						t.Fatalf("want %q, got %q", want, err)
					}
				})
			}
		})
	}
}

func copyTree(t *testing.T, from, to string) {
	t.Helper()
	if out, err := exec.Command("cp", "-a", "-T", from, to).CombinedOutput(); err != nil {
		t.Fatalf("cp: %v: %s", err, out)
	}
}

func TestStaleLockThatCannotBeRemovedIsReported(t *testing.T) {
	w := makeWorld(t, "a")
	a := w.machines["a"]
	gitDir := filepath.Join(a.Dir, ".git")
	lock := filepath.Join(gitDir, "index.lock")
	if err := os.WriteFile(lock, nil, 0o666); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-5 * time.Minute)
	if err := os.Chtimes(lock, old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(gitDir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(gitDir, 0o777) })
	_, err := SyncOnce(a)
	if !errors.Is(err, fs.ErrPermission) || !strings.Contains(err.Error(), "remove") {
		t.Fatalf("got %v", err)
	}
}

func TestBothRenamingAFileKeepsBothNames(t *testing.T) {
	b := divergedMachines(t, func(a, b *Target) { renameInBoth(t, a, b) })
	result := syncOK(t, b)
	if !result.Merged || !result.Pushed {
		t.Fatalf("got %+v", result)
	}
	if got := read(t, b, "FromA.md") + read(t, b, "FromB.md"); got != "base\nbase\n" {
		t.Fatalf("got %q", got)
	}
	if got := mustGit(t, b.Dir, "ls-files"); got != "FromA.md\nFromB.md" {
		t.Fatalf("tracked: %q", got)
	}
}

func rejectPushes(t *testing.T, w *world, script string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(w.remote, "hooks", "pre-receive"), []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestGivesUpAfterFivePushAttempts(t *testing.T) {
	w := makeWorld(t, "a")
	a := w.machines["a"]
	rejectPushes(t, w, "exit 1")
	var logged []string
	a.Log = func(message string) { logged = append(logged, message) }
	write(t, a, "A.md", "a\n")
	_, err := SyncOnce(a)
	if err == nil || err.Error() != "push still rejected after 5 attempts" {
		t.Fatalf("got %v", err)
	}
	if !slices.Contains(logged, "push lost a race (attempt 5), syncing again") {
		t.Fatalf("log: %v", logged)
	}
}

func TestResultRemembersAMergeFromAnEarlierAttempt(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	write(t, a, "A.md", "a\n")
	syncOK(t, a)
	write(t, b, "B.md", "b\n")
	marker := filepath.Join(w.root, "rejected")
	rejectPushes(t, w, fmt.Sprintf("if [ ! -e %q ]; then touch %q; exit 1; fi", marker, marker))
	if result := syncOK(t, b); !result.Merged || !result.Pushed {
		t.Fatalf("got %+v", result)
	}
}

func TestDriverFailsWhenTheMergeCannotRun(t *testing.T) {
	f := newDriverFixture(t)
	// Big enough to be left to git's union merge.
	lines := func(prefix string) string { return strings.Repeat(prefix+"\n", 2100) }
	f.stage(t, "top\n"+lines("b")+"bottom\n", "top\n"+lines("o")+"bottom\n", "top\n"+lines("t")+"bottom\n")
	installVanishingGit(t, 0)
	if err := RunDriver(f.input("x", "")); err == nil {
		t.Fatal("expected an error")
	}
	if got := f.ours(t); got != "top\n"+lines("o")+"bottom\n" {
		t.Fatalf("ours must stay as it was, %d bytes now", len(got))
	}
}

func TestDriverComparesFullTimestamps(t *testing.T) {
	f := newDriverFixture(t)
	// A 9 in the newer one: anything but decimal would misread it.
	f.history(t, "scan.pdf", 1009, 1008)
	f.stage(t, "\x00\x01", "\x00\x02", "\x00\x03")
	if err := RunDriver(f.input("scan.pdf", "theirs")); err != nil {
		t.Fatal(err)
	}
	if got := f.ours(t); got != "\x00\x02" {
		t.Fatalf("got %q", got)
	}
}

func TestAddWatches(t *testing.T) {
	dir := t.TempDir()
	for _, sub := range []string{".git/objects", "a/b"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o777); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "a", "file.md"), nil, 0o666); err != nil {
		t.Fatal(err)
	}
	var added, logged []string
	addWatches(dir, func(path string) error {
		added = append(added, path)
		if strings.HasSuffix(path, "b") {
			return errors.New("too many watches")
		}
		return nil
	}, func(message string) { logged = append(logged, message) })
	want := []string{dir, filepath.Join(dir, "a"), filepath.Join(dir, "a", "b")}
	if !slices.Equal(added, want) {
		t.Fatalf("added %v", added)
	}
	if want := "watch " + filepath.Join(dir, "a", "b") + ": too many watches"; !slices.Equal(logged, []string{want}) {
		t.Fatalf("log: %v", logged)
	}
	// A directory that is gone again by the time it is walked.
	addWatches(filepath.Join(dir, "missing"), func(path string) error {
		t.Errorf("added %s", path)
		return nil
	}, func(string) {})
}

func TestWatchTreeCloseWaitsForTheCallback(t *testing.T) {
	dir := t.TempDir()
	entered := make(chan struct{}, 100)
	release := make(chan struct{})
	closeWatch, err := watchTree(dir, func() {
		entered <- struct{}{}
		<-release
	}, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.md"), nil, 0o666); err != nil {
		t.Fatal(err)
	}
	<-entered
	closed := make(chan struct{})
	go func() {
		closeWatch()
		close(closed)
	}()
	select {
	case <-closed:
		t.Fatal("close did not wait")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	<-closed
}

func TestDelays(t *testing.T) {
	// README promises the first two.
	for _, c := range []struct{ got, want time.Duration }{
		{debounceDelay, 2000 * time.Millisecond},
		{maxDelay, 15000 * time.Millisecond},
		{periodicDelay, 300000 * time.Millisecond},
		{baseBackoff, 5000 * time.Millisecond},
		{maxBackoff, 300000 * time.Millisecond},
	} {
		if c.got != c.want {
			t.Errorf("got %s, want %s", c.got, c.want)
		}
	}
}

func TestNextEventsBackoff(t *testing.T) {
	if got := nextEventsBackoff(time.Second); got != 2*time.Second {
		t.Fatalf("got %s", got)
	}
	if got := nextEventsBackoff(40 * time.Second); got != time.Minute {
		t.Fatalf("got %s", got)
	}
}

func TestSyncUnlessCurrent(t *testing.T) {
	w := makeWorld(t, "a")
	a := w.machines["a"]
	write(t, a, "A.md", "a\n")
	syncOK(t, a)
	head := mustGit(t, a.Dir, "rev-parse", "HEAD")
	other := "0000000000000000000000000000000000000000"
	missing := filepath.Join(w.root, "missing")
	for _, c := range []struct {
		dir  string
		head *string
		want bool
	}{{a.Dir, &head, false}, {a.Dir, &other, true}, {a.Dir, nil, true}, {missing, &head, true}} {
		synced := false
		syncUnlessCurrent(c.dir, c.head, func() { synced = true })
		if synced != c.want {
			t.Errorf("%s: got %t", c.dir, synced)
		}
	}
}

func TestSchedulerLogsAnyWorkDone(t *testing.T) {
	for _, c := range []struct {
		result Result
		want   string
	}{
		{Result{Committed: true}, "committed=true merged=false pushed=false"},
		{Result{Merged: true}, "committed=false merged=true pushed=false"},
		{Result{Pushed: true}, "committed=false merged=false pushed=true"},
	} {
		p := newSchedulerProbe()
		p.results = []func() (Result, error){func() (Result, error) { return c.result, nil }}
		p.s.now()
		waitFor(t, c.want, func() bool { return p.log.has(c.want) })
		p.s.stop()
	}
}

func TestSchedulerNotifiesAboutASingleConflictCopy(t *testing.T) {
	p := newSchedulerProbe()
	defer p.s.stop()
	p.results = []func() (Result, error){func() (Result, error) {
		return Result{ConflictCopies: []string{"a"}}, nil
	}}
	p.s.now()
	waitFor(t, "the notification", func() bool { return len(p.notifications()) == 1 })
}

func TestSchedulerCountsFailuresFromZeroAfterSuccess(t *testing.T) {
	p := newSchedulerProbe()
	defer p.s.stop()
	failure := func() (Result, error) { return Result{}, errors.New("HTTP 401") }
	p.results = []func() (Result, error){func() (Result, error) { return Result{}, nil }, failure, failure, failure}
	p.s.now()
	waitFor(t, "the first success", func() bool { return p.runCount() == 1 })
	p.s.now()
	waitFor(t, "the notification", func() bool { return len(p.notifications()) >= 1 })
}

func inotifyDescriptors(t *testing.T) int {
	t.Helper()
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, entry := range entries {
		if link, err := os.Readlink(filepath.Join("/proc/self/fd", entry.Name())); err == nil && strings.Contains(link, "inotify") {
			count++
		}
	}
	return count
}

// An edit made before the daemon started goes out at once; one still waiting when it stops does not.
func TestDaemonSyncsOnStartAndStopsCleanly(t *testing.T) {
	w := makeWorld(t, "a")
	a := w.machines["a"]
	server := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		rw.WriteHeader(http.StatusOK)
		rw.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	before := inotifyDescriptors(t)
	write(t, a, "Home.md", "- before the start\n")
	var stopped atomic.Bool
	stop, err := RunDaemon(DaemonConfig{Dir: a.Dir, Host: a.Host, Server: server.URL, Token: "t"}, func(string) {}, a.DriverCommand)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if !stopped.Load() {
			stop()
		}
	}()
	waitFor(t, "the first push", func() bool { return exists(filepath.Join(w.remote, "refs", "heads", "main")) })
	write(t, a, "Home.md", "- while stopping\n")
	time.Sleep(200 * time.Millisecond)
	stop()
	stopped.Store(true)
	if got := inotifyDescriptors(t); got != before {
		t.Fatalf("the watcher stayed open: %d descriptors, had %d", got, before)
	}
	time.Sleep(debounceDelay + 300*time.Millisecond)
	if got := mustGit(t, a.Dir, "status", "--porcelain"); got == "" {
		t.Fatal("synced after stop")
	}
}
