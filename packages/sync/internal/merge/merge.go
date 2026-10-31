// Package merge is the three-way line merge of notes. apps/server has the same algorithm in
// packages/git/src/merge.ts; both are checked against packages/git/test/merge-corpus.json.
package merge

import (
	"bytes"
	"cmp"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/tihonove/ttm/packages/sync/internal/git"
)

// TextMergeLimit is the size above which files are not merged line by line: the newer side wins.
const TextMergeLimit = 1024 * 1024

// binaryProbe is how far into a file a NUL byte makes it binary.
const binaryProbe = 8000

// maxDiffCells is where the in-process diff gets too slow and git's diff takes over.
const maxDiffCells = 4_000_000

func IsBinary(content []byte) bool {
	return bytes.IndexByte(content[:min(len(content), binaryProbe)], 0) >= 0
}

func IsMergeableText(contents ...[]byte) bool {
	for _, content := range contents {
		if len(content) > TextMergeLimit || IsBinary(content) {
			return false
		}
	}
	return true
}

// hunk is a change to base lines [start, end), replaced by lines. start == end is a pure insertion.
type hunk struct {
	start, end int
	lines      []string
}

func splitLines(text string) []string {
	lines := strings.Split(text, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// diff returns the hunks turning base into side, from a longest common subsequence of lines;
// false when the inputs are too large for it.
func diff(base, side []string) ([]hunk, bool) {
	prefix := 0
	for prefix < len(base) && prefix < len(side) && base[prefix] == side[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(base)-prefix && suffix < len(side)-prefix && base[len(base)-1-suffix] == side[len(side)-1-suffix] {
		suffix++
	}
	a := base[prefix : len(base)-suffix]
	b := side[prefix : len(side)-suffix]
	if (len(a)+1)*(len(b)+1) > maxDiffCells {
		return nil, false
	}

	// lcs[i*width+j]: LCS length of a[i:] and b[j:].
	// Any larger width only spreads the table out.
	// mutator-disable-next-line numbers/incrementer
	width := len(b) + 1
	lcs := make([]uint32, (len(a)+1)*width)
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				// The diff only compares these lengths, so any positive step gives the same hunks.
				// mutator-disable-next-line numbers/incrementer
				lcs[i*width+j] = lcs[(i+1)*width+j+1] + 1
			} else {
				lcs[i*width+j] = max(lcs[(i+1)*width+j], lcs[i*width+j+1])
			}
		}
	}
	var hunks []hunk
	var current *hunk
	flush := func() {
		if current != nil {
			hunks = append(hunks, *current)
		}
		current = nil
	}
	open := func(i int) {
		if current == nil {
			current = &hunk{start: prefix + i, end: prefix + i}
		}
	}
	i, j := 0, 0
	for i < len(a) || j < len(b) {
		if i < len(a) && j < len(b) && a[i] == b[j] {
			flush()
			i++
			j++
			// lcs[i][j] is the larger of these two, so comparing against it picks the same branch.
			// mutator-disable-next-line numbers/decrementer
		} else if j < len(b) && (i == len(a) || lcs[i*width+j+1] >= lcs[(i+1)*width+j]) {
			open(i)
			current.lines = append(current.lines, b[j])
			j++
		} else {
			open(i)
			i++
			current.end = prefix + i
		}
	}
	flush()
	return hunks, true
}

func overlaps(x, y hunk) bool {
	// Two insertions at the same spot compete for the same place.
	if x.start == x.end && y.start == y.end {
		return x.start == y.start
	}
	return x.start < y.end && y.start < x.end
}

// apply applies hunks (sorted, non-overlapping) to base lines [from, to).
func apply(base []string, hunks []hunk, from, to int) []string {
	var out []string
	pos := from
	for _, h := range hunks {
		out = append(out, base[pos:h.start]...)
		out = append(out, h.lines...)
		pos = h.end
	}
	return append(out, base[pos:to]...)
}

type taggedHunk struct {
	hunk
	theirs bool
}

func side(cluster []taggedHunk, theirs bool) []hunk {
	var hunks []hunk
	for _, tagged := range cluster {
		if tagged.theirs == theirs {
			hunks = append(hunks, tagged.hunk)
		}
	}
	return hunks
}

// mergeLines is a diff3-style merge. Changes that don't touch the same base lines — including
// adjacent ones — merge cleanly. Where both sides changed the same lines differently, ours comes
// first, followed by the lines of theirs that ours doesn't already have. Lines are never lost.
func mergeLines(base []string, ours, theirs []hunk) []string {
	tagged := make([]taggedHunk, 0, len(ours)+len(theirs))
	for _, h := range ours {
		tagged = append(tagged, taggedHunk{h, false})
	}
	for _, h := range theirs {
		tagged = append(tagged, taggedHunk{h, true})
	}
	slices.SortStableFunc(tagged, func(x, y taggedHunk) int {
		return cmp.Or(cmp.Compare(x.start, y.start), cmp.Compare(x.end, y.end))
	})

	var out []string
	pos := 0
	for k := 0; k < len(tagged); {
		// Grow a cluster of hunks that transitively overlap each other.
		cluster := []taggedHunk{tagged[k]}
		start, end := tagged[k].start, tagged[k].end
		for k++; k < len(tagged) && overlapsAny(cluster, tagged[k].hunk); k++ {
			cluster = append(cluster, tagged[k])
			end = max(end, tagged[k].end)
		}
		out = append(out, base[pos:start]...)
		oursHunks, theirsHunks := side(cluster, false), side(cluster, true)
		oursPart := apply(base, oursHunks, start, end)
		theirsPart := apply(base, theirsHunks, start, end)
		switch {
		case len(theirsHunks) == 0:
			out = append(out, oursPart...)
		case len(oursHunks) == 0:
			out = append(out, theirsPart...)
		default:
			seen := make(map[string]bool, len(oursPart))
			for _, line := range oursPart {
				seen[line] = true
			}
			out = append(out, oursPart...)
			for _, line := range theirsPart {
				if !seen[line] {
					out = append(out, line)
				}
			}
		}
		pos = end
	}
	return append(out, base[pos:]...)
}

func overlapsAny(cluster []taggedHunk, h hunk) bool {
	for _, tagged := range cluster {
		if overlaps(tagged.hunk, h) {
			return true
		}
	}
	return false
}

func joinLines(lines []string) []byte {
	var out bytes.Buffer
	for _, line := range lines {
		out.WriteString(line)
		out.WriteByte('\n')
	}
	return out.Bytes()
}

func gitUnionMerge(base, ours, theirs []byte) ([]byte, error) {
	dir, err := os.MkdirTemp("", "ttm-merge-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	paths := map[string][]byte{"ours": ours, "base": base, "theirs": theirs}
	for name, content := range paths {
		// The directory was created a moment ago for this; only a full disk fails here.
		// mutator-disable-next-line branch/if
		if err := os.WriteFile(filepath.Join(dir, name), content, 0o600); err != nil {
			return nil, err
		}
	}
	result, err := git.Raw(dir, []string{"merge-file", "--union", "-p",
		filepath.Join(dir, "ours"), filepath.Join(dir, "base"), filepath.Join(dir, "theirs")})
	if err != nil {
		return nil, err
	}
	// merge-file exits with the number of conflicts; errors are negative, i.e. >= 128 here.
	if result.Code >= 128 || result.Code < 0 {
		return nil, fmt.Errorf("git merge-file failed: %s", result.Stderr)
	}
	return result.Stdout, nil
}

// Text is a three-way line merge that never produces conflict markers and never loses a line. A
// missing final newline is added so the last lines of the two sides can't glue together.
func Text(base, ours, theirs []byte) ([]byte, error) {
	if bytes.Equal(ours, theirs) || bytes.Equal(base, theirs) {
		return ours, nil
	}
	if bytes.Equal(base, ours) {
		return theirs, nil
	}
	b, o, t := splitLines(string(base)), splitLines(string(ours)), splitLines(string(theirs))
	oursHunks, oursOK := diff(b, o)
	theirsHunks, theirsOK := diff(b, t)
	if !oursOK || !theirsOK {
		return gitUnionMerge(joinLines(b), joinLines(o), joinLines(t))
	}
	return joinLines(mergeLines(b, oursHunks, theirsHunks)), nil
}
