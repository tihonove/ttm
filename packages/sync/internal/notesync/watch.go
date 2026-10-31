package notesync

import (
	"io/fs"
	"os"
	"path/filepath"
	"sync"

	"github.com/fsnotify/fsnotify"
)

// addWatches adds every directory under root except .git.
func addWatches(root string, add func(string) error, log func(string)) {
	filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.IsDir() {
			return nil
		}
		if entry.Name() == ".git" {
			return filepath.SkipDir
		}
		if err := add(path); err != nil {
			log("watch " + path + ": " + err.Error())
		}
		return nil
	})
}

// watchTree calls onChange for edits anywhere under dir except ignoredPath. inotify is not
// recursive, so every directory is watched on its own and new ones are added as they appear; a sync
// follows the Create anyway, which picks up files written before the new watch took hold.
func watchTree(dir string, onChange func(), log func(string)) (closeWatch func(), err error) {
	watcher, err := fsnotify.NewWatcher()
	// Takes running out of inotify instances, a limit of the whole user.
	// mutator-disable-next-line branch/if
	if err != nil {
		return nil, err
	}
	if err := watcher.Add(dir); err != nil {
		// Only a leak on a path that ends the process anyway.
		// mutator-disable-next-line statement/remove
		watcher.Close()
		return nil, err
	}
	addWatches(dir, watcher.Add, log)

	var loop sync.WaitGroup
	loop.Go(func() {
		for {
			select {
			case event, ok := <-watcher.Events:
				// Close shuts both channels, and the Errors case below ends the loop just the same.
				// mutator-disable-next-line branch/if
				if !ok {
					return
				}
				rel, err := filepath.Rel(dir, event.Name)
				if err != nil || ignoredPath(rel) {
					// Leaving the select instead only comes back to the same for.
					// mutator-disable-next-line loop/break
					continue
				}
				if event.Has(fsnotify.Create) {
					if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
						addWatches(event.Name, watcher.Add, log)
					}
				}
				onChange()
			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				log("watcher: " + err.Error())
			}
		}
	})
	return func() {
		watcher.Close()
		loop.Wait()
	}, nil
}
