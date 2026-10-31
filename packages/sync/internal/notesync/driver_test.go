package notesync

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/tihonove/ttm/packages/sync/internal/git"
	"github.com/tihonove/ttm/packages/sync/internal/merge"
)

type driverFixture struct {
	dir                            string
	basePath, oursPath, theirsPath string
}

func newDriverFixture(t *testing.T) *driverFixture {
	dir := t.TempDir()
	return &driverFixture{dir, filepath.Join(dir, "O"), filepath.Join(dir, "A"), filepath.Join(dir, "B")}
}

func (f *driverFixture) stage(t *testing.T, base, ours, theirs string) {
	t.Helper()
	for path, content := range map[string]string{f.basePath: base, f.oursPath: ours, f.theirsPath: theirs} {
		if err := os.WriteFile(path, []byte(content), 0o666); err != nil {
			t.Fatal(err)
		}
	}
}

func (f *driverFixture) input(path, theirsRef string) DriverInput {
	return DriverInput{BasePath: f.basePath, OursPath: f.oursPath, TheirsPath: f.theirsPath, Path: path, RepoDir: f.dir, TheirsRef: theirsRef}
}

func (f *driverFixture) ours(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(f.oursPath)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// history commits path on HEAD and on a side branch with the given commit times.
func (f *driverFixture) history(t *testing.T, path string, oursTime, theirsTime int) {
	t.Helper()
	commit := func(time int, args ...string) {
		t.Helper()
		date := "@" + strconv.Itoa(time) + " +0000"
		if _, err := git.Run(f.dir, append([]string{"commit", "-q"}, args...), "GIT_COMMITTER_DATE="+date, "GIT_AUTHOR_DATE="+date); err != nil {
			t.Fatal(err)
		}
	}
	put := func(content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(f.dir, path), []byte(content), 0o666); err != nil {
			t.Fatal(err)
		}
	}
	mustGit(t, f.dir, "init", "-q", "-b", "main")
	mustGit(t, f.dir, "config", "user.name", "t")
	mustGit(t, f.dir, "config", "user.email", "t@t")
	put("base")
	mustGit(t, f.dir, "add", path)
	commit(1000, "-m", "base")
	mustGit(t, f.dir, "branch", "theirs")
	put("ours")
	commit(oursTime, "-am", "ours")
	mustGit(t, f.dir, "checkout", "-q", "theirs")
	put("theirs")
	commit(theirsTime, "-am", "theirs")
	mustGit(t, f.dir, "checkout", "-q", "main")
}

func TestDriverMergesTextIntoOurs(t *testing.T) {
	f := newDriverFixture(t)
	f.stage(t, "- a\n- b\n", "+ a\n- b\n", "- a\n- b\n- c\n")
	if err := RunDriver(f.input("Home.md", "")); err != nil {
		t.Fatal(err)
	}
	if got := f.ours(t); got != "+ a\n- b\n- c\n" {
		t.Fatalf("got %q", got)
	}
}

func TestDriverBinaryLastWriterWins(t *testing.T) {
	cases := []struct {
		name                 string
		oursTime, theirsTime int
		want                 string
	}{
		{"changed later on their side", 2000, 3000, "\x00\x03"},
		{"changed later on our side", 3000, 2000, "\x00\x02"},
		{"changed at the same second", 3000, 3000, "\x00\x02"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newDriverFixture(t)
			f.history(t, "scan.pdf", c.oursTime, c.theirsTime)
			f.stage(t, "\x00\x01", "\x00\x02", "\x00\x03")
			if err := RunDriver(f.input("scan.pdf", "theirs")); err != nil {
				t.Fatal(err)
			}
			if got := f.ours(t); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestDriverTreatsOversizedTextLikeBinary(t *testing.T) {
	f := newDriverFixture(t)
	f.history(t, "big.txt", 2000, 3000)
	big := func(c string) string { return strings.Repeat(c, merge.TextMergeLimit) + "\n" }
	f.stage(t, big("o"), big("a"), big("b"))
	if err := RunDriver(f.input("big.txt", "theirs")); err != nil {
		t.Fatal(err)
	}
	if got := f.ours(t); got != big("b") {
		t.Fatal("expected theirs")
	}
}

func TestDriverKeepsOursWhenOtherSideIsUnknown(t *testing.T) {
	f := newDriverFixture(t)
	f.stage(t, "\x00\x01", "\x00\x02", "\x00\x03")
	if err := RunDriver(f.input("scan.pdf", "")); err != nil {
		t.Fatal(err)
	}
	if got := f.ours(t); got != "\x00\x02" {
		t.Fatalf("got %q", got)
	}
}

func TestDriverFailsOnUnreadableInput(t *testing.T) {
	for _, missing := range []int{0, 1, 2} {
		f := newDriverFixture(t)
		f.stage(t, "b", "o", "t")
		if err := os.Remove([]string{f.basePath, f.oursPath, f.theirsPath}[missing]); err != nil {
			t.Fatal(err)
		}
		if err := RunDriver(f.input("x", "")); err == nil {
			t.Fatalf("input %d missing: expected an error", missing)
		}
	}
}

func TestDriverLastChangeTimeWithoutGitIsZero(t *testing.T) {
	if got := lastChangeTime(filepath.Join(t.TempDir(), "missing"), "HEAD", "x"); got != 0 {
		t.Fatalf("got %d", got)
	}
	if got := lastChangeTime(t.TempDir(), "HEAD", "x"); got != 0 {
		t.Fatalf("outside a repo: got %d", got)
	}
}

func TestMergeDriverCommand(t *testing.T) {
	if err := MergeDriverCommand([]string{"a", "b", "c"}); err == nil {
		t.Fatal("expected a usage error")
	}
	f := newDriverFixture(t)
	f.history(t, "scan.pdf", 2000, 3000)
	f.stage(t, "\x00\x01", "\x00\x02", "\x00\x03")
	t.Chdir(f.dir)
	t.Setenv(TheirsRefEnv, "theirs")
	if err := MergeDriverCommand([]string{f.basePath, f.oursPath, f.theirsPath, "scan.pdf"}); err != nil {
		t.Fatal(err)
	}
	if got := f.ours(t); got != "\x00\x03" {
		t.Fatalf("got %q", got)
	}
}
