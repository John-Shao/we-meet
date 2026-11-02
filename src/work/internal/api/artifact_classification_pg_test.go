package api_test

import (
	"net/http"
	"testing"
)

// Migration 0017 made work.artifact_version.classification NOT NULL with deliberately no
// DEFAULT - its own comment is that "§4.1 forbids 'missing means most permissive', because a
// local_only version that forgot its classification would otherwise read as exfiltrable" - and
// then justified that against the R0a side by claiming "every existing R0a publisher (
// publish_artifact and create_user_artifact_version) writes a cloud body" and that a BEFORE
// INSERT trigger means "the shipped commands need no rewrite". That claim is about the endpoint
// this line shipped (POST /work/v1/artifacts/{artifactId}/versions), and no test on either side
// checked it: grepping remote_excerpt_allowed across the test tree turned up only the R0b
// local-policy payload keys, which are a different thing.
//
// Both directions are pinned here. What an R0a user produces: a published version is a cloud
// body carrying the one legal cloud classification, with no local fields invented, and the
// version it followed is untouched. What must stay closed: a local_only row that forgot its
// classification is refused rather than defaulted.

const (
	classArtifact = "61111111-1111-4111-8111-777777777777"
	classTaskID   = "11111111-1111-4111-8111-222222222222" // Task B: open, no run
)

// versionFacts reads what the classification rules actually decide about one version.
func versionFacts(t *testing.T, dbName string, versionNo int) string {
	t.Helper()
	return opsScalar(t, dbName, `
		SELECT coalesce(location, '-') || '/' || coalesce(classification, '-') || '/' ||
		       coalesce(local_ref, '-') || '/' || coalesce(device_id::text, '-') || '/' ||
		       state || '/' || (content_ref IS NOT NULL)::text
		FROM work.artifact_version
		WHERE artifact_id = $1::uuid AND version_no = $2`, classArtifact, versionNo)
}

func TestPublishedArtifactVersionCarriesTheCloudClassification(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	store := newTestContentStore(t)
	avSeedArtifact(t, dbName, classTaskID, classArtifact, store, "# 第一版")

	// The seeded version already went through the same BEFORE INSERT classifier, so it is the
	// control for "publishing again must not rewrite the row behind it".
	first := versionFacts(t, dbName, 1)

	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)
	response := taskRequest(t, http.MethodPost, avVersionsURL(server.URL, classArtifact),
		token, avBody("aversion-classify-01", 1, "# 第二版"))
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("publish status = %d body=%s", response.StatusCode, readBody(response))
	}
	response.Body.Close()

	// Read the stored row rather than the response: classification is a persistence
	// invariant and the endpoint's payload does not carry it.
	second := versionFacts(t, dbName, 2)
	if second != "cloud/remote_excerpt_allowed/-/-/published/true" {
		t.Fatalf("published version = %q, want a cloud body classified as "+
			"remote_excerpt_allowed, no local_ref or device_id invented, published, and a "+
			"content reference present", second)
	}
	if after := versionFacts(t, dbName, 1); after != first {
		t.Fatalf("the version behind it changed while publishing the next one:\n before %s\n after  %s",
			first, after)
	}
	if count := opsScalar(t, dbName, `
		SELECT count(*)::text FROM work.artifact_version
		WHERE artifact_id = $1::uuid AND classification IS NULL`, classArtifact); count != "0" {
		t.Fatalf("versions without a classification = %s, want 0", count)
	}
}

func TestLocalOnlyVersionWithoutClassificationIsRefused(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	store := newTestContentStore(t)
	avSeedArtifact(t, dbName, classTaskID, classArtifact, store, "# 第一版")

	// A device-local body that forgot its classification has to be refused outright. If the
	// cloud trigger were widened to fill a default, or the column given one, this insert would
	// succeed and a local_only version would read as exfiltrable.
	_, err := ownerExec(dbName, `
		INSERT INTO work.artifact_version
		  (artifact_id, org_id, version_no, content_ref, content_hash, bytes,
		   media_type, state, provenance, location, local_ref, device_id)
		VALUES ($1::uuid, 'org_a', 9, NULL, 'sha256:unclassified', 12,
		        'text/markdown', 'staged', '{}'::jsonb, 'local_only',
		        'device/ref/unclassified',
		        '00000000-0000-4000-8000-0000000000d3'::uuid)`, classArtifact)
	if err == nil {
		t.Fatal("an unclassified local_only version was accepted; classification has no " +
			"DEFAULT on purpose")
	}
	pgErr := opsPgError(t, err)
	if pgErr.SQLState() != "23502" {
		t.Fatalf("refusal = %s %q, want 23502 not-null violation on classification",
			pgErr.SQLState(), pgErr.Message)
	}
	if count := opsScalar(t, dbName, `
		SELECT count(*)::text FROM work.artifact_version
		WHERE artifact_id = $1::uuid AND version_no = 9`, classArtifact); count != "0" {
		t.Fatalf("rows after the refusal = %s, want the refused insert to have left nothing", count)
	}
}
