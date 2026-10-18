// Package proto is the wire format between the host shell client (boxsh)
// and the in-container daemon (boxd).
//
// A connection starts with one JSON line from the client (Request). After
// it, both sides send frames: one type byte, a 4-byte big-endian length,
// then the payload. The daemon ends every operation with an Exit frame.
package proto

import (
	"bufio"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Version is bumped when the wire format changes incompatibly.
const Version = 1

// Frame types.
const (
	Stdout   byte = 'o' // daemon -> client: command stdout
	Stderr   byte = 'e' // daemon -> client: command stderr
	Exit     byte = 'x' // daemon -> client: ExitInfo JSON; last frame
	Data     byte = 'd' // daemon -> client: op payload (tar bytes, JSON)
	Fail     byte = 'E' // daemon -> client: error text; an Exit frame follows
	Signal   byte = 's' // client -> daemon: "TERM", "KILL", "INT", "HUP"
	Stdin    byte = 'i' // client -> daemon: stdin bytes
	StdinEOF byte = 'c' // client -> daemon: stdin closed
)

// MaxFrame bounds one frame's payload.
const MaxFrame = 1 << 20

// MaxRequestLine bounds the first line of a connection (the newline not
// counted). A tar request lists every path a checkpoint copies, ~100-150
// bytes each: 64 MiB is about half a million paths. It was 4 MiB, and boxes
// keep the boxd they were started or created with, so clients split longer
// tar requests themselves and do not rely on this limit.
const MaxRequestLine = 64 << 20

// Request is the first line of a connection.
type Request struct {
	V     int               `json:"v"`
	Token string            `json:"token"`
	Op    string            `json:"op"` // exec | stat | tar | ping
	Argv  []string          `json:"argv,omitempty"`
	Cwd   string            `json:"cwd,omitempty"`
	Env   map[string]string `json:"env,omitempty"`
	Paths []string          `json:"paths,omitempty"`
	// Wait: for exec, how long (ms) to wait for a running snapshot to end.
	Wait int `json:"wait,omitempty"`
	// Root: exec as root instead of the box's command user (the launcher's
	// own setup steps; the shell client never sets it).
	Root bool `json:"root,omitempty"`
}

// ExitInfo ends an operation.
type ExitInfo struct {
	Code   int    `json:"code"`
	Signal string `json:"signal,omitempty"`
	// Ms is the daemon-side wall time of the operation.
	Ms float64 `json:"ms"`
	// WaitedMs is the time an exec waited for a snapshot to finish.
	WaitedMs float64 `json:"waited_ms,omitempty"`
}

// StatEntry describes one path for the snapshot diff.
type StatEntry struct {
	Path    string `json:"path"`
	Type    string `json:"type"` // file | dir | symlink | other | missing
	Mode    uint32 `json:"mode,omitempty"`
	Size    int64  `json:"size,omitempty"`
	MtimeNs int64  `json:"mtime_ns,omitempty"`
	CtimeNs int64  `json:"ctime_ns,omitempty"`
	Ino     uint64 `json:"ino,omitempty"`
	Nlink   uint64 `json:"nlink,omitempty"`
	UID     uint32 `json:"uid"`
	GID     uint32 `json:"gid"`
	Link    string `json:"link,omitempty"`
}

// WriteFrame writes one frame.
func WriteFrame(w io.Writer, kind byte, payload []byte) error {
	for len(payload) > MaxFrame {
		if err := WriteFrame(w, kind, payload[:MaxFrame]); err != nil {
			return err
		}
		payload = payload[MaxFrame:]
	}
	var head [5]byte
	head[0] = kind
	binary.BigEndian.PutUint32(head[1:], uint32(len(payload)))
	if _, err := w.Write(head[:]); err != nil {
		return err
	}
	if len(payload) == 0 {
		return nil
	}
	_, err := w.Write(payload)
	return err
}

// ReadFrame reads one frame. buf is reused when large enough.
func ReadFrame(r io.Reader, buf []byte) (byte, []byte, error) {
	var head [5]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(head[1:])
	if n > MaxFrame {
		return 0, nil, fmt.Errorf("frame too large: %d", n)
	}
	if cap(buf) < int(n) {
		buf = make([]byte, n)
	}
	buf = buf[:n]
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	return head[0], buf, nil
}

// WriteRequest sends the first line.
func WriteRequest(w io.Writer, req Request) error {
	req.V = Version
	line, err := json.Marshal(req)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	_, err = w.Write(line)
	return err
}

// ReadRequest reads the first line (bounded) and checks the token.
func ReadRequest(r *bufio.Reader, token string) (Request, error) {
	var req Request
	line, err := readLine(r, MaxRequestLine)
	if err != nil {
		return req, err
	}
	if err := json.Unmarshal(line, &req); err != nil {
		return req, fmt.Errorf("bad request: %w", err)
	}
	if req.V != Version {
		return req, fmt.Errorf("protocol version %d, want %d", req.V, Version)
	}
	if token == "" || subtle.ConstantTimeCompare([]byte(req.Token), []byte(token)) != 1 {
		return req, errors.New("unauthorized")
	}
	return req, nil
}

func readLine(r *bufio.Reader, max int) ([]byte, error) {
	var out []byte
	for {
		chunk, isPrefix, err := r.ReadLine()
		if err != nil {
			return nil, err
		}
		out = append(out, chunk...)
		if len(out) > max {
			return nil, fmt.Errorf("request line too long (over %d bytes)", max)
		}
		if !isPrefix {
			return out, nil
		}
	}
}
