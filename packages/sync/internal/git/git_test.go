package git

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if _, err := Run(dir, []string{"init", "-q", "-b", "main"}); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestRawReportsExitCodeAndOutput(t *testing.T) {
	result, err := Raw(t.TempDir(), []string{"rev-parse", "--verify", "nope"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Code == 0 || result.Stderr == "" {
		t.Fatalf("got %+v", result)
	}
}

func TestRawFailsWhenGitCannotRun(t *testing.T) {
	_, err := Raw(filepath.Join(t.TempDir(), "missing"), []string{"status", "-s"})
	if err == nil || !strings.Contains(err.Error(), "git status -s: ") {
		t.Fatalf("expected an error naming the command, got %v", err)
	}
	if _, err := Run(filepath.Join(t.TempDir(), "missing"), []string{"status"}); err == nil {
		t.Fatal("expected an error for a missing working directory")
	}
}

func TestRawForcesUntranslatedNonInteractiveGit(t *testing.T) {
	t.Setenv("LC_ALL", "ru_RU.UTF-8")
	t.Setenv("GIT_TERMINAL_PROMPT", "1")
	out, err := Run(t.TempDir(), []string{"var", "GIT_EDITOR"}, "GIT_EDITOR=$LC_ALL")
	if err != nil {
		t.Fatal(err)
	}
	if out != "$LC_ALL" {
		t.Fatalf("extra env did not reach git: %q", out)
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "print-env")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho \"$LC_ALL $GIT_TERMINAL_PROMPT\" >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	result, err := Raw(dir, []string{"-c", "alias.show-env=!" + script, "show-env"})
	if err != nil {
		t.Fatal(err)
	}
	if want := "C 0\n"; result.Stderr != want {
		t.Fatalf("env: got %q, want %q", result.Stderr, want)
	}
}

func TestRunTrimsTrailingWhitespaceOnly(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "say")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '  x \\t\\r\\n\\n'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	out, err := Run(dir, []string{"-c", "alias.say=!" + script, "say"})
	if err != nil {
		t.Fatal(err)
	}
	if out != "  x" {
		t.Fatalf("got %q", out)
	}
}

func TestRunReturnsTypedError(t *testing.T) {
	_, err := Run(initRepo(t), []string{"rev-parse", "--verify", "nope"})
	var gitErr *Error
	if !errors.As(err, &gitErr) {
		t.Fatalf("got %v", err)
	}
	if gitErr.Result.Code == 0 || gitErr.Args[0] != "rev-parse" {
		t.Fatalf("got %+v", gitErr)
	}
	want := "git rev-parse --verify nope exited with 128: fatal: Needed a single revision"
	if gitErr.Error() != want {
		t.Fatalf("got %q", gitErr.Error())
	}
}

func TestResolveRef(t *testing.T) {
	dir := initRepo(t)
	missing, err := ResolveRef(dir, "HEAD")
	if err != nil || missing != "" {
		t.Fatalf("unborn HEAD: %q, %v", missing, err)
	}
	if _, err := Run(dir, []string{"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"}); err != nil {
		t.Fatal(err)
	}
	head, err := ResolveRef(dir, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if want, _ := Run(dir, []string{"rev-parse", "HEAD"}); head != want || len(head) != 40 {
		t.Fatalf("got %q, want %q", head, want)
	}
	if _, err := ResolveRef(filepath.Join(dir, "missing"), "HEAD"); err == nil {
		t.Fatal("expected an error for a missing working directory")
	}
}

func TestConfigEnvReachesGit(t *testing.T) {
	env := ConfigEnv([][2]string{{"ttm.one", "1"}, {"ttm.two", "2"}})
	for key, want := range map[string]string{"ttm.one": "1", "ttm.two": "2"} {
		got, err := Run(t.TempDir(), []string{"config", "--get", key}, env...)
		if err != nil || got != want {
			t.Fatalf("%s: got %q, %v", key, got, err)
		}
	}
}
