// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// workers step boats on several goroutines. Each worker is woken through
// its own channel and the tick waits for them on a WaitGroup; both are made
// with the world, so a test's synctest bubble includes them.
type workers struct {
	w      *World
	wake   []chan struct{}
	ranges [][]int32 // per worker, the slots to step this tick
	outs   []physics.Out
	wg     sync.WaitGroup
	exited sync.WaitGroup
	used   int
}

// minRange is the fewest boats worth waking a worker for: waking one costs a
// few microseconds, a step about one.
const minRange = 32

func (ws *workers) start(w *World, n int) {
	ws.w = w
	ws.ranges = make([][]int32, n)
	ws.outs = make([]physics.Out, n)
	for i := 1; i < n; i++ {
		ch := make(chan struct{}, 1)
		ws.wake = append(ws.wake, ch)
		ws.exited.Add(1)
		go ws.run(i, ch)
	}
}

func (ws *workers) run(i int, wake <-chan struct{}) {
	defer ws.exited.Done()
	for range wake {
		ws.w.stepSlots(ws.ranges[i], &ws.outs[i])
		ws.wg.Done()
	}
}

func (ws *workers) stop() {
	for _, ch := range ws.wake {
		close(ch)
	}
	ws.wake = nil
	ws.exited.Wait()
}

// step steps the slots listed, split into contiguous ranges of at least
// minRange between as many workers as there are such ranges. Each boat's
// step reads only its own state and the world's wind, so the split never
// changes the result.
func (ws *workers) step(slots []int32) {
	n := min(len(ws.ranges), len(slots)/minRange)
	if n <= 1 {
		ws.used = 1
		ws.w.stepSlots(slots, &ws.outs[0])
		return
	}
	ws.used = n
	for i := range n {
		ws.ranges[i] = slots[i*len(slots)/n : (i+1)*len(slots)/n]
	}
	ws.wg.Add(n - 1)
	for i := 1; i < n; i++ {
		ws.wake[i-1] <- struct{}{}
	}
	ws.w.stepSlots(ws.ranges[0], &ws.outs[0])
	ws.wg.Wait()
	for i := range n {
		ws.ranges[i] = nil
	}
}
