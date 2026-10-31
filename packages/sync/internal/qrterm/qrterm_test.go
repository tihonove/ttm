package qrterm

import (
	"strings"
	"testing"

	"rsc.io/qr"
)

// undraw turns the terminal picture back into modules, margin included.
func undraw(t *testing.T, picture string) [][]bool {
	t.Helper()
	var dark [][]bool
	for _, line := range strings.Split(strings.TrimSuffix(picture, "\n"), "\n") {
		body, ok := strings.CutPrefix(line, colors)
		if !ok {
			t.Fatalf("line without colours: %q", line)
		}
		body, ok = strings.CutSuffix(body, reset)
		if !ok {
			t.Fatalf("line without reset: %q", line)
		}
		var top, bottom []bool
		for _, cell := range body {
			top = append(top, cell == ' ' || cell == '▄')
			bottom = append(bottom, cell == ' ' || cell == '▀')
		}
		dark = append(dark, top, bottom)
	}
	return dark
}

func TestRenderKeepsEveryModule(t *testing.T) {
	const text = "ttm://pair?server=https%3A%2F%2Fttm.tihonove.dev&token=secret"
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		t.Fatal(err)
	}
	picture, err := Render(text)
	if err != nil {
		t.Fatal(err)
	}
	dark := undraw(t, picture)
	// Scanners need a blank margin; two modules on every side.
	const margin = 2
	full := code.Size + 2*margin
	// A QR code has an odd size, so the last character row is half outside the picture.
	if len(dark) != full+1 || len(dark[0]) != full {
		t.Fatalf("picture is %dx%d, want %dx%d", len(dark[0]), len(dark), full, full+1)
	}
	for y := range full {
		for x := range full {
			inside := x >= margin && y >= margin && x < code.Size+margin && y < code.Size+margin
			want := inside && code.Black(x-margin, y-margin)
			if dark[y][x] != want {
				t.Fatalf("module %d,%d: dark=%t, want %t", x, y, dark[y][x], want)
			}
		}
	}
}

func TestRenderRejectsTextTooLongForAQRCode(t *testing.T) {
	if _, err := Render(strings.Repeat("x", 5000)); err == nil {
		t.Fatal("expected an error")
	}
}
