package modelparams

import (
	"testing"

	"github.com/we-meet/work/internal/canonical"
)

// TestSignedDefaults pins the values John signed on 2026-10-31. Changing them
// changes the snapshot hash of every new task and needs a new decision.
func TestSignedDefaults(t *testing.T) {
	if DefaultMaxOutputTokens != 1024 {
		t.Fatalf("maxOutputTokens = %d, signed decision is 1024", DefaultMaxOutputTokens)
	}
	if DefaultTemperatureMilli != 0 {
		t.Fatalf("temperatureMilli = %d, signed decision is 0", DefaultTemperatureMilli)
	}
	if got := Default().OutputFormat; got != "markdown" {
		t.Fatalf("outputFormat = %q, signed decision is markdown", got)
	}
}

func TestManifestMirrorsDefaults(t *testing.T) {
	manifest := Manifest()
	if manifest["maxOutputTokens"] != DefaultMaxOutputTokens {
		t.Fatalf("maxOutputTokens = %v", manifest["maxOutputTokens"])
	}
	if manifest["temperatureMilli"] != DefaultTemperatureMilli {
		t.Fatalf("temperatureMilli = %v", manifest["temperatureMilli"])
	}
	if manifest["outputFormat"] != canonical.OutputFormatMarkdown {
		t.Fatalf("outputFormat = %v", manifest["outputFormat"])
	}
	parameters := Default()
	if parameters.MaxOutputTokens != DefaultMaxOutputTokens ||
		parameters.TemperatureMilli != DefaultTemperatureMilli ||
		parameters.OutputFormat != canonical.OutputFormatMarkdown {
		t.Fatalf("default parameters = %+v", parameters)
	}
}
