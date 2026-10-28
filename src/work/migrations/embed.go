package migrations

import "embed"

// FS is the immutable migration asset set compiled into the runner.
//
//go:embed manifest.json baseline
//go:embed all:increments all:catalogs
var FS embed.FS
