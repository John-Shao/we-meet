package migrate

import "testing"

func TestCatalogDiffEmptyForIdenticalCatalogs(t *testing.T) {
	expected := testCatalog()
	actual := testCatalog()
	diff, err := expected.Diff(actual)
	if err != nil {
		t.Fatal(err)
	}
	if !diff.Empty() {
		t.Fatalf("diff = %#v, want empty", diff)
	}
	if diff.ExpectedSHA256 != diff.ActualSHA256 {
		t.Fatalf("hashes differ: %s vs %s", diff.ExpectedSHA256, diff.ActualSHA256)
	}
}

func TestCatalogDiffReportsChangedMissingAndExtra(t *testing.T) {
	expected := testCatalog()
	actual := testCatalog()
	actual.Relations[0].Owner = "someone_else"
	actual.Relations = append(actual.Relations, Relation{Name: "extra_table", Kind: "r", Owner: "work_owner"})
	actual.Columns = nil
	actual.Grants = nil

	diff, err := expected.Diff(actual)
	if err != nil {
		t.Fatal(err)
	}
	if diff.Empty() {
		t.Fatal("diff is empty")
	}
	if diff.Relations == nil || len(diff.Relations.Changed) != 1 || diff.Relations.Changed[0].Key != "task" {
		t.Fatalf("relations diff = %#v", diff.Relations)
	}
	if len(diff.Relations.Extra) != 1 || diff.Relations.Extra[0] != "extra_table" {
		t.Fatalf("relations extra = %#v", diff.Relations.Extra)
	}
	if diff.Columns == nil || len(diff.Columns.Missing) != 1 {
		t.Fatalf("columns diff = %#v", diff.Columns)
	}
	if diff.Grants == nil || len(diff.Grants.Missing) != 1 {
		t.Fatalf("grants diff = %#v", diff.Grants)
	}
}

func testCatalog() *Catalog {
	return &Catalog{
		SchemaOwner: "work_owner",
		Relations:   []Relation{{Name: "task", Kind: "r", Owner: "work_owner", RLS: true, ForceRLS: true}},
		Columns: []Column{{
			Table: "task", Name: "id", Position: 1, DataType: "uuid", UDTSchema: "pg_catalog", UDTName: "uuid",
			Nullable: "NO", Identity: "NO", Generated: "NEVER",
		}},
		Grants: []Grant{{
			ObjectType: "schema", Schema: "work", Object: "work", Grantee: "work_owner",
			Privilege: "USAGE", Grantable: true,
		}},
	}
}
