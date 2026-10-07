// Package fused has a product Go fuses into one instruction on arm64 and on
// amd64 with GOAMD64=v3, and one it may not.
package fused

func Fused(x, y, z float64) float64 { return x*y + z }

func Separate(x, y, z float64) float64 { return float64(x*y) + z }
