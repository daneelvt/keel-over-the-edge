// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"fmt"
	"runtime"
	"sync"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// BenchmarkWorkers steps fleets of boats with the real step: on the tick's
// goroutine alone, on the world's long-lived workers, and on goroutines
// started for each tick, the alternative the workers were chosen over.
//
//	go test -run '^$' -bench Workers ./internal/sim
func BenchmarkWorkers(b *testing.B) {
	procs := runtime.GOMAXPROCS(0)
	for _, boats := range []int{1, 10, 100, 1000, 3000} {
		for _, n := range []int{1, 3, procs} {
			if n > procs {
				continue
			}
			w := newWorld(b, Capacity, n)
			fill(b, w, boats, 1)
			w.next = w.Latest()
			w.env = physics.Env{WindSpeed: DefaultWind.Speed}
			live := w.next.Live
			b.Run(fmt.Sprintf("boats=%d/pool=%d", boats, n), func(b *testing.B) {
				b.ReportAllocs()
				for b.Loop() {
					w.workers.step(live)
				}
			})
			if n == 1 {
				continue
			}
			outs := make([]physics.Out, n)
			b.Run(fmt.Sprintf("boats=%d/spawn=%d", boats, n), func(b *testing.B) {
				b.ReportAllocs()
				for b.Loop() {
					k := max(1, min(n, len(live)/minRange))
					var wg sync.WaitGroup
					for i := 1; i < k; i++ {
						lo, hi := i*len(live)/k, (i+1)*len(live)/k
						wg.Go(func() { w.stepSlots(live[lo:hi], &outs[i]) })
					}
					w.stepSlots(live[:len(live)/k], &outs[0])
					wg.Wait()
				}
			})
		}
	}
}
