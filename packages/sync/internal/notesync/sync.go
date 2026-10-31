// Package notesync keeps a notes directory in sync: one round of commit, merge and push, the merge
// driver git calls back into, and the daemon that decides when to run a round.
package notesync

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/tihonove/ttm/packages/sync/internal/git"
)

type Target struct {
	// Dir is the working tree being synced.
	Dir string
	// Host is the machine name, recorded in commit messages and conflict copies.
	Host string
	// Branch defaults to main.
	Branch string
	// NetworkEnv is extra env for network operations (fetch/push), e.g. an auth header.
	NetworkEnv []string
	Log        func(message string)
	// DriverCommand is the shell command git runs as the merge driver, without the %O %A %B %P
	// arguments.
	DriverCommand string
}

// Result is printed as JSON by `ttm-sync once`.
type Result struct {
	Committed      bool     `json:"committed"`
	Merged         bool     `json:"merged"`
	Pushed         bool     `json:"pushed"`
	ConflictCopies []string `json:"conflictCopies"`
}

const (
	remoteName      = "origin"
	maxPushAttempts = 5
	staleLock       = time.Minute
)

// Attributes and Exclude live in .git/info, not in the notes themselves: same effect, nothing extra
// in the folder.
const Attributes = "* merge=ttm\n"

const Exclude = `# editor temp files
*.swp
*.swx
*~
.#*
*.tmp
.~lock.*#
# sync leftovers
*.orig
# machine-local settings
.claude/settings.local.json
`

var (
	missingRemoteRef = regexp.MustCompile(`(?i)couldn't find remote ref`)
	lostPushRace     = regexp.MustCompile(`(?i)rejected|non-fast-forward|fetch first|failed to update ref|cannot lock`)
)

func (t *Target) log(format string, args ...any) {
	if t.Log != nil {
		t.Log(fmt.Sprintf(format, args...))
	}
}

func (t *Target) branch() string {
	if t.Branch != "" {
		return t.Branch
	}
	return "main"
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// PrepareRepo makes the local repo ready for syncing: merge driver, identity and default ignore
// files.
func PrepareRepo(t *Target) error {
	if !exists(filepath.Join(t.Dir, ".git")) {
		if _, err := git.Run(t.Dir, []string{"init", "-q", "-b", t.branch()}); err != nil {
			return err
		}
	}
	config := []struct{ key, value string }{
		{"merge.ttm.name", "ttm sync merge (never conflicts)"},
		{"merge.ttm.driver", t.DriverCommand + " %O %A %B %P"},
		{"user.name", "ttm-sync@" + t.Host},
		{"user.email", "ttm-sync@" + t.Host},
		{"core.quotePath", "false"},
		{"pull.rebase", "false"},
		// The user's global git config must not change how syncing behaves.
		{"merge.ff", "true"},
		{"rerere.enabled", "false"},
		{"commit.gpgSign", "false"},
	}
	for _, entry := range config {
		if _, err := git.Run(t.Dir, []string{"config", entry.key, entry.value}); err != nil {
			return err
		}
	}
	info := filepath.Join(t.Dir, ".git", "info")
	if err := os.MkdirAll(info, 0o777); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(info, "attributes"), []byte(Attributes), 0o666); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(info, "exclude"), []byte(Exclude), 0o666)
}

func SetRemote(dir, url string) error {
	current, err := git.Raw(dir, []string{"remote", "get-url", remoteName})
	if err != nil {
		return err
	}
	if current.Code != 0 {
		_, err = git.Run(dir, []string{"remote", "add", remoteName, url})
	} else if strings.TrimSpace(string(current.Stdout)) != url {
		_, err = git.Run(dir, []string{"remote", "set-url", remoteName, url})
	}
	return err
}

// finishInterruptedSync recovers from a sync interrupted mid-way (crash, reboot). An unfinished
// merge is completed rather than aborted: aborting could throw away edits made to the working tree
// after the interruption.
func finishInterruptedSync(t *Target) error {
	gitDir := filepath.Join(t.Dir, ".git")
	lock := filepath.Join(gitDir, "index.lock")
	// Nothing tells apart a lock exactly staleLock old from one a nanosecond younger.
	// mutator-disable-next-line expression/comparison
	if info, err := os.Stat(lock); err == nil && time.Since(info.ModTime()) > staleLock {
		if err := os.Remove(lock); err != nil {
			return err
		}
	}
	if exists(filepath.Join(gitDir, "rebase-merge")) || exists(filepath.Join(gitDir, "rebase-apply")) {
		return errors.New("a rebase is in progress in the notes repo; finish or abort it by hand")
	}
	if !exists(filepath.Join(gitDir, "MERGE_HEAD")) {
		return nil
	}
	t.log("finishing an interrupted merge")
	if _, err := resolveLeftovers(t); err != nil {
		return err
	}
	if _, err := git.Run(t.Dir, []string{"add", "-A"}); err != nil {
		return err
	}
	_, err := git.Run(t.Dir, []string{"commit", "-q", "--no-verify", "-m", "merge(" + t.Host + "): finish interrupted"})
	return err
}

func commitLocalChanges(t *Target) (bool, error) {
	if _, err := git.Run(t.Dir, []string{"add", "-A"}); err != nil {
		return false, err
	}
	head, err := git.ResolveRef(t.Dir, "HEAD")
	if err != nil {
		return false, err
	}
	list := []string{"ls-files"}
	if head != "" {
		list = []string{"diff", "--cached", "--name-only"}
	}
	output, err := git.Run(t.Dir, list)
	if err != nil {
		return false, err
	}
	if output == "" {
		return false, nil
	}
	changed := strings.Split(output, "\n")
	summary := changed[0]
	if len(changed) > 1 {
		summary = strconv.Itoa(len(changed)) + " files"
	}
	_, err = git.Run(t.Dir, []string{"commit", "-q", "--no-verify", "-m", "sync(" + t.Host + "): " + summary})
	return err == nil, err
}

type unmergedEntry struct {
	path         string
	ours, theirs bool
}

func listUnmerged(dir string) ([]*unmergedEntry, error) {
	output, err := git.Run(dir, []string{"ls-files", "-u", "-z"})
	if err != nil {
		return nil, err
	}
	var entries []*unmergedEntry
	byPath := map[string]*unmergedEntry{}
	for _, record := range strings.Split(output, "\x00") {
		meta, file, found := strings.Cut(record, "\t")
		if !found {
			// Only the empty record after the last NUL has no tab, so stopping here is the same.
			// mutator-disable-next-line loop/break
			continue
		}
		entry := byPath[file]
		if entry == nil {
			entry = &unmergedEntry{path: file}
			byPath[file] = entry
			entries = append(entries, entry)
		}
		switch strings.Fields(meta)[2] {
		case "2":
			entry.ours = true
		case "3":
			entry.theirs = true
		}
	}
	return entries, nil
}

// extname treats a leading dot as part of the name, so .bashrc has no extension.
func extname(file string) string {
	base := path.Base(file)
	if i := strings.LastIndexByte(base, '.'); i > 0 {
		return base[i:]
	}
	return ""
}

func conflictCopyName(file, host string, now time.Time) string {
	ext := extname(file)
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(now.UTC().Format("2006-01-02T15:04:05.000Z"))
	return path.Join(path.Dir(file), strings.TrimSuffix(path.Base(file), ext)+".conflict-"+host+"-"+stamp+ext)
}

func writeStage(dir string, stage int, file, to string) error {
	args := []string{"show", ":" + strconv.Itoa(stage) + ":" + file}
	result, err := git.Raw(dir, args)
	if err != nil {
		return err
	}
	if result.Code != 0 {
		return &git.Error{Args: args, Result: result}
	}
	return os.WriteFile(filepath.Join(dir, to), result.Stdout, 0o666)
}

// resolveLeftovers resolves whatever the merge driver could not: modify wins over delete, and if
// both sides still disagree ours stays in place and theirs is saved next to it. Nothing is ever
// discarded.
func resolveLeftovers(t *Target) ([]string, error) {
	entries, err := listUnmerged(t.Dir)
	if err != nil {
		return nil, err
	}
	var copies []string
	for _, entry := range entries {
		switch {
		case entry.ours && entry.theirs:
			conflictCopy := conflictCopyName(entry.path, t.Host, time.Now())
			if err := writeStage(t.Dir, 2, entry.path, entry.path); err != nil {
				return copies, err
			}
			if err := writeStage(t.Dir, 3, entry.path, conflictCopy); err != nil {
				return copies, err
			}
			if _, err := git.Run(t.Dir, []string{"add", "--", entry.path, conflictCopy}); err != nil {
				return copies, err
			}
			copies = append(copies, conflictCopy)
		case entry.ours || entry.theirs:
			stage := 3
			if entry.ours {
				stage = 2
			}
			if err := writeStage(t.Dir, stage, entry.path, entry.path); err != nil {
				return copies, err
			}
			if _, err := git.Run(t.Dir, []string{"add", "--", entry.path}); err != nil {
				return copies, err
			}
		default:
			if _, err := git.Run(t.Dir, []string{"rm", "-q", "--cached", "--ignore-unmatch", "--", entry.path}); err != nil {
				return copies, err
			}
		}
	}
	return copies, nil
}

func mergeRemote(t *Target, remoteRef string) (merged bool, copies []string, err error) {
	head, err := git.ResolveRef(t.Dir, "HEAD")
	if err != nil {
		return false, nil, err
	}
	remote, err := git.ResolveRef(t.Dir, remoteRef)
	// A failure resolves to "" too; err is nil when the remote simply has no such branch yet.
	if remote == "" {
		return false, nil, err
	}
	if head == "" {
		// Nothing committed locally yet: adopt the remote branch (refuses to clobber untracked files).
		_, err := git.Run(t.Dir, []string{"checkout", "-q", "-B", t.branch(), remote})
		return err == nil, nil, err
	}
	ancestor, err := git.Raw(t.Dir, []string{"merge-base", "--is-ancestor", remote, head})
	if err != nil {
		return false, nil, err
	}
	if ancestor.Code == 0 {
		return false, nil, nil
	}
	args := []string{"merge", "--no-edit", "--no-verify", "--allow-unrelated-histories", "-m", "merge(" + t.Host + ")", remote}
	result, err := git.Raw(t.Dir, args, TheirsRefEnv+"="+remote)
	if err != nil {
		return false, nil, err
	}
	if result.Code == 0 {
		return true, nil, nil
	}
	if !exists(filepath.Join(t.Dir, ".git", "MERGE_HEAD")) {
		// The merge did not even start (e.g. a file was edited between add and merge): retry later.
		return false, nil, &git.Error{Args: []string{"merge", remote}, Result: result}
	}
	copies, err = resolveLeftovers(t)
	if err != nil {
		return false, copies, err
	}
	if _, err := git.Run(t.Dir, []string{"commit", "-q", "--no-verify", "--no-edit"}); err != nil {
		return false, copies, err
	}
	t.log("merged with leftovers resolved, conflict copies: %s", strings.Join(copies, ", "))
	return true, copies, nil
}

// SyncOnce runs one full round: commit local edits, merge remote ones, push. Safe to call at any
// time and repeatedly; a push that loses the race simply goes round again.
func SyncOnce(t *Target) (Result, error) {
	branch := t.branch()
	remoteRef := "refs/remotes/" + remoteName + "/" + branch
	result := Result{ConflictCopies: []string{}}
	if err := finishInterruptedSync(t); err != nil {
		return result, err
	}
	for attempt := 1; attempt <= maxPushAttempts; attempt++ {
		committed, err := commitLocalChanges(t)
		if err != nil {
			return result, err
		}
		result.Committed = result.Committed || committed

		fetchArgs := []string{"fetch", "-q", remoteName, "+refs/heads/" + branch + ":" + remoteRef}
		fetch, err := git.Raw(t.Dir, fetchArgs, t.NetworkEnv...)
		if err != nil {
			return result, err
		}
		if fetch.Code != 0 && !missingRemoteRef.MatchString(fetch.Stderr) {
			return result, &git.Error{Args: []string{"fetch"}, Result: fetch}
		}

		merged, copies, err := mergeRemote(t, remoteRef)
		if err != nil {
			return result, err
		}
		result.Merged = result.Merged || merged
		result.ConflictCopies = append(result.ConflictCopies, copies...)

		head, err := git.ResolveRef(t.Dir, "HEAD")
		if err != nil {
			return result, err
		}
		remote, err := git.ResolveRef(t.Dir, remoteRef)
		if err != nil {
			return result, err
		}
		// Also covers an empty repo on both sides: mergeRemote has adopted any remote branch by now.
		if head == remote {
			return result, nil
		}

		push, err := git.Raw(t.Dir, []string{"push", "-q", remoteName, "HEAD:refs/heads/" + branch}, t.NetworkEnv...)
		if err != nil {
			return result, err
		}
		if push.Code == 0 {
			if _, err := git.Run(t.Dir, []string{"update-ref", remoteRef, head}); err != nil {
				return result, err
			}
			result.Pushed = true
			return result, nil
		}
		if !lostPushRace.MatchString(push.Stderr) {
			return result, &git.Error{Args: []string{"push"}, Result: push}
		}
		t.log("push lost a race (attempt %d), syncing again", attempt)
	}
	return result, fmt.Errorf("push still rejected after %d attempts", maxPushAttempts)
}
