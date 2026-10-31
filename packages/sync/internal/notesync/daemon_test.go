package notesync

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestIsNetworkError(t *testing.T) {
	for _, message := range []string{
		"fatal: unable to access 'https://ttm.tihonove.dev/git/notes.git/': Could not resolve host: ttm.tihonove.dev",
		"fatal: unable to access 'https://x/': Failed to connect to x port 443 after 3 ms: Couldn't connect to server",
		"fatal: unable to access 'https://x/': Connection timed out after 30001 milliseconds",
		"fatal: unable to access 'https://x/': The requested URL returned error: 502",
		"error: RPC failed; curl 56 Recv failure: Connection reset by peer",
		"connection refused", "Network is unreachable", "No route to host", "Empty reply from server",
	} {
		if !IsNetworkError(errors.New(message)) {
			t.Errorf("should be a network error: %s", message)
		}
	}
	for _, message := range []string{
		"fatal: unable to access 'https://x/': The requested URL returned error: 401",
		"fatal: unable to access 'https://x/': The requested URL returned error: 404",
		"a rebase is in progress in the notes repo; finish or abort it by hand",
	} {
		if IsNetworkError(errors.New(message)) {
			t.Errorf("should be a real failure: %s", message)
		}
	}
}

func TestRemoteURL(t *testing.T) {
	for _, server := range []string{"https://x.dev", "https://x.dev/", "https://x.dev///"} {
		if got := RemoteURL(server); got != "https://x.dev/git/notes.git" {
			t.Errorf("%s: got %q", server, got)
		}
	}
}

func TestPairURL(t *testing.T) {
	got := PairURL("https://x.dev/a b", "t&k=1 2")
	want := "ttm://pair?server=https%3A%2F%2Fx.dev%2Fa%20b&token=t%26k%3D1%202"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestAuthEnv(t *testing.T) {
	env := AuthEnv("secret")
	if env[0] != "GIT_CONFIG_COUNT=1" || env[1] != "GIT_CONFIG_KEY_0=http.extraHeader" {
		t.Fatalf("got %v", env)
	}
	// "ttm:secret" in base64.
	if env[2] != "GIT_CONFIG_VALUE_0=Authorization: Basic dHRtOnNlY3JldA==" {
		t.Fatalf("got %q", env[2])
	}
}

func TestIgnoredPath(t *testing.T) {
	for path, want := range map[string]bool{
		".git": true, ".git/index": true, ".#Home.md": true, "sub/.#Home.md": true, "Home.md~": true,
		"a.swp": true, "a.swx": true, "a.tmp": true, ".~lock.x#": true,
		"Home.md": false, "sub/Home.md": false, ".github/x": false, "a#b": false, "a.tmp.md": false, "x.~lock.y": false,
	} {
		if got := ignoredPath(path); got != want {
			t.Errorf("%s: got %t, want %t", path, got, want)
		}
	}
}

func TestParseHeadEvent(t *testing.T) {
	head, ok, err := parseHeadEvent("event: head\ndata: {\"head\":\"abc\"}")
	if err != nil || !ok || head == nil || *head != "abc" {
		t.Fatalf("got %v %t %v", head, ok, err)
	}
	head, ok, err = parseHeadEvent("event: head\ndata: {\"head\":null}")
	if err != nil || !ok || head != nil {
		t.Fatalf("null head: %v %t %v", head, ok, err)
	}
	if _, ok, err := parseHeadEvent("event: other\ndata: {\"head\":\"abc\"}"); ok || err != nil {
		t.Fatalf("another event: %t %v", ok, err)
	}
	if _, ok, err := parseHeadEvent(": ping"); ok || err != nil {
		t.Fatalf("ping: %t %v", ok, err)
	}
	if _, ok, err := parseHeadEvent("event: head"); ok || err != nil {
		t.Fatalf("no data: %t %v", ok, err)
	}
	if _, _, err := parseHeadEvent("event: head\ndata: nope"); err == nil {
		t.Fatal("bad json must be an error")
	}
}

// waitFor polls until cond holds; timing-sensitive daemon code has nothing better to wait on.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

type recorder struct {
	mu   sync.Mutex
	logs []string
}

func (r *recorder) log(message string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.logs = append(r.logs, message)
}

func (r *recorder) has(part string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, line := range r.logs {
		if strings.Contains(line, part) {
			return true
		}
	}
	return false
}

func TestFollowEventsReconnectsWhenARequestHangs(t *testing.T) {
	var requests atomic.Int32
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The first request is accepted and never answered, like an ingress during a redeploy.
		if requests.Add(1) == 1 {
			<-release
			return
		}
		if r.Header.Get("Authorization") != "Bearer t" || r.Header.Get("Accept") != "text/event-stream" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, ": ping\n\nevent: head\ndata: {\"head\":\"abc\"}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	defer close(release)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := make(chan string, 1)
	log := &recorder{}
	go FollowServerEvents(ctx, DaemonConfig{Server: server.URL + "/", Token: "t"}, func(head *string) { got <- *head }, log.log, 200*time.Millisecond)
	select {
	case head := <-got:
		if head != "abc" {
			t.Fatalf("got %q", head)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no event")
	}
	if requests.Load() != 2 {
		t.Fatalf("requests: %d", requests.Load())
	}
	if !log.has("events stream lost") {
		t.Fatalf("log: %v", log.logs)
	}
}

func TestFollowEventsKeepsAliveOnPings(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		for {
			fmt.Fprint(w, ": ping\n\n")
			w.(http.Flusher).Flush()
			select {
			case <-r.Context().Done():
				return
			case <-time.After(30 * time.Millisecond):
			}
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	log := &recorder{}
	go func() {
		FollowServerEvents(ctx, DaemonConfig{Server: server.URL}, func(*string) {}, log.log, 150*time.Millisecond)
		close(done)
	}()
	time.Sleep(500 * time.Millisecond)
	if got := requests.Load(); got != 1 {
		t.Fatalf("a stream with pings must stay connected, got %d requests", got)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("did not stop on cancel")
	}
	if log.has("events stream lost") {
		t.Fatalf("stopping is not losing the stream: %v", log.logs)
	}
}

func TestFollowEventsReportsHTTPErrorsAndBacksOff(t *testing.T) {
	var mu sync.Mutex
	var times []time.Time
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		times = append(times, time.Now())
		mu.Unlock()
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := &recorder{}
	go FollowServerEvents(ctx, DaemonConfig{Server: server.URL}, func(*string) {}, log.log, 50*time.Millisecond)
	waitFor(t, "three attempts", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(times) >= 3
	})
	if !log.has("events: HTTP 403") {
		t.Fatalf("log: %v", log.logs)
	}
	mu.Lock()
	defer mu.Unlock()
	if first, second := times[1].Sub(times[0]), times[2].Sub(times[1]); first < 50*time.Millisecond || second < 100*time.Millisecond {
		t.Fatalf("backoff did not grow: %s then %s", first, second)
	}
}

func TestFollowEventsBackoffResetsAfterConnecting(t *testing.T) {
	var mu sync.Mutex
	var times []time.Time
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		times = append(times, time.Now())
		mu.Unlock()
		// Connects fine and ends at once, so every round starts from the first backoff.
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go FollowServerEvents(ctx, DaemonConfig{Server: server.URL}, func(*string) {}, func(string) {}, 100*time.Millisecond)
	waitFor(t, "four attempts", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(times) >= 4
	})
	mu.Lock()
	defer mu.Unlock()
	// Without the reset the third gap would be 400ms; the server answers instantly otherwise.
	if gap := times[3].Sub(times[2]); gap > 350*time.Millisecond {
		t.Fatalf("backoff kept growing: %s", gap)
	}
}

func TestFollowEventsSurvivesABadMessageAndSplitChunks(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			fmt.Fprint(w, "event: head\ndata: nope\n\n")
			return
		}
		for _, part := range []string{"event: he", "ad\ndata: {\"head\":\"x", "yz\"}\n", "\nevent: head\ndata: {\"head\":\"q\"}\n\n"} {
			fmt.Fprint(w, part)
			w.(http.Flusher).Flush()
			time.Sleep(5 * time.Millisecond)
		}
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := make(chan string, 2)
	log := &recorder{}
	go FollowServerEvents(ctx, DaemonConfig{Server: server.URL}, func(head *string) { got <- *head }, log.log, 5*time.Second)
	for _, want := range []string{"xyz", "q"} {
		select {
		case head := <-got:
			if head != want {
				t.Fatalf("got %q, want %q", head, want)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("no event %q", want)
		}
	}
	if !log.has("events: bad message") {
		t.Fatalf("log: %v", log.logs)
	}
}

func TestFollowEventsStopsWhileWaitingToReconnect(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	log := &recorder{}
	go func() {
		FollowServerEvents(ctx, DaemonConfig{Server: "http://127.0.0.1:1"}, func(*string) {}, log.log, time.Hour)
		close(done)
	}()
	waitFor(t, "a failed attempt", func() bool { return log.has("events stream lost") })
	cancel()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("kept waiting out the backoff after cancel")
	}
}

func TestFollowEventsBadServerURL(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := &recorder{}
	go FollowServerEvents(ctx, DaemonConfig{Server: "http://bad host"}, func(*string) {}, log.log, time.Second)
	waitFor(t, "the error", func() bool { return log.has("events stream lost") })
}

type schedulerProbe struct {
	s       *scheduler
	log     *recorder
	mu      sync.Mutex
	runs    int
	results []func() (Result, error)
	notes   []string
}

func newSchedulerProbe() *schedulerProbe {
	p := &schedulerProbe{log: &recorder{}}
	p.s = &scheduler{
		sync: func() (Result, error) {
			p.mu.Lock()
			p.runs++
			var next func() (Result, error)
			if len(p.results) > 0 {
				next, p.results = p.results[0], p.results[1:]
			}
			p.mu.Unlock()
			if next != nil {
				return next()
			}
			return Result{}, nil
		},
		log: p.log.log,
		notify: func(summary, body string) {
			p.mu.Lock()
			defer p.mu.Unlock()
			p.notes = append(p.notes, summary+"|"+body)
		},
		debounce: 30 * time.Millisecond, maxDelay: 100 * time.Millisecond,
		baseBackoff: 5 * time.Millisecond, maxBackoff: 20 * time.Millisecond,
	}
	return p
}

func (p *schedulerProbe) runCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.runs
}

func (p *schedulerProbe) notifications() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.notes...)
}

func TestSchedulerDebounceCollapsesEdits(t *testing.T) {
	p := newSchedulerProbe()
	defer p.s.stop()
	p.s.debounced()
	time.Sleep(10 * time.Millisecond)
	p.s.debounced()
	time.Sleep(10 * time.Millisecond)
	if p.runCount() != 0 {
		t.Fatal("ran before the quiet period")
	}
	waitFor(t, "the sync", func() bool { return p.runCount() == 1 })
	time.Sleep(60 * time.Millisecond)
	if got := p.runCount(); got != 1 {
		t.Fatalf("edits must collapse into one sync, got %d", got)
	}
}

func TestSchedulerMaxDelayBoundsContinuousEdits(t *testing.T) {
	p := newSchedulerProbe()
	defer p.s.stop()
	start := time.Now()
	for p.runCount() == 0 {
		if time.Since(start) > 2*time.Second {
			t.Fatal("constant edits starved the sync")
		}
		p.s.debounced()
		time.Sleep(5 * time.Millisecond)
	}
	if elapsed := time.Since(start); elapsed < 90*time.Millisecond {
		t.Fatalf("ran after only %s", elapsed)
	}
}

func TestSchedulerRequestsDuringASyncCollapseIntoOneFollowUp(t *testing.T) {
	p := newSchedulerProbe()
	defer p.s.stop()
	started := make(chan struct{})
	release := make(chan struct{})
	p.results = []func() (Result, error){func() (Result, error) {
		close(started)
		<-release
		return Result{}, nil
	}}
	p.s.now()
	<-started
	p.s.now()
	time.Sleep(10 * time.Millisecond)
	p.s.now()
	time.Sleep(10 * time.Millisecond)
	if got := p.runCount(); got != 1 {
		t.Fatalf("syncs overlapped: %d", got)
	}
	close(release)
	waitFor(t, "the follow-up", func() bool { return p.runCount() == 2 })
	time.Sleep(30 * time.Millisecond)
	if got := p.runCount(); got != 2 {
		t.Fatalf("expected a single follow-up, got %d syncs", got)
	}
}

func TestSchedulerStopWaitsForRunningSyncAndCancelsTimers(t *testing.T) {
	p := newSchedulerProbe()
	started := make(chan struct{})
	release := make(chan struct{})
	p.results = []func() (Result, error){func() (Result, error) {
		close(started)
		<-release
		return Result{}, nil
	}}
	p.s.now()
	<-started
	stopped := make(chan struct{})
	go func() {
		p.s.stop()
		close(stopped)
	}()
	select {
	case <-stopped:
		t.Fatal("stop did not wait for the running sync")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	<-stopped
	p.s.now()
	p.s.debounced()
	time.Sleep(50 * time.Millisecond)
	if got := p.runCount(); got != 1 {
		t.Fatalf("ran after stop: %d", got)
	}
}

func TestSchedulerStopCancelsAPendingTimer(t *testing.T) {
	p := newSchedulerProbe()
	p.s.debounced()
	p.s.stop()
	time.Sleep(60 * time.Millisecond)
	if got := p.runCount(); got != 0 {
		t.Fatalf("ran after stop: %d", got)
	}
}

func TestSchedulerRunAfterStopDoesNothing(t *testing.T) {
	p := newSchedulerProbe()
	p.s.stop()
	p.s.run()
	if got := p.runCount(); got != 0 {
		t.Fatalf("ran after stop: %d", got)
	}
	released := make(chan struct{})
	go func() {
		p.s.stop()
		close(released)
	}()
	select {
	case <-released:
	case <-time.After(5 * time.Second):
		t.Fatal("run kept the scheduler locked")
	}
}

func TestSchedulerRetriesAfterFailure(t *testing.T) {
	p := newSchedulerProbe()
	defer p.s.stop()
	failure := func() (Result, error) { return Result{}, errors.New("Could not resolve host: x") }
	p.results = []func() (Result, error){failure, failure}
	p.s.now()
	waitFor(t, "retries", func() bool { return p.runCount() == 3 })
	if !p.log.has("sync failed (1 in a row, retry in 5ms): Could not resolve host: x") {
		t.Fatalf("log: %v", p.log.logs)
	}
	if !p.log.has("sync failed (2 in a row, retry in 10ms)") {
		t.Fatalf("log: %v", p.log.logs)
	}
	if notes := p.notifications(); len(notes) != 0 {
		t.Fatalf("network trouble must not notify: %v", notes)
	}
}

func TestSchedulerBackoff(t *testing.T) {
	s := &scheduler{baseBackoff: 5 * time.Second, maxBackoff: 5 * time.Minute}
	for failures, want := range map[int]time.Duration{
		1: 5 * time.Second, 2: 10 * time.Second, 3: 20 * time.Second, 7: 5 * time.Minute, 1000: 5 * time.Minute,
	} {
		s.failures = failures
		if got := s.backoff(); got != want {
			t.Errorf("%d failures: got %s, want %s", failures, got, want)
		}
	}
}

func TestSchedulerNotifiesOnceAfterThreeSeriousFailuresAndOnRecovery(t *testing.T) {
	p := newSchedulerProbe()
	defer p.s.stop()
	failure := func() (Result, error) { return Result{}, errors.New("HTTP 401") }
	for _, failures := range []int{3, 4} {
		p.mu.Lock()
		p.notes, p.runs = nil, 0
		p.results = slices.Repeat([]func() (Result, error){failure}, failures)
		p.mu.Unlock()
		p.s.now()
		waitFor(t, "recovery", func() bool { return p.runCount() > failures && len(p.notifications()) >= 2 })
		time.Sleep(10 * time.Millisecond)
		notes := p.notifications()
		if len(notes) != 2 || notes[0] != "Notes sync is failing|HTTP 401" || notes[1] != "Notes sync restored|" {
			t.Fatalf("%d failures: got %v", failures, notes)
		}
	}
}

func TestSchedulerNoRecoveryNoticeBelowTheThreshold(t *testing.T) {
	p := newSchedulerProbe()
	defer p.s.stop()
	failure := func() (Result, error) { return Result{}, errors.New("HTTP 401") }
	p.results = []func() (Result, error){failure, failure}
	p.s.now()
	waitFor(t, "recovery", func() bool { return p.runCount() == 3 })
	time.Sleep(20 * time.Millisecond)
	if notes := p.notifications(); len(notes) != 0 {
		t.Fatalf("got %v", notes)
	}
}

func TestSchedulerSuccessResetsFailureCounters(t *testing.T) {
	p := newSchedulerProbe()
	defer p.s.stop()
	failure := func() (Result, error) { return Result{}, errors.New("HTTP 401") }
	ok := func() (Result, error) { return Result{}, nil }
	// Two failures, a success, two failures: never three in a row, so nobody is told; and the retry
	// after the success starts from the first backoff again.
	p.results = []func() (Result, error){failure, failure, ok}
	p.s.now()
	waitFor(t, "the success", func() bool { return p.runCount() == 3 })
	time.Sleep(5 * time.Millisecond)
	p.mu.Lock()
	p.results = []func() (Result, error){failure, failure, ok}
	p.mu.Unlock()
	p.s.now()
	waitFor(t, "the second success", func() bool { return p.runCount() == 6 })
	time.Sleep(20 * time.Millisecond)
	if notes := p.notifications(); len(notes) != 0 {
		t.Fatalf("got %v", notes)
	}
	p.log.mu.Lock()
	defer p.log.mu.Unlock()
	if got := p.log.logs[len(p.log.logs)-1]; !strings.Contains(got, "(2 in a row") {
		t.Fatalf("last log: %q", got)
	}
}

func TestSchedulerReportsResults(t *testing.T) {
	p := newSchedulerProbe()
	defer p.s.stop()
	p.results = []func() (Result, error){func() (Result, error) {
		return Result{Committed: true, Pushed: true, ConflictCopies: []string{"a", "b"}}, nil
	}}
	p.s.now()
	waitFor(t, "the notification", func() bool { return len(p.notifications()) == 1 })
	if got := p.notifications()[0]; got != "Notes: conflict copies created|a\nb" {
		t.Fatalf("got %q", got)
	}
	if !p.log.has("synced: committed=true merged=false pushed=true") {
		t.Fatalf("log: %v", p.log.logs)
	}
	p.s.now()
	waitFor(t, "an idle sync", func() bool { return p.runCount() == 2 })
	time.Sleep(10 * time.Millisecond)
	p.log.mu.Lock()
	defer p.log.mu.Unlock()
	if len(p.log.logs) != 1 {
		t.Fatalf("an idle sync must stay silent: %v", p.log.logs)
	}
}

func TestWatchTree(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".git", "objects"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "existing"), 0o777); err != nil {
		t.Fatal(err)
	}
	var changes atomic.Int32
	closeWatch, err := watchTree(dir, func() { changes.Add(1) }, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	defer closeWatch()
	put := func(rel string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, rel), []byte("x"), 0o666); err != nil {
			t.Fatal(err)
		}
	}
	expectChange := func(what string, action func()) {
		t.Helper()
		// Late events of the previous step must not pass for this one.
		time.Sleep(50 * time.Millisecond)
		before := changes.Load()
		action()
		waitFor(t, what, func() bool { return changes.Load() > before })
	}
	expectChange("a file at the top", func() { put("Home.md") })
	expectChange("a file in an existing directory", func() { put("existing/a.md") })
	expectChange("a new directory", func() {
		if err := os.MkdirAll(filepath.Join(dir, "new", "deep"), 0o777); err != nil {
			t.Fatal(err)
		}
	})
	time.Sleep(50 * time.Millisecond)
	expectChange("a file in a new nested directory", func() { put("new/deep/a.md") })

	time.Sleep(50 * time.Millisecond)
	before := changes.Load()
	put(".git/index")
	put(".git/objects/x")
	put("a.swp")
	put("existing/.#a.md")
	time.Sleep(100 * time.Millisecond)
	if got := changes.Load(); got != before {
		t.Fatalf("git and temp files triggered %d changes", got-before)
	}
}

func TestWatchTreeMissingDir(t *testing.T) {
	if _, err := watchTree(filepath.Join(t.TempDir(), "missing"), func() {}, func(string) {}); err == nil {
		t.Fatal("expected an error")
	}
}

func TestRunDaemonMissingDir(t *testing.T) {
	if _, err := RunDaemon(DaemonConfig{Dir: filepath.Join(t.TempDir(), "missing")}, func(string) {}, "true"); err == nil {
		t.Fatal("expected an error")
	}
}

// Two daemons against one event server: an edit on a reaches b without any polling.
func TestDaemonsSyncAnEditThroughServerEvents(t *testing.T) {
	w := makeWorld(t, "a", "b")
	a, b := w.machines["a"], w.machines["b"]
	var mu sync.Mutex
	var subscribers []chan string
	server := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		events := make(chan string, 10)
		mu.Lock()
		subscribers = append(subscribers, events)
		mu.Unlock()
		rw.WriteHeader(http.StatusOK)
		rw.(http.Flusher).Flush()
		for {
			select {
			case head := <-events:
				fmt.Fprintf(rw, "event: head\ndata: {\"head\":%q}\n\n", head)
				rw.(http.Flusher).Flush()
			case <-r.Context().Done():
				return
			}
		}
	}))
	defer server.Close()
	log := &recorder{}
	start := func(target *Target) func() {
		stop, err := RunDaemon(DaemonConfig{Dir: target.Dir, Host: target.Host, Server: server.URL, Token: "t"}, log.log, target.DriverCommand)
		if err != nil {
			t.Fatal(err)
		}
		return stop
	}
	stopA, stopB := start(a), start(b)
	defer stopA()
	defer stopB()
	if !log.has("ttm-sync watching " + a.Dir + " as a, server " + server.URL) {
		t.Fatalf("log: %v", log.logs)
	}
	waitFor(t, "subscribers", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(subscribers) == 2
	})
	write(t, a, "Home.md", "- from a\n")
	waitFor(t, "the push", func() bool {
		out, err := os.Stat(filepath.Join(w.remote, "refs", "heads", "main"))
		return err == nil && out.Size() > 0
	})
	head := strings.TrimSpace(read(t, &Target{Dir: w.remote}, "refs/heads/main"))
	mu.Lock()
	for _, events := range subscribers {
		events <- head
	}
	mu.Unlock()
	waitFor(t, "the edit on b", func() bool {
		data, err := os.ReadFile(filepath.Join(b.Dir, "Home.md"))
		return err == nil && string(data) == "- from a\n"
	})
}
