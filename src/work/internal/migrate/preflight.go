package migrate

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

var workRoles = []string{
	"work_owner",
	"work_api",
	"work_worker",
	"work_ledger",
	"work_migrator",
	"work_ops",
	"work_directory",
}

type RoleInfo struct {
	Name       string
	CanLogin   bool
	Superuser  bool
	CreateRole bool
	BypassRLS  bool
	Inherit    bool
}

type Admission struct {
	CurrentUser    string
	SessionUser    string
	Superuser      bool
	RoleMembership bool
	Roles          map[string]RoleInfo
}

func Preflight(ctx context.Context, q Querier) (*Admission, error) {
	admission := &Admission{Roles: make(map[string]RoleInfo)}
	if err := q.QueryRow(ctx, `SELECT current_user, session_user, rolsuper FROM pg_roles WHERE rolname = current_user`).
		Scan(&admission.CurrentUser, &admission.SessionUser, &admission.Superuser); err != nil {
		return nil, newError("preflight_failed", "read current user: %v", err)
	}

	rows, err := q.Query(ctx, `
		SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolbypassrls, rolinherit
		FROM pg_roles
		WHERE rolname = ANY($1::text[])
		ORDER BY rolname`, workRoles)
	if err != nil {
		return nil, newError("preflight_failed", "read Work roles: %v", err)
	}
	for rows.Next() {
		var role RoleInfo
		if err := rows.Scan(
			&role.Name, &role.CanLogin, &role.Superuser,
			&role.CreateRole, &role.BypassRLS, &role.Inherit,
		); err != nil {
			rows.Close()
			return nil, newError("preflight_failed", "scan Work role: %v", err)
		}
		admission.Roles[role.Name] = role
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, newError("preflight_failed", "read Work roles: %v", err)
	}
	rows.Close()

	if err := q.QueryRow(ctx, `SELECT pg_has_role(current_user, 'work_owner', 'MEMBER')`).Scan(&admission.RoleMembership); err != nil {
		return nil, newError("preflight_failed", "check work_owner membership: %v", err)
	}
	if err := validateAdmission(admission); err != nil {
		return nil, err
	}
	return admission, nil
}

func validateAdmission(admission *Admission) error {
	for _, role := range workRoles {
		if role == admission.CurrentUser {
			return newError(
				"application_role_cannot_migrate",
				"current user %q is a Work service role; connect with the dedicated migration login",
				admission.CurrentUser,
			)
		}
	}
	var missing []string
	for _, role := range workRoles {
		if _, ok := admission.Roles[role]; !ok {
			missing = append(missing, role)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return newError("role_missing", "Work roles missing: %s", strings.Join(missing, ", "))
	}
	for _, role := range workRoles {
		if admission.Roles[role].CanLogin {
			return newError("role_must_be_nologin", "Work role %q must be NOLOGIN", role)
		}
	}
	if !admission.RoleMembership {
		return newError(
			"migration_user_missing_work_owner",
			"migration user %q must be a member of work_owner",
			admission.CurrentUser,
		)
	}
	return nil
}

func (a *Admission) String() string {
	return fmt.Sprintf("%s (session %s, superuser=%t)", a.CurrentUser, a.SessionUser, a.Superuser)
}
