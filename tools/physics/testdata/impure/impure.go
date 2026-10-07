// Package impure breaks each rule of the physics package once.
package impure

import (
	"fmt"
	"math"
)

var ch chan int

func Bad(x, y, z float64, n int) float64 {
	go func() {}()
	defer fmt.Println()
	m := map[int]int{}
	_ = m
	s := make([]float64, n)
	_ = s
	i := int(x)
	_ = i
	ch <- 1
	z += x * y
	return math.Sin(x) + x*y + z
}
