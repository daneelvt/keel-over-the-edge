// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// prefixed writes each complete line to out with a name in front, so the
// output of several processes stays readable when merged.
type prefixed struct {
	mu     *sync.Mutex
	out    io.Writer
	prefix string
	buf    bytes.Buffer
}

func newPrefixed(mu *sync.Mutex, out io.Writer, name string) *prefixed {
	return &prefixed{mu: mu, out: out, prefix: fmt.Sprintf("%-4s │ ", name)}
}

func (p *prefixed) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.buf.Write(b)
	for {
		line, err := p.buf.ReadBytes('\n')
		if err != nil {
			// An incomplete line waits for the rest.
			p.buf.Reset()
			p.buf.Write(line)
			return len(b), nil
		}
		if _, err := fmt.Fprintf(p.out, "%s%s", p.prefix, line); err != nil {
			return 0, err
		}
	}
}

// proc is a child process run in its own process group, so stopping it also
// stops whatever it started (Vite starts helpers of its own).
type proc struct {
	name string
	cmd  *exec.Cmd
	done chan struct{}
	err  error
}

func startProc(name, dir string, env []string, out io.Writer, argv ...string) (*proc, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdout = out
	cmd.Stderr = out
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("starting %s: %w", name, err)
	}
	p := &proc{name: name, cmd: cmd, done: make(chan struct{})}
	go func() {
		p.err = cmd.Wait()
		close(p.done)
	}()
	return p, nil
}

// stop asks the process group to end, and kills it after timeout.
func (p *proc) stop(timeout time.Duration) {
	select {
	case <-p.done:
		return
	default:
	}
	_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGTERM)
	select {
	case <-p.done:
	case <-time.After(timeout):
		_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
		<-p.done
	}
}

// exitErr describes why a process ended on its own.
func (p *proc) exitErr() error {
	if p.err == nil {
		return fmt.Errorf("%s exited", p.name)
	}
	var ee *exec.ExitError
	if errors.As(p.err, &ee) {
		return fmt.Errorf("%s exited: %s", p.name, ee.ProcessState)
	}
	return fmt.Errorf("%s: %w", p.name, p.err)
}
