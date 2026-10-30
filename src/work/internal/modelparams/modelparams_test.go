package modelparams

import (
	"testing"

	"github.com/we-meet/work/internal/canonical"
)

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
