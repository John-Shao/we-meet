package migrate

import (
	"reflect"
	"sort"
)

type Diff struct {
	SchemaOwner    *StringDiff  `json:"schema_owner,omitempty"`
	Relations      *SectionDiff `json:"relations,omitempty"`
	Columns        *SectionDiff `json:"columns,omitempty"`
	Constraints    *SectionDiff `json:"constraints,omitempty"`
	Indexes        *SectionDiff `json:"indexes,omitempty"`
	Functions      *SectionDiff `json:"functions,omitempty"`
	Views          *SectionDiff `json:"views,omitempty"`
	Triggers       *SectionDiff `json:"triggers,omitempty"`
	Policies       *SectionDiff `json:"policies,omitempty"`
	Grants         *SectionDiff `json:"grants,omitempty"`
	ExpectedSHA256 string       `json:"expected_sha256"`
	ActualSHA256   string       `json:"actual_sha256"`
}

type StringDiff struct {
	Expected string `json:"expected"`
	Actual   string `json:"actual"`
}

type SectionDiff struct {
	Missing []string  `json:"missing,omitempty"`
	Extra   []string  `json:"extra,omitempty"`
	Changed []Changed `json:"changed,omitempty"`
}

type Changed struct {
	Key      string `json:"key"`
	Expected any    `json:"expected"`
	Actual   any    `json:"actual"`
}

func (d *Diff) Empty() bool {
	if d == nil {
		return true
	}
	return d.SchemaOwner == nil &&
		d.Relations == nil && d.Columns == nil && d.Constraints == nil &&
		d.Indexes == nil && d.Functions == nil && d.Views == nil &&
		d.Triggers == nil && d.Policies == nil && d.Grants == nil
}

func (c *Catalog) Diff(actual *Catalog) (*Diff, error) {
	expectedHash, err := c.Hash()
	if err != nil {
		return nil, err
	}
	actualHash, err := actual.Hash()
	if err != nil {
		return nil, err
	}
	diff := &Diff{ExpectedSHA256: expectedHash, ActualSHA256: actualHash}
	if c.SchemaOwner != actual.SchemaOwner {
		diff.SchemaOwner = &StringDiff{Expected: c.SchemaOwner, Actual: actual.SchemaOwner}
	}
	diff.Relations = sectionDiff(c.Relations, actual.Relations, func(v Relation) string { return v.Name })
	diff.Columns = sectionDiff(c.Columns, actual.Columns, func(v Column) string { return v.Table + "." + v.Name })
	diff.Constraints = sectionDiff(c.Constraints, actual.Constraints, func(v Constraint) string { return v.Table + "." + v.Name })
	diff.Indexes = sectionDiff(c.Indexes, actual.Indexes, func(v Index) string { return v.Table + "." + v.Name })
	diff.Functions = sectionDiff(c.Functions, actual.Functions, func(v Function) string {
		return v.Name + "(" + v.IdentityArguments + ")"
	})
	diff.Views = sectionDiff(c.Views, actual.Views, func(v View) string { return v.Name })
	diff.Triggers = sectionDiff(c.Triggers, actual.Triggers, func(v Trigger) string { return v.Table + "." + v.Name })
	diff.Policies = sectionDiff(c.Policies, actual.Policies, func(v Policy) string { return v.Table + "." + v.Name })
	diff.Grants = sectionDiff(c.Grants, actual.Grants, func(v Grant) string {
		return v.ObjectType + "|" + v.Schema + "|" + v.Object + "|" + v.Grantee + "|" + v.Privilege
	})
	return diff, nil
}

func sectionDiff[T any](expected, actual []T, key func(T) string) *SectionDiff {
	want := make(map[string]T, len(expected))
	got := make(map[string]T, len(actual))
	for _, item := range expected {
		want[key(item)] = item
	}
	for _, item := range actual {
		got[key(item)] = item
	}
	out := &SectionDiff{}
	for k, wantItem := range want {
		gotItem, ok := got[k]
		if !ok {
			out.Missing = append(out.Missing, k)
			continue
		}
		if !reflect.DeepEqual(wantItem, gotItem) {
			out.Changed = append(out.Changed, Changed{Key: k, Expected: wantItem, Actual: gotItem})
		}
	}
	for k := range got {
		if _, ok := want[k]; !ok {
			out.Extra = append(out.Extra, k)
		}
	}
	sort.Strings(out.Missing)
	sort.Strings(out.Extra)
	sort.Slice(out.Changed, func(i, j int) bool { return out.Changed[i].Key < out.Changed[j].Key })
	if len(out.Missing) == 0 && len(out.Extra) == 0 && len(out.Changed) == 0 {
		return nil
	}
	return out
}
