package proto

import (
	"bufio"
	"bytes"
	"fmt"
	"strings"
	"testing"
)

func TestFrames(t *testing.T) {
	var b bytes.Buffer
	big := bytes.Repeat([]byte("x"), MaxFrame+10)
	if err := WriteFrame(&b, Stdout, []byte("hi")); err != nil {
		t.Fatal(err)
	}
	if err := WriteFrame(&b, Data, big); err != nil {
		t.Fatal(err)
	}
	k, p, err := ReadFrame(&b, nil)
	if err != nil || k != Stdout || string(p) != "hi" {
		t.Fatal(k, p, err)
	}
	total := 0
	for total < len(big) {
		k, p, err = ReadFrame(&b, nil)
		if err != nil || k != Data {
			t.Fatal(err)
		}
		total += len(p)
	}
}

func TestRequestAuth(t *testing.T) {
	var b bytes.Buffer
	_ = WriteRequest(&b, Request{Op: "ping", Token: "t1"})
	if _, err := ReadRequest(bufio.NewReader(bytes.NewReader(b.Bytes())), "t2"); err == nil || !strings.Contains(err.Error(), "unauthorized") {
		t.Fatal("wrong token accepted")
	}
	req, err := ReadRequest(bufio.NewReader(bytes.NewReader(b.Bytes())), "t1")
	if err != nil || req.Op != "ping" {
		t.Fatal(err)
	}
	if _, err := ReadRequest(bufio.NewReader(strings.NewReader("{}\n")), ""); err == nil {
		t.Fatal("empty token accepted")
	}
}

func TestRequestLineLimit(t *testing.T) {
	// A tar request for 50k paths, over the old 4 MiB limit, is read whole.
	paths := make([]string, 50000)
	for i := range paths {
		paths[i] = fmt.Sprintf("/home/user/projects/app/node_modules/@scope/package-name-%d/dist/components/module-file-%d.js", i/100, i%100)
	}
	var b bytes.Buffer
	_ = WriteRequest(&b, Request{Op: "tar", Token: "t", Paths: paths})
	if b.Len() <= 4<<20 {
		t.Fatalf("request is only %d bytes", b.Len())
	}
	req, err := ReadRequest(bufio.NewReader(bytes.NewReader(b.Bytes())), "t")
	if err != nil || len(req.Paths) != len(paths) || req.Paths[49999] != paths[49999] {
		t.Fatalf("%v (%d paths)", err, len(req.Paths))
	}
	// Past the limit: refused, and the error says what the limit is.
	line := append(bytes.Repeat([]byte("x"), 2049), '\n')
	if _, err := readLine(bufio.NewReaderSize(bytes.NewReader(line), 16), 2048); err == nil || err.Error() != "request line too long (over 2048 bytes)" {
		t.Fatalf("got %v", err)
	}
	if got, err := readLine(bufio.NewReaderSize(bytes.NewReader(line[1:]), 16), 2048); err != nil || len(got) != 2048 {
		t.Fatalf("a line at the limit: %v (%d bytes)", err, len(got))
	}
	if MaxRequestLine != 64<<20 {
		t.Fatalf("MaxRequestLine is %d", MaxRequestLine)
	}
}
