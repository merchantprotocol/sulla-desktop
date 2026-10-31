// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

const maxMessage = 64 << 10

type event struct {
	Type     string  `json:"type"`
	Name     string  `json:"name"`
	Unit     *string `json:"unit"`
	UptimeMS int64   `json:"uptimeMs"`
	Detail   string  `json:"detail,omitempty"`
}

type stateStore struct {
	mu     sync.RWMutex
	units  map[string]string
	events map[string]event
}

func newStateStore() *stateStore {
	return &stateStore{units: map[string]string{}, events: map[string]event{}}
}

func (s *stateStore) record(e event, state string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.Unit != nil {
		s.units[*e.Unit] = state
		s.events["unit:"+*e.Unit] = e
	}
	if e.Name == "docker-ready" || e.Name == "shutting-down" || e.Name == "data-disk-failed" {
		s.events[e.Name] = e
	}
}

func (s *stateStore) replay() []event {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]event, 0, len(s.events))
	for _, name := range []string{"containerd", "dockerd"} {
		if e, ok := s.events["unit:"+name]; ok {
			out = append(out, e)
		}
	}
	if e, ok := s.events["data-disk-failed"]; ok {
		out = append(out, e)
	}
	if e, ok := s.events["docker-ready"]; ok {
		out = append(out, e)
	}
	if e, ok := s.events["shutting-down"]; ok {
		out = append(out, e)
	}
	return out
}

func readFrame(r *bufio.Reader, v any) error {
	line, err := r.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) || len(line) > maxMessage {
		return errors.New("message exceeds 64 KiB")
	}
	if err != nil {
		return err
	}
	if len(line) == 1 {
		return errors.New("empty message")
	}
	return json.Unmarshal(line, v)
}

func writeFrame(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(b)+1 > maxMessage {
		return errors.New("message exceeds 64 KiB")
	}
	b = append(b, '\n')
	_, err = w.Write(b)
	return err
}
