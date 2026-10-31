package notesync

import (
	"errors"
	"os"
	"strconv"
	"strings"

	"github.com/tihonove/ttm/packages/sync/internal/git"
	"github.com/tihonove/ttm/packages/sync/internal/merge"
)

// TheirsRefEnv is the env var the daemon sets to the ref being merged in, so the driver can date
// "their" side.
const TheirsRefEnv = "TTM_THEIRS_REF"

// DriverInput is what git hands to the merge driver.
type DriverInput struct {
	BasePath, OursPath, TheirsPath string
	// Path is the repo-relative path of the file being merged.
	Path string
	// RepoDir is the repository the merge runs in.
	RepoDir string
	// TheirsRef is the side being merged in; without it (no such ref, no date) binary files keep ours.
	TheirsRef string
}

// lastChangeTime is 0 when git has no answer: its output is empty then.
func lastChangeTime(repoDir, ref, file string) int {
	result, _ := git.Raw(repoDir, []string{"log", "-1", "--format=%ct", ref, "--", file})
	seconds, _ := strconv.Atoi(strings.TrimSpace(string(result.Stdout)))
	return seconds
}

// RunDriver writes the merge result into OursPath without conflict markers, so a sync merge never
// stops and waits for a human.
func RunDriver(input DriverInput) error {
	base, err := os.ReadFile(input.BasePath)
	if err != nil {
		return err
	}
	ours, err := os.ReadFile(input.OursPath)
	if err != nil {
		return err
	}
	theirs, err := os.ReadFile(input.TheirsPath)
	if err != nil {
		return err
	}
	if merge.IsMergeableText(base, ours, theirs) {
		merged, err := merge.Text(base, ours, theirs)
		if err != nil {
			return err
		}
		return os.WriteFile(input.OursPath, merged, 0o666)
	}
	// Large or binary file: last writer wins, the other version stays in history.
	if lastChangeTime(input.RepoDir, input.TheirsRef, input.Path) > lastChangeTime(input.RepoDir, "HEAD", input.Path) {
		return os.WriteFile(input.OursPath, theirs, 0o666)
	}
	return nil
}

// MergeDriverCommand is `ttm-sync merge-driver %O %A %B %P`, run by git from the top of the working
// tree. On failure the path stays unmerged; the daemon keeps ours and saves theirs as a conflict
// copy.
func MergeDriverCommand(args []string) error {
	if len(args) < 4 {
		return errors.New("usage: ttm-sync merge-driver %O %A %B %P")
	}
	return RunDriver(DriverInput{
		BasePath: args[0], OursPath: args[1], TheirsPath: args[2], Path: args[3],
		RepoDir: ".", TheirsRef: os.Getenv(TheirsRefEnv),
	})
}
