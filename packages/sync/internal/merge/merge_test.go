package merge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

func mergeStrings(t *testing.T, base, ours, theirs string) string {
	t.Helper()
	out, err := Text([]byte(base), []byte(ours), []byte(theirs))
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func TestText(t *testing.T) {
	cases := []struct{ name, base, ours, theirs, want string }{
		{"only ours changed", "a\n", "a\nb\n", "a\n", "a\nb\n"},
		{"only theirs changed", "a\n", "a\n", "x\n", "x\n"},
		{"status change next to an appended line", "NOW:\n- buy milk\n", "NOW:\n- buy milk\n- call mom\n", "NOW:\n+ buy milk\n", "NOW:\n+ buy milk\n- call mom\n"},
		{"same, sides swapped", "NOW:\n- buy milk\n", "NOW:\n+ buy milk\n", "NOW:\n- buy milk\n- call mom\n", "NOW:\n+ buy milk\n- call mom\n"},
		{"neighbouring lines", "- a\n- b\n- c\n", "+ a\n- b\n- c\n", "- a\n+ b\n- c\n", "+ a\n+ b\n- c\n"},
		{"line changed on both sides", "x\n- a\ny\n", "x\n+ a\ny\n", "x\n- a (later)\ny\n", "x\n+ a\n- a (later)\ny\n"},
		{"insertions at the same place", "x\ny\n", "x\n- one\ny\n", "x\n- two\ny\n", "x\n- one\n- two\ny\n"},
		{"insertions sharing a line", "x\n", "x\n- same\n- one\n", "x\n- same\n- two\n", "x\n- same\n- one\n- two\n"},
		{"deletion and an edit elsewhere", "a\nb\nc\nd\n", "a\nc\nd\n", "a\nb\nc\nd!\n", "a\nc\nd!\n"},
		{"last lines without a newline", "a", "a\nb", "a\nc", "a\nb\nc\n"},
		{"both changed identically", "a\n", "b\n", "b\n", "b\n"},
		{"both changed identically, no newline added", "a", "b", "b", "b"},
		{"all empty but theirs", "", "", "x", "x"},
		{"both add to an empty file", "", "a\n", "b\n", "a\nb\n"},
		{"both delete different lines", "a\nb\nc\n", "b\nc\n", "a\nb\n", "b\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := mergeStrings(t, c.base, c.ours, c.theirs); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

// The corpus is what the TypeScript merge in apps/server produces; both must agree byte for byte.
func TestCorpusMatchesServerMerge(t *testing.T) {
	data, err := os.ReadFile("../../../git/test/merge-corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ Base, Ours, Theirs, Merged string }
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("empty corpus")
	}
	for i, c := range cases {
		if got := mergeStrings(t, c.Base, c.Ours, c.Theirs); got != c.Merged {
			t.Errorf("case %d: base %q ours %q theirs %q\n got %q\nwant %q", i, c.Base, c.Ours, c.Theirs, got, c.Merged)
		}
	}
}

func TestInvalidUTF8SurvivesUntouched(t *testing.T) {
	base := "a\n\xff\xfe\nz\n"
	got := mergeStrings(t, base, "a!\n\xff\xfe\nz\n", "a\n\xff\xfe\nz!\n")
	if want := "a!\n\xff\xfe\nz!\n"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestOverlaps(t *testing.T) {
	cases := []struct {
		x, y hunk
		want bool
	}{
		{hunk{start: 3, end: 3}, hunk{start: 3, end: 3}, true},
		{hunk{start: 3, end: 3}, hunk{start: 4, end: 4}, false},
		{hunk{start: 1, end: 3}, hunk{start: 2, end: 4}, true},
		{hunk{start: 1, end: 3}, hunk{start: 3, end: 5}, false},
		{hunk{start: 3, end: 5}, hunk{start: 1, end: 3}, false},
		{hunk{start: 3, end: 3}, hunk{start: 1, end: 3}, false},
		{hunk{start: 1, end: 3}, hunk{start: 1, end: 1}, false},
		{hunk{start: 1, end: 5}, hunk{start: 3, end: 3}, true},
	}
	for _, c := range cases {
		if got := overlaps(c.x, c.y); got != c.want {
			t.Errorf("%+v, %+v: got %t", c.x, c.y, got)
		}
	}
}

// The numbers the README and the server's merge promise; tests elsewhere use the constants.
func TestLimits(t *testing.T) {
	if TextMergeLimit != 1048576 || binaryProbe != 8000 {
		t.Fatalf("limits: %d, %d", TextMergeLimit, binaryProbe)
	}
}

// fakeGit puts a script named git first on PATH.
func fakeGit(t *testing.T, script string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(dir+"/git", []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
}

func TestGitUnionMergeExitCodes(t *testing.T) {
	cases := []struct {
		name, script string
		wantErr      bool
	}{
		{"conflict count just below the error range", "echo merged; exit 127", false},
		{"lowest error code", "echo oops >&2; exit 128", true},
		{"killed by a signal", "kill -9 $$", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fakeGit(t, c.script)
			out, err := gitUnionMerge([]byte("b\n"), []byte("o\n"), []byte("t\n"))
			if (err != nil) != c.wantErr {
				t.Fatalf("got %q, %v", out, err)
			}
			if c.wantErr && out != nil {
				t.Fatalf("output on failure: %q", out)
			}
			if !c.wantErr && string(out) != "merged\n" {
				t.Fatalf("got %q", out)
			}
		})
	}
}

func numbered(prefix string, n int) string {
	var out strings.Builder
	for i := range n {
		fmt.Fprintf(&out, "%s%d\n", prefix, i)
	}
	return out.String()
}

// Just over the cell limit the in-process diff gives up and git's union merge takes over: it keeps
// both sides' lines in its own order, which the in-process merge would dedupe differently.
func TestHugeChangeFallsBackToGit(t *testing.T) {
	base := "top\n" + numbered("b", 2100) + "bottom\n"
	ours := "top\n" + numbered("o", 2100) + "bottom\n"
	theirs := "top\n" + numbered("t", 2100) + "bottom\n"
	got := mergeStrings(t, base, ours, theirs)
	if want := "top\n" + numbered("o", 2100) + numbered("t", 2100) + "bottom\n"; got != want {
		t.Fatalf("unexpected union merge of %d bytes", len(got))
	}
}

func TestDiffCellLimitBoundary(t *testing.T) {
	// (1999+1)*(1999+1) cells is exactly the limit: still in process.
	if _, ok := diff(strings.Split(numbered("a", 1999), "\n")[:1999], strings.Split(numbered("b", 1999), "\n")[:1999]); !ok {
		t.Fatal("exactly at the limit must stay in process")
	}
	if _, ok := diff(strings.Split(numbered("a", 2000), "\n")[:2000], strings.Split(numbered("b", 1999), "\n")[:1999]); ok {
		t.Fatal("above the limit must give up")
	}
}

func TestGitUnionMergeFailure(t *testing.T) {
	t.Setenv("TMPDIR", "/nonexistent-ttm-dir")
	if _, err := gitUnionMerge(nil, nil, nil); err == nil {
		t.Fatal("expected an error without a temp dir")
	}
}

func TestGitUnionMergeReportsGitFailure(t *testing.T) {
	t.Setenv("PATH", "")
	if _, err := gitUnionMerge([]byte("b\n"), []byte("o\n"), []byte("t\n")); err == nil {
		t.Fatal("expected an error without git")
	}
}

func TestGitUnionMergeRemovesItsTempDir(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	if _, err := gitUnionMerge([]byte("b\n"), []byte("o\n"), []byte("t\n")); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(tmp)
	if len(entries) != 0 {
		t.Fatalf("left behind: %v", entries)
	}
}

func TestIsBinary(t *testing.T) {
	if IsBinary([]byte("text")) {
		t.Fatal("text is not binary")
	}
	if !IsBinary([]byte{'a', 0}) {
		t.Fatal("NUL makes a file binary")
	}
	edge := bytes.Repeat([]byte{'a'}, binaryProbe+1)
	edge[binaryProbe-1] = 0
	if !IsBinary(edge) {
		t.Fatal("NUL at the last probed byte counts")
	}
	edge[binaryProbe-1] = 'a'
	edge[binaryProbe] = 0
	if IsBinary(edge) {
		t.Fatal("NUL past the probe does not count")
	}
}

func TestIsMergeableText(t *testing.T) {
	limit := bytes.Repeat([]byte{'a'}, TextMergeLimit)
	if !IsMergeableText(limit, []byte("x")) {
		t.Fatal("exactly the limit is mergeable")
	}
	if IsMergeableText([]byte("x"), append(limit, 'a')) {
		t.Fatal("over the limit is not mergeable")
	}
	if IsMergeableText([]byte("x"), []byte{0}) {
		t.Fatal("binary is not mergeable")
	}
}
