// SPDX-License-Identifier: AGPL-3.0-only

package bus

// Certified is what a certificate's judge told a sailor, carried by a
// Certify through the frame's events to the sailor's connection and its
// agent: a task of its next certificate done (Task, the task's place in
// the certificate's list, −1 for none), and the certificate earned
// (Earned, by hand if ByHand). Certificate is the certificate's place in
// the catalog's list; Done of Of the tasks done of those it needs; Way how
// the task counted. Runs of RunsOf are a course task's venture's runs so
// far of those it asks, told while the task is not yet done: RunsOf 0
// for a task done.
type Certified struct {
	Certificate  int16
	Task         int16
	Done, Of     uint8
	Way          uint8
	Runs, RunsOf uint8
	Earned       bool
	ByHand       bool
}

// The ways a task counted, Certified.Way.
const (
	CertLog   uint8 = iota // a task of the log, however it was sailed
	CertHand               // a course sailed with the autopilot off throughout
	CertPilot              // a course's longer venture, the autopilot on at some moment
)
