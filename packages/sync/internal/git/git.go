// Package git runs the git binary.
package git

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

type Result struct {
	Code   int
	Stdout []byte
	Stderr string
}

// Error is a git command that exited non-zero.
type Error struct {
	Args   []string
	Result Result
}

func (e *Error) Error() string {
	return fmt.Sprintf("git %s exited with %d: %s", strings.Join(e.Args, " "), e.Result.Code, strings.TrimSpace(e.Result.Stderr))
}

// Raw runs git and reports its exit code; the error is only for git that could not run at all.
// env is added on top of the process environment.
func Raw(cwd string, args []string, env ...string) (Result, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	cmd.Env = append(append(os.Environ(), "LC_ALL=C", "GIT_TERMINAL_PROMPT=0"), env...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	result := Result{Stdout: stdout.Bytes(), Stderr: stderr.String()}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		result.Code = exit.ExitCode()
		return result, nil
	}
	if err != nil {
		return result, fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return result, nil
}

// Run runs git and returns stdout without trailing whitespace; a non-zero exit is an *Error.
func Run(cwd string, args []string, env ...string) (string, error) {
	result, err := Raw(cwd, args, env...)
	if err != nil {
		return "", err
	}
	if result.Code != 0 {
		return "", &Error{Args: args, Result: result}
	}
	return strings.TrimRight(string(result.Stdout), " \t\r\n"), nil
}

// ResolveRef returns the object id a ref points to, or "" when the ref does not exist.
func ResolveRef(cwd, ref string) (string, error) {
	result, err := Raw(cwd, []string{"rev-parse", "--verify", "--quiet", ref + "^{commit}"})
	// --quiet prints nothing on failure, so the result is "" either way.
	// mutator-disable-next-line expression/remove
	if err != nil || result.Code != 0 {
		return "", err
	}
	return strings.TrimSpace(string(result.Stdout)), nil
}

// ConfigEnv passes config to a single git invocation via env, so nothing (e.g. a token) lands in
// .git/config.
func ConfigEnv(entries [][2]string) []string {
	env := []string{"GIT_CONFIG_COUNT=" + strconv.Itoa(len(entries))}
	for i, entry := range entries {
		env = append(env,
			"GIT_CONFIG_KEY_"+strconv.Itoa(i)+"="+entry[0],
			"GIT_CONFIG_VALUE_"+strconv.Itoa(i)+"="+entry[1],
		)
	}
	return env
}
