package migrate

import "testing"

func TestValidateAdmissionRejectsApplicationRole(t *testing.T) {
	admission := validAdmission()
	admission.CurrentUser = "work_api"
	assertCode(t, validateAdmission(admission), "application_role_cannot_migrate")
}

func TestValidateAdmissionRejectsMissingRole(t *testing.T) {
	admission := validAdmission()
	delete(admission.Roles, "work_ops")
	assertCode(t, validateAdmission(admission), "role_missing")
}

func TestValidateAdmissionRejectsLoginRole(t *testing.T) {
	admission := validAdmission()
	role := admission.Roles["work_worker"]
	role.CanLogin = true
	admission.Roles["work_worker"] = role
	assertCode(t, validateAdmission(admission), "role_must_be_nologin")
}

func TestValidateAdmissionRejectsMissingWorkOwnerMembership(t *testing.T) {
	admission := validAdmission()
	admission.RoleMembership = false
	assertCode(t, validateAdmission(admission), "migration_user_missing_work_owner")
}

func TestValidateAdmissionAcceptsMigrationLogin(t *testing.T) {
	if err := validateAdmission(validAdmission()); err != nil {
		t.Fatalf("valid admission rejected: %v", err)
	}
}

func validAdmission() *Admission {
	roles := make(map[string]RoleInfo, len(workRoles))
	for _, role := range workRoles {
		roles[role] = RoleInfo{Name: role}
	}
	return &Admission{
		CurrentUser:    "work_migrator_login",
		SessionUser:    "work_migrator_login",
		RoleMembership: true,
		Roles:          roles,
	}
}
