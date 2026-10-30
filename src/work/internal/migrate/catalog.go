package migrate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
)

type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type Catalog struct {
	SchemaOwner string       `json:"schema_owner"`
	Relations   []Relation   `json:"relations"`
	Columns     []Column     `json:"columns"`
	Constraints []Constraint `json:"constraints"`
	Indexes     []Index      `json:"indexes"`
	Functions   []Function   `json:"functions"`
	Views       []View       `json:"views"`
	Triggers    []Trigger    `json:"triggers"`
	Policies    []Policy     `json:"policies"`
	Grants      []Grant      `json:"grants"`
}

type Relation struct {
	Name            string `json:"name"`
	Kind            string `json:"kind"`
	Owner           string `json:"owner"`
	RLS             bool   `json:"rls"`
	ForceRLS        bool   `json:"force_rls"`
	ReplicaIdentity string `json:"replica_identity"`
}

type Column struct {
	Table                string `json:"table"`
	Name                 string `json:"name"`
	Position             int    `json:"position"`
	DataType             string `json:"data_type"`
	UDTSchema            string `json:"udt_schema"`
	UDTName              string `json:"udt_name"`
	Nullable             string `json:"nullable"`
	Default              string `json:"default"`
	Identity             string `json:"identity"`
	IdentityGeneration   string `json:"identity_generation"`
	Generated            string `json:"generated"`
	GenerationExpression string `json:"generation_expression"`
}

type Constraint struct {
	Table      string `json:"table"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Deferrable bool   `json:"deferrable"`
	Deferred   bool   `json:"deferred"`
	Validated  bool   `json:"validated"`
	Definition string `json:"definition"`
}

type Index struct {
	Table      string `json:"table"`
	Name       string `json:"name"`
	Definition string `json:"definition"`
	Valid      bool   `json:"valid"`
	Ready      bool   `json:"ready"`
	Live       bool   `json:"live"`
}

type Function struct {
	Name              string `json:"name"`
	IdentityArguments string `json:"identity_arguments"`
	Arguments         string `json:"arguments"`
	Result            string `json:"result"`
	Language          string `json:"language"`
	Volatility        string `json:"volatility"`
	SecurityDefiner   bool   `json:"security_definer"`
	Leakproof         bool   `json:"leakproof"`
	Strict            bool   `json:"strict"`
	Parallel          string `json:"parallel"`
	Owner             string `json:"owner"`
	Configuration     string `json:"configuration"`
	Definition        string `json:"definition"`
}

type View struct {
	Name       string `json:"name"`
	Definition string `json:"definition"`
}

type Trigger struct {
	Table      string `json:"table"`
	Name       string `json:"name"`
	Enabled    string `json:"enabled"`
	Definition string `json:"definition"`
}

type Policy struct {
	Table      string   `json:"table"`
	Name       string   `json:"name"`
	Permissive string   `json:"permissive"`
	Roles      []string `json:"roles"`
	Command    string   `json:"command"`
	Qual       string   `json:"qual"`
	WithCheck  string   `json:"with_check"`
}

type Grant struct {
	ObjectType string `json:"object_type"`
	Schema     string `json:"schema"`
	Object     string `json:"object"`
	Grantee    string `json:"grantee"`
	Privilege  string `json:"privilege"`
	Grantable  bool   `json:"grantable"`
}

func ReadCatalog(ctx context.Context, q Querier) (*Catalog, error) {
	catalog := &Catalog{
		Relations:   []Relation{},
		Columns:     []Column{},
		Constraints: []Constraint{},
		Indexes:     []Index{},
		Functions:   []Function{},
		Views:       []View{},
		Triggers:    []Trigger{},
		Policies:    []Policy{},
		Grants:      []Grant{},
	}

	if err := q.QueryRow(ctx, `SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'work'`).Scan(&catalog.SchemaOwner); err != nil {
		if err == pgx.ErrNoRows {
			return nil, newError("work_schema_missing", "schema work does not exist")
		}
		return nil, newError("catalog_read_failed", "read schema owner: %v", err)
	}

	relations, err := q.Query(ctx, `
		SELECT c.relname, c.relkind::text, pg_get_userbyid(c.relowner),
		       c.relrowsecurity, c.relforcerowsecurity, c.relreplident::text
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'work'
		  AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
		  AND c.relname <> 'schema_migration'
		ORDER BY c.relname`)
	if err != nil {
		return nil, newError("catalog_read_failed", "read relations: %v", err)
	}
	for relations.Next() {
		var item Relation
		if err := relations.Scan(&item.Name, &item.Kind, &item.Owner, &item.RLS, &item.ForceRLS, &item.ReplicaIdentity); err != nil {
			relations.Close()
			return nil, newError("catalog_read_failed", "scan relation: %v", err)
		}
		catalog.Relations = append(catalog.Relations, item)
	}
	if err := relations.Err(); err != nil {
		relations.Close()
		return nil, newError("catalog_read_failed", "read relations: %v", err)
	}
	relations.Close()

	columns, err := q.Query(ctx, `
		SELECT table_name, column_name, ordinal_position, data_type, udt_schema, udt_name,
		       is_nullable, coalesce(column_default, ''), is_identity,
		       coalesce(identity_generation, ''), is_generated,
		       coalesce(generation_expression, '')
		FROM information_schema.columns
		WHERE table_schema = 'work' AND table_name <> 'schema_migration'
		ORDER BY table_name, ordinal_position`)
	if err != nil {
		return nil, newError("catalog_read_failed", "read columns: %v", err)
	}
	for columns.Next() {
		var item Column
		if err := columns.Scan(
			&item.Table, &item.Name, &item.Position, &item.DataType, &item.UDTSchema, &item.UDTName,
			&item.Nullable, &item.Default, &item.Identity, &item.IdentityGeneration,
			&item.Generated, &item.GenerationExpression,
		); err != nil {
			columns.Close()
			return nil, newError("catalog_read_failed", "scan column: %v", err)
		}
		catalog.Columns = append(catalog.Columns, item)
	}
	if err := columns.Err(); err != nil {
		columns.Close()
		return nil, newError("catalog_read_failed", "read columns: %v", err)
	}
	columns.Close()

	constraints, err := q.Query(ctx, `
		SELECT r.relname, c.conname, c.contype::text, c.condeferrable, c.condeferred,
		       c.convalidated, pg_get_constraintdef(c.oid, true)
		FROM pg_constraint c
		JOIN pg_class r ON r.oid = c.conrelid
		JOIN pg_namespace n ON n.oid = r.relnamespace
		WHERE n.nspname = 'work' AND r.relname <> 'schema_migration'
		ORDER BY r.relname, c.conname`)
	if err != nil {
		return nil, newError("catalog_read_failed", "read constraints: %v", err)
	}
	for constraints.Next() {
		var item Constraint
		if err := constraints.Scan(
			&item.Table, &item.Name, &item.Type, &item.Deferrable, &item.Deferred,
			&item.Validated, &item.Definition,
		); err != nil {
			constraints.Close()
			return nil, newError("catalog_read_failed", "scan constraint: %v", err)
		}
		catalog.Constraints = append(catalog.Constraints, item)
	}
	if err := constraints.Err(); err != nil {
		constraints.Close()
		return nil, newError("catalog_read_failed", "read constraints: %v", err)
	}
	constraints.Close()

	indexes, err := q.Query(ctx, `
		SELECT t.relname, i.relname, pg_get_indexdef(i.oid), x.indisvalid, x.indisready, x.indislive
		FROM pg_index x
		JOIN pg_class i ON i.oid = x.indexrelid
		JOIN pg_class t ON t.oid = x.indrelid
		JOIN pg_namespace n ON n.oid = t.relnamespace
		WHERE n.nspname = 'work' AND t.relname <> 'schema_migration'
		ORDER BY t.relname, i.relname`)
	if err != nil {
		return nil, newError("catalog_read_failed", "read indexes: %v", err)
	}
	for indexes.Next() {
		var item Index
		if err := indexes.Scan(&item.Table, &item.Name, &item.Definition, &item.Valid, &item.Ready, &item.Live); err != nil {
			indexes.Close()
			return nil, newError("catalog_read_failed", "scan index: %v", err)
		}
		catalog.Indexes = append(catalog.Indexes, item)
	}
	if err := indexes.Err(); err != nil {
		indexes.Close()
		return nil, newError("catalog_read_failed", "read indexes: %v", err)
	}
	indexes.Close()

	functions, err := q.Query(ctx, `
		SELECT p.proname, pg_get_function_identity_arguments(p.oid),
		       pg_get_function_arguments(p.oid), pg_get_function_result(p.oid),
		       l.lanname, p.provolatile::text, p.prosecdef, p.proleakproof,
		       p.proisstrict, p.proparallel::text, pg_get_userbyid(p.proowner),
		       coalesce(array_to_string(p.proconfig, ','), ''), coalesce(p.prosrc, '')
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		JOIN pg_language l ON l.oid = p.prolang
		WHERE n.nspname = 'work'
		ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)`)
	if err != nil {
		return nil, newError("catalog_read_failed", "read functions: %v", err)
	}
	for functions.Next() {
		var item Function
		if err := functions.Scan(
			&item.Name, &item.IdentityArguments, &item.Arguments, &item.Result,
			&item.Language, &item.Volatility, &item.SecurityDefiner, &item.Leakproof,
			&item.Strict, &item.Parallel, &item.Owner, &item.Configuration, &item.Definition,
		); err != nil {
			functions.Close()
			return nil, newError("catalog_read_failed", "scan function: %v", err)
		}
		catalog.Functions = append(catalog.Functions, item)
	}
	if err := functions.Err(); err != nil {
		functions.Close()
		return nil, newError("catalog_read_failed", "read functions: %v", err)
	}
	functions.Close()

	views, err := q.Query(ctx, `
		SELECT c.relname, pg_get_viewdef(c.oid, true)
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'work' AND c.relkind IN ('v', 'm')
		ORDER BY c.relname`)
	if err != nil {
		return nil, newError("catalog_read_failed", "read views: %v", err)
	}
	for views.Next() {
		var item View
		if err := views.Scan(&item.Name, &item.Definition); err != nil {
			views.Close()
			return nil, newError("catalog_read_failed", "scan view: %v", err)
		}
		catalog.Views = append(catalog.Views, item)
	}
	if err := views.Err(); err != nil {
		views.Close()
		return nil, newError("catalog_read_failed", "read views: %v", err)
	}
	views.Close()

	triggers, err := q.Query(ctx, `
		SELECT c.relname, t.tgname, t.tgenabled::text, pg_get_triggerdef(t.oid, true)
		FROM pg_trigger t
		JOIN pg_class c ON c.oid = t.tgrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'work' AND NOT t.tgisinternal AND c.relname <> 'schema_migration'
		ORDER BY c.relname, t.tgname`)
	if err != nil {
		return nil, newError("catalog_read_failed", "read triggers: %v", err)
	}
	for triggers.Next() {
		var item Trigger
		if err := triggers.Scan(&item.Table, &item.Name, &item.Enabled, &item.Definition); err != nil {
			triggers.Close()
			return nil, newError("catalog_read_failed", "scan trigger: %v", err)
		}
		catalog.Triggers = append(catalog.Triggers, item)
	}
	if err := triggers.Err(); err != nil {
		triggers.Close()
		return nil, newError("catalog_read_failed", "read triggers: %v", err)
	}
	triggers.Close()

	policies, err := q.Query(ctx, `
		SELECT tablename, policyname, permissive, roles::text[], cmd,
		       coalesce(qual, ''), coalesce(with_check, '')
		FROM pg_policies
		WHERE schemaname = 'work' AND tablename <> 'schema_migration'
		ORDER BY tablename, policyname`)
	if err != nil {
		return nil, newError("catalog_read_failed", "read policies: %v", err)
	}
	for policies.Next() {
		var item Policy
		if err := policies.Scan(
			&item.Table, &item.Name, &item.Permissive, &item.Roles,
			&item.Command, &item.Qual, &item.WithCheck,
		); err != nil {
			policies.Close()
			return nil, newError("catalog_read_failed", "scan policy: %v", err)
		}
		sort.Strings(item.Roles)
		catalog.Policies = append(catalog.Policies, item)
	}
	if err := policies.Err(); err != nil {
		policies.Close()
		return nil, newError("catalog_read_failed", "read policies: %v", err)
	}
	policies.Close()

	grants, err := q.Query(ctx, `
		SELECT object_type, schema_name, object_name, grantee, privilege_type, is_grantable
		FROM (
			SELECT 'relation' AS object_type, n.nspname AS schema_name, c.relname AS object_name,
			       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
			       a.privilege_type, a.is_grantable
			FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			CROSS JOIN LATERAL aclexplode(c.relacl) a
			WHERE n.nspname = 'work' AND c.relname <> 'schema_migration'
			UNION ALL
			SELECT 'column', n.nspname, c.relname || '.' || a.attname,
			       CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
			       x.privilege_type, x.is_grantable
			FROM pg_attribute a
			JOIN pg_class c ON c.oid = a.attrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			CROSS JOIN LATERAL aclexplode(a.attacl) x
			WHERE n.nspname = 'work' AND c.relkind IN ('r', 'p')
			  AND NOT a.attisdropped AND a.attacl IS NOT NULL
			UNION ALL
			SELECT 'function', n.nspname,
			       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
			       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
			       a.privilege_type, a.is_grantable
			FROM pg_proc p
			JOIN pg_namespace n ON n.oid = p.pronamespace
			CROSS JOIN LATERAL aclexplode(p.proacl) a
			WHERE n.nspname = 'work'
			UNION ALL
			SELECT 'schema', n.nspname, n.nspname,
			       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
			       a.privilege_type, a.is_grantable
			FROM pg_namespace n
			CROSS JOIN LATERAL aclexplode(n.nspacl) a
			WHERE n.nspname = 'work'
		) g
		ORDER BY object_type, schema_name, object_name, grantee, privilege_type, is_grantable`)
	if err != nil {
		return nil, newError("catalog_read_failed", "read grants: %v", err)
	}
	for grants.Next() {
		var item Grant
		if err := grants.Scan(
			&item.ObjectType, &item.Schema, &item.Object,
			&item.Grantee, &item.Privilege, &item.Grantable,
		); err != nil {
			grants.Close()
			return nil, newError("catalog_read_failed", "scan grant: %v", err)
		}
		catalog.Grants = append(catalog.Grants, item)
	}
	if err := grants.Err(); err != nil {
		grants.Close()
		return nil, newError("catalog_read_failed", "read grants: %v", err)
	}
	grants.Close()

	catalog.sort()
	return catalog, nil
}

func (c *Catalog) sort() {
	sort.Slice(c.Relations, func(i, j int) bool { return c.Relations[i].Name < c.Relations[j].Name })
	sort.Slice(c.Columns, func(i, j int) bool {
		if c.Columns[i].Table != c.Columns[j].Table {
			return c.Columns[i].Table < c.Columns[j].Table
		}
		return c.Columns[i].Position < c.Columns[j].Position
	})
	sort.Slice(c.Constraints, func(i, j int) bool {
		if c.Constraints[i].Table != c.Constraints[j].Table {
			return c.Constraints[i].Table < c.Constraints[j].Table
		}
		return c.Constraints[i].Name < c.Constraints[j].Name
	})
	sort.Slice(c.Indexes, func(i, j int) bool {
		if c.Indexes[i].Table != c.Indexes[j].Table {
			return c.Indexes[i].Table < c.Indexes[j].Table
		}
		return c.Indexes[i].Name < c.Indexes[j].Name
	})
	sort.Slice(c.Functions, func(i, j int) bool {
		if c.Functions[i].Name != c.Functions[j].Name {
			return c.Functions[i].Name < c.Functions[j].Name
		}
		return c.Functions[i].IdentityArguments < c.Functions[j].IdentityArguments
	})
	sort.Slice(c.Views, func(i, j int) bool { return c.Views[i].Name < c.Views[j].Name })
	sort.Slice(c.Triggers, func(i, j int) bool {
		if c.Triggers[i].Table != c.Triggers[j].Table {
			return c.Triggers[i].Table < c.Triggers[j].Table
		}
		return c.Triggers[i].Name < c.Triggers[j].Name
	})
	sort.Slice(c.Policies, func(i, j int) bool {
		if c.Policies[i].Table != c.Policies[j].Table {
			return c.Policies[i].Table < c.Policies[j].Table
		}
		return c.Policies[i].Name < c.Policies[j].Name
	})
	sort.Slice(c.Grants, func(i, j int) bool {
		a, b := c.Grants[i], c.Grants[j]
		if a.ObjectType != b.ObjectType {
			return a.ObjectType < b.ObjectType
		}
		if a.Schema != b.Schema {
			return a.Schema < b.Schema
		}
		if a.Object != b.Object {
			return a.Object < b.Object
		}
		if a.Grantee != b.Grantee {
			return a.Grantee < b.Grantee
		}
		if a.Privilege != b.Privilege {
			return a.Privilege < b.Privilege
		}
		return !a.Grantable && b.Grantable
	})
}

func (c *Catalog) Hash() (string, error) {
	body, err := json.Marshal(c)
	if err != nil {
		return "", fmt.Errorf("marshal catalog: %w", err)
	}
	sum := sha256.Sum256(body)
	return checksumPrefix + hex.EncodeToString(sum[:]), nil
}

func (c *Catalog) JSON() ([]byte, error) {
	body, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal catalog: %w", err)
	}
	return append(body, '\n'), nil
}
