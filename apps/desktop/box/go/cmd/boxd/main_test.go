//go:build linux

package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"omnirush.ai/box/proto"
)

func startDaemon(t *testing.T) (config, string) {
	t.Helper()
	dir := t.TempDir()
	cfg := config{token: "tok", uid: 0, home: dir, root: dir, shell: "/bin/sh", baseEnv: []string{"PATH=/usr/bin:/bin", "SECRET_FROM_HOST=1"}}
	cfg.uid = os.Getuid()
	cfg.gid = os.Getgid()
	if cfg.uid != 0 {
		cfg.uid, cfg.gid = 0, 0 // run commands as ourselves (no setuid in tests)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go serve(cfg, c)
		}
	}()
	return cfg, ln.Addr().String()
}

type result struct {
	out, err string
	data     []byte
	exit     proto.ExitInfo
}

func call(t *testing.T, addr string, req proto.Request, during func(net.Conn)) result {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	req.Token = "tok"
	_ = proto.WriteRequest(c, req)
	_ = proto.WriteFrame(c, proto.StdinEOF, nil)
	if during != nil {
		go during(c)
	}
	r := bufio.NewReader(c)
	var res result
	for {
		k, p, err := proto.ReadFrame(r, nil)
		if err != nil {
			t.Fatal(err)
		}
		switch k {
		case proto.Stdout:
			res.out += string(p)
		case proto.Stderr, proto.Fail:
			res.err += string(p)
		case proto.Data:
			res.data = append(res.data, p...)
		case proto.Exit:
			_ = json.Unmarshal(p, &res.exit)
			return res
		}
	}
}

func TestExec(t *testing.T) {
	cfg, addr := startDaemon(t)
	res := call(t, addr, proto.Request{Op: "exec", Argv: []string{"/bin/sh", "-c", "echo out; echo err >&2; echo $HOME; echo ${SECRET_FROM_HOST:-none}; echo $TURNX; pwd; exit 3"}, Cwd: "/nonexistent", Env: map[string]string{"TURNX": "7"}}, nil)
	if res.exit.Code != 3 {
		t.Fatalf("code %d", res.exit.Code)
	}
	lines := strings.Split(strings.TrimSpace(res.out), "\n")
	if lines[0] != "out" || lines[1] != cfg.home || lines[3] != "7" || lines[4] != cfg.root {
		t.Fatalf("%q", res.out)
	}
	if res.err != "err\n" {
		t.Fatalf("stderr %q", res.err)
	}
	_ = lines[2] // base env passes through (image ENV)
}

func TestSignal(t *testing.T) {
	_, addr := startDaemon(t)
	start := time.Now()
	res := call(t, addr, proto.Request{Op: "exec", Argv: []string{"/bin/sh", "-c", "sleep 30"}}, func(c net.Conn) {
		time.Sleep(200 * time.Millisecond)
		_ = proto.WriteFrame(c, proto.Signal, []byte("TERM"))
	})
	if time.Since(start) > 5*time.Second || res.exit.Code != 143 {
		t.Fatalf("code %d after %v", res.exit.Code, time.Since(start))
	}
}

func TestBackgroundChildDoesNotHold(t *testing.T) {
	_, addr := startDaemon(t)
	start := time.Now()
	res := call(t, addr, proto.Request{Op: "exec", Argv: []string{"/bin/sh", "-c", "sleep 20 & echo started"}}, nil)
	if time.Since(start) > 3*time.Second || !strings.Contains(res.out, "started") {
		t.Fatalf("took %v out %q", time.Since(start), res.out)
	}
}

func TestStatAndTar(t *testing.T) {
	_, addr := startDaemon(t)
	dir := t.TempDir()
	a := filepath.Join(dir, "a.txt")
	_ = os.WriteFile(a, []byte("hello"), 0o644)
	_ = os.Link(a, filepath.Join(dir, "hard"))
	_ = os.Symlink("a.txt", filepath.Join(dir, "link"))
	_ = os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	paths := []string{filepath.Join(dir, "link"), a, filepath.Join(dir, "hard"), filepath.Join(dir, "sub"), filepath.Join(dir, "gone")}
	res := call(t, addr, proto.Request{Op: "stat", Paths: paths}, nil)
	var st []proto.StatEntry
	if err := json.Unmarshal(res.data, &st); err != nil || len(st) != 5 || st[4].Type != "missing" || st[0].Type != "symlink" || st[1].Size != 5 {
		t.Fatalf("%v %s", err, res.data)
	}
	res = call(t, addr, proto.Request{Op: "tar", Paths: paths}, nil)
	if res.exit.Code != 0 {
		t.Fatalf("tar failed %s", res.err)
	}
	tr := tar.NewReader(bytes.NewReader(res.data))
	kinds := map[string]byte{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		kinds[filepath.Base(strings.TrimSuffix(h.Name, "/"))] = h.Typeflag
		if strings.HasPrefix(h.Name, "/") {
			t.Fatal("absolute member", h.Name)
		}
	}
	if kinds["a.txt"] != tar.TypeReg || kinds["hard"] != tar.TypeLink || kinds["link"] != tar.TypeSymlink || kinds["sub"] != tar.TypeDir || len(kinds) != 4 {
		t.Fatalf("%v", kinds)
	}
}

// The host client (src/box/client.js tarTo) splits a long path list into
// several tar requests and joins their output into one file: it drops the
// last 1024 bytes (archive/tar's two zero end blocks, no record padding) of
// every tar but the last. This checks boxd's tar ends exactly that way.
func TestTarEnd(t *testing.T) {
	_, addr := startDaemon(t)
	dir := t.TempDir()
	var first, second []string
	for i := 0; i < 6; i++ {
		p := filepath.Join(dir, fmt.Sprintf("f%d.txt", i))
		_ = os.WriteFile(p, bytes.Repeat([]byte{'a' + byte(i)}, 700*i+1), 0o644)
		if i < 3 {
			first = append(first, p)
		} else {
			second = append(second, p)
		}
	}
	one := call(t, addr, proto.Request{Op: "tar", Paths: first}, nil)
	two := call(t, addr, proto.Request{Op: "tar", Paths: second}, nil)
	for _, res := range []result{one, two} {
		if res.exit.Code != 0 || len(res.data)%512 != 0 || len(res.data) < 1024 || !bytes.Equal(res.data[len(res.data)-1024:], make([]byte, 1024)) {
			t.Fatalf("code %d, %d bytes, tail not two zero blocks", res.exit.Code, len(res.data))
		}
	}
	// Only the end blocks are zero blocks at a header position: the last
	// member's data ends right before them.
	joined := append(append([]byte(nil), one.data[:len(one.data)-1024]...), two.data...)
	tr := tar.NewReader(bytes.NewReader(joined))
	var names []string
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(tr)
		if len(data) != int(h.Size) {
			t.Fatalf("%s: %d of %d bytes", h.Name, len(data), h.Size)
		}
		names = append(names, filepath.Base(h.Name))
	}
	if strings.Join(names, ",") != "f0.txt,f1.txt,f2.txt,f3.txt,f4.txt,f5.txt" {
		t.Fatalf("members %v", names)
	}
}

func TestBadToken(t *testing.T) {
	_, addr := startDaemon(t)
	c, _ := net.Dial("tcp", addr)
	defer c.Close()
	_ = proto.WriteRequest(c, proto.Request{Op: "exec", Token: "nope", Argv: []string{"/bin/true"}})
	k, p, err := proto.ReadFrame(bufio.NewReader(c), nil)
	if err != nil || k != proto.Fail || !strings.Contains(string(p), "unauthorized") {
		t.Fatal(k, string(p), err)
	}
}

func TestSkipper(t *testing.T) {
	skip := skipper([]string{"/proc", "/root/.cache"}, []string{"/root/.cache/ms-playwright"})
	for p, want := range map[string]bool{"/proc": true, "/proc/1": true, "/root/.cache": false, "/root/.cache/pip": true, "/root/.cache/ms-playwright": false, "/root/.cache/ms-playwright/x": false, "/root/.cachex": false, "/usr": false} {
		if got := skip(p); got != want {
			t.Errorf("%s: %v", p, got)
		}
	}
}
