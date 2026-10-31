// Package qrterm draws QR codes in a terminal.
package qrterm

import (
	"strings"

	"rsc.io/qr"
)

// quietZone is the blank margin around the code, in modules; scanners need it.
const quietZone = 2

// light-on-dark colours are set explicitly, so the code scans on any terminal theme.
const (
	colors = "\x1b[97;40m"
	reset  = "\x1b[0m"
)

// Render draws text as a QR code, two modules per character cell.
func Render(text string) (string, error) {
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	// A QR code has an odd size and y moves in even steps from an even start, so y never equals the bound.
	// mutator-disable-next-line expression/comparison
	for y := -quietZone; y < code.Size+quietZone; y += 2 {
		out.WriteString(colors)
		for x := -quietZone; x < code.Size+quietZone; x++ {
			// Black is false outside the code, which draws the quiet zone.
			switch top, bottom := !code.Black(x, y), !code.Black(x, y+1); {
			case top && bottom:
				out.WriteRune('█')
			case top:
				out.WriteRune('▀')
			case bottom:
				out.WriteRune('▄')
			default:
				out.WriteRune(' ')
			}
		}
		out.WriteString(reset + "\n")
	}
	return out.String(), nil
}
