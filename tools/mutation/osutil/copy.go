// Package osutil replaces github.com/zimmski/osutil for go-mutesting, which only needs CopyFile:
// the real module calls syscall.Dup2 and does not build on linux/arm64.
package osutil

import (
	"io"
	"os"
)

// CopyFile copies src to dst, keeping the permission bits of src.
func CopyFile(src string, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
