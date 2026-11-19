// SPDX-License-Identifier: AGPL-3.0-only

package aboard

import "sync/atomic"

// DefaultNewSailorsPerAddress is how many new sailors one address may make
// in a day until the owner says otherwise.
const DefaultNewSailorsPerAddress = 20

// newSailorSwitches are the owner's settings for new sailors, inside
// Switches.
type newSailorSwitches struct {
	perAddress atomic.Int32
	// checkOff is the human check switched off: the zero value is on.
	checkOff atomic.Bool
}

// NewSailorsPerAddress is how many new sailors one address may make in a
// day; HumanCheck whether every new sailor passes the human check.
func (s *Switches) NewSailorsPerAddress() int     { return int(s.newSailors.perAddress.Load()) }
func (s *Switches) HumanCheck() bool              { return !s.newSailors.checkOff.Load() }
func (s *Switches) SetNewSailorsPerAddress(n int) { s.newSailors.perAddress.Store(int32(n)) }
func (s *Switches) SetHumanCheck(on bool)         { s.newSailors.checkOff.Store(!on) }
