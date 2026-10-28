package contracts

import "embed"

// FS holds the frozen public contract assets owned by the Go control plane.
//
//go:embed error-codes.json error-messages.json
var FS embed.FS
