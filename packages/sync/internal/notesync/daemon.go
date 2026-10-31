package notesync

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/tihonove/ttm/packages/sync/internal/git"
)

type DaemonConfig struct {
	Dir  string `json:"dir"`
	Host string `json:"host"`
	// Server is the base URL of the ttm server, e.g. https://ttm.tihonove.dev
	Server string `json:"server"`
	Token  string `json:"-"`
}

const (
	// debounceDelay is the quiet period after the last local edit before committing.
	debounceDelay = 2 * time.Second
	// maxDelay is the upper bound on waiting while edits keep coming.
	maxDelay = 15 * time.Second
	// periodicDelay is a safety net in case an event from the server got lost.
	periodicDelay = 5 * time.Minute
	baseBackoff   = 5 * time.Second
	maxBackoff    = 5 * time.Minute
	// eventsStale: the server pings every 20s; silence this long means the stream is dead.
	eventsStale         = time.Minute
	maxEventsBackoff    = time.Minute
	notifyAfterFailures = 3
)

// networkError matches being offline (or the server restarting), which is normal for a laptop and
// heals by itself, so it is only logged. Anything else — auth, a broken repo — needs a human and is
// notified.
var networkError = regexp.MustCompile(`(?i)could not resolve host|failed to connect|couldn't connect|connection (refused|reset)|timed out|network is unreachable|no route to host|empty reply|recv failure|returned error: 5\d\d`)

func IsNetworkError(err error) bool {
	return networkError.MatchString(err.Error())
}

var tempFile = regexp.MustCompile(`(^\.#|~$|\.swp$|\.swx$|\.tmp$|^\.~lock\.)`)

func AuthEnv(token string) []string {
	basic := base64.StdEncoding.EncodeToString([]byte("ttm:" + token))
	return git.ConfigEnv([][2]string{{"http.extraHeader", "Authorization: Basic " + basic}})
}

func RemoteURL(server string) string {
	return strings.TrimRight(server, "/") + "/git/notes.git"
}

func notifyDesktop(summary, body string) {
	cmd := exec.Command("notify-send", "--app-name=ttm-sync", summary, body)
	// Without the Wait a zombie stays until the daemon exits; nothing else changes.
	// mutator-disable-next-line branch/if
	if cmd.Start() == nil {
		go cmd.Wait()
	}
}

// scheduler runs one sync at a time; requests that arrive meanwhile collapse into a single
// follow-up.
type scheduler struct {
	sync   func() (Result, error)
	log    func(string)
	notify func(summary, body string)
	// Delays, shortened by tests.
	debounce, maxDelay, baseBackoff, maxBackoff time.Duration

	mu             sync.Mutex
	running        bool
	current        chan struct{}
	rerun          bool
	timer          *time.Timer
	firstRequestAt time.Time
	failures       int
	// seriousFailures are those that are not network trouble; past notifyAfterFailures the user is
	// told.
	seriousFailures int
	stopped         bool
}

// debounced is a local edit: wait for a quiet period, but never longer than maxDelay overall.
func (s *scheduler) debounced() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.firstRequestAt.IsZero() {
		s.firstRequestAt = time.Now()
	}
	// Past the deadline this is negative, which a timer takes as "right away".
	s.schedule(min(s.debounce, time.Until(s.firstRequestAt.Add(s.maxDelay))))
}

func (s *scheduler) now() {
	s.mu.Lock()
	defer s.mu.Unlock()
	// A nanosecond either way is still right away.
	// mutator-disable-next-line numbers/decrementer, numbers/incrementer
	s.schedule(0)
}

// stop stops scheduling and returns once a sync in progress has finished.
func (s *scheduler) stop() {
	s.mu.Lock()
	s.stopped = true
	current := s.current
	s.mu.Unlock()
	if current != nil {
		<-current
	}
}

// schedule requires s.mu.
func (s *scheduler) schedule(delay time.Duration) {
	if s.timer != nil {
		s.timer.Stop()
	}
	s.timer = time.AfterFunc(delay, s.run)
}

func (s *scheduler) run() {
	s.mu.Lock()
	s.firstRequestAt = time.Time{}
	// Timers are left to fire after stop(); this is where they end.
	if s.stopped {
		s.mu.Unlock()
		return
	}
	if s.running {
		s.rerun = true
		s.mu.Unlock()
		return
	}
	s.running = true
	done := make(chan struct{})
	s.current = done
	s.mu.Unlock()
	defer close(done)

	result, err := s.sync()

	s.mu.Lock()
	defer s.mu.Unlock()
	s.finish(result, err)
	s.running = false
	if s.rerun {
		s.rerun = false
		// A nanosecond either way is still right away.
		// mutator-disable-next-line numbers/decrementer, numbers/incrementer
		s.schedule(0)
	}
}

// finish requires s.mu.
func (s *scheduler) finish(result Result, err error) {
	if err != nil {
		s.failures++
		backoff := s.backoff()
		s.log(fmt.Sprintf("sync failed (%d in a row, retry in %s): %v", s.failures, backoff, err))
		if !IsNetworkError(err) {
			s.seriousFailures++
			if s.seriousFailures == notifyAfterFailures {
				s.notify("Notes sync is failing", err.Error())
			}
		}
		s.schedule(backoff)
		return
	}
	if result.Committed || result.Merged || result.Pushed {
		s.log(fmt.Sprintf("synced: committed=%t merged=%t pushed=%t", result.Committed, result.Merged, result.Pushed))
	}
	if len(result.ConflictCopies) > 0 {
		s.notify("Notes: conflict copies created", strings.Join(result.ConflictCopies, "\n"))
	}
	if s.seriousFailures >= notifyAfterFailures {
		s.notify("Notes sync restored", "")
	}
	s.failures = 0
	s.seriousFailures = 0
}

// backoff doubles from baseBackoff per failure in a row, up to maxBackoff.
func (s *scheduler) backoff() time.Duration {
	backoff := s.baseBackoff
	// One doubling more is cut back by the min below; the bound only keeps it from overflowing.
	// mutator-disable-next-line expression/comparison
	for i := 1; i < s.failures && backoff < s.maxBackoff; i++ {
		backoff *= 2
	}
	return min(backoff, s.maxBackoff)
}

// eventsClient opens each event stream on a fresh HTTP/1.1 connection: over HTTP/2 the ingress held
// the stream back, and a pooled connection can stay stuck after a failed request.
var eventsClient = &http.Client{Transport: &http.Transport{
	DisableKeepAlives: true,
	TLSNextProto:      map[string]func(string, *tls.Conn) http.RoundTripper{},
}}

// parseHeadEvent returns the head of an SSE message, ok=false when it is another kind of message.
// A nil head means the branch does not exist on the server yet.
func parseHeadEvent(message string) (head *string, ok bool, err error) {
	lines := strings.Split(message, "\n")
	if !slices.Contains(lines, "event: head") {
		return nil, false, nil
	}
	for _, line := range lines {
		if data, found := strings.CutPrefix(line, "data:"); found {
			var payload struct {
				Head *string `json:"head"`
			}
			if err := json.Unmarshal([]byte(data), &payload); err != nil {
				return nil, false, fmt.Errorf("events: bad message: %w", err)
			}
			return payload.Head, true, nil
		}
	}
	return nil, false, nil
}

// readEvents consumes one connection until it fails; alive is called on any sign of life.
func readEvents(ctx context.Context, config DaemonConfig, onHead func(*string), connected, alive func()) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(config.Server, "/")+"/events", nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+config.Token)
	request.Header.Set("Accept", "text/event-stream")
	response, err := eventsClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("events: HTTP %d", response.StatusCode)
	}
	connected()
	var buffer []byte
	chunk := make([]byte, 4096)
	for {
		n, err := response.Body.Read(chunk)
		alive()
		buffer = append(buffer, chunk[:n]...)
		for {
			message, rest, found := bytes.Cut(buffer, []byte("\n\n"))
			if !found {
				break
			}
			buffer = rest
			head, ok, parseErr := parseHeadEvent(string(message))
			if parseErr != nil {
				return parseErr
			}
			if ok {
				onHead(head)
			}
		}
		if err != nil {
			return fmt.Errorf("events: stream ended: %w", err)
		}
	}
}

// FollowServerEvents listens to the server's head events and reports when the branch moves
// elsewhere, reconnecting until ctx is done.
func FollowServerEvents(ctx context.Context, config DaemonConfig, onHead func(*string), log func(string), stale time.Duration) {
	firstBackoff := min(time.Second, stale)
	backoff := firstBackoff
	for ctx.Err() == nil {
		connection, cancel := context.WithCancel(ctx)
		// Armed before the request too: a connection can hang before any response arrives.
		timer := time.AfterFunc(stale, cancel)
		err := readEvents(connection, config, onHead,
			func() { backoff = firstBackoff },
			func() { timer.Reset(stale) },
		)
		// Left alone the timer would only cancel what is over, and that is all this cancel does too.
		// mutator-disable-next-line statement/remove
		timer.Stop()
		// mutator-disable-next-line statement/remove
		cancel()
		if ctx.Err() != nil {
			return
		}
		log(fmt.Sprintf("events stream lost: %v", err))
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = nextEventsBackoff(backoff)
	}
}

func nextEventsBackoff(backoff time.Duration) time.Duration {
	return min(maxEventsBackoff, backoff*2)
}

// syncUnlessCurrent syncs unless head is what we already have: our own push comes back as an event
// too, and there is nothing to fetch then.
func syncUnlessCurrent(dir string, head *string, sync func()) {
	if head != nil {
		if local, err := git.ResolveRef(dir, "HEAD"); err == nil && local == *head {
			return
		}
	}
	sync()
}

// ignoredPath reports changes that must not trigger a sync: git's own files and editor temp files.
func ignoredPath(rel string) bool {
	first, _, _ := strings.Cut(filepath.ToSlash(rel), "/")
	return first == ".git" || tempFile.MatchString(filepath.Base(rel))
}

// RunDaemon watches the notes and the server until the returned stop is called; stop returns once
// a sync in progress has finished.
func RunDaemon(config DaemonConfig, log func(string), driverCommand string) (stop func(), err error) {
	target := &Target{Dir: config.Dir, Host: config.Host, NetworkEnv: AuthEnv(config.Token), Log: log, DriverCommand: driverCommand}
	s := &scheduler{
		sync:     func() (Result, error) { return SyncOnce(target) },
		log:      log,
		notify:   notifyDesktop,
		debounce: debounceDelay, maxDelay: maxDelay, baseBackoff: baseBackoff, maxBackoff: maxBackoff,
	}
	closeWatcher, err := watchTree(config.Dir, s.debounced, log)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	var background sync.WaitGroup
	background.Go(func() {
		FollowServerEvents(ctx, config, func(head *string) { syncUnlessCurrent(config.Dir, head, s.now) }, log, eventsStale)
	})
	background.Go(func() {
		ticker := time.NewTicker(periodicDelay)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.now()
			}
		}
	})
	s.now()
	log(fmt.Sprintf("ttm-sync watching %s as %s, server %s", config.Dir, config.Host, config.Server))

	return func() {
		cancel()
		closeWatcher()
		// These only call the scheduler, which does nothing once stopped, so the order cannot show.
		// mutator-disable-next-line statement/remove
		background.Wait()
		s.stop()
	}, nil
}

// PairURL is what the mobile app scans to connect. Encoded like JS encodeURIComponent, which the app
// decodes with its counterpart.
func PairURL(server, token string) string {
	return "ttm://pair?server=" + strings.ReplaceAll(url.QueryEscape(server), "+", "%20") +
		"&token=" + strings.ReplaceAll(url.QueryEscape(token), "+", "%20")
}
