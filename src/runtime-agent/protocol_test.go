package main

import (
	"bufio"
	"bytes"
	"strings"
	"testing"
)

func TestFramingLimitAndReplay(t *testing.T) {
	var got map[string]any
	if err := readFrame(bufio.NewReader(strings.NewReader("{\"id\":7}\n")), &got); err != nil || got["id"] != float64(7) {
		t.Fatalf("valid frame: %#v, %v", got, err)
	}
	if err := readFrame(bufio.NewReader(strings.NewReader(strings.Repeat("x", maxMessage)+"\n")), &got); err == nil {
		t.Fatal("oversize frame accepted")
	}

	s := newStateStore()
	unit := "dockerd"
	s.record(event{Type: "event", Name: "unit-started", Unit: &unit, UptimeMS: 4}, "starting")
	s.record(event{Type: "event", Name: "unit-ready", Unit: &unit, UptimeMS: 8}, "ready")
	s.record(event{Type: "event", Name: "docker-ready", UptimeMS: 9}, "")
	replay := s.replay()
	if len(replay) != 2 || replay[0].Name != "unit-ready" || replay[1].Name != "docker-ready" {
		t.Fatalf("bad replay: %#v", replay)
	}
	var out bytes.Buffer
	if err := writeFrame(&out, replay[1]); err != nil || out.Bytes()[out.Len()-1] != '\n' {
		t.Fatalf("bad frame: %q, %v", out.String(), err)
	}
}
