package migrate

import "testing"

func TestLocalApprovalReadonlyScopeIsExactAndOwnerScoped(t *testing.T) {
	a := newActionFixture(t, "org_approval_readonly_scope")
	out := a.prepare(t, a.workerConn(t), "tool:readonly", a.grantClass)
	approvalID := idOf(t, out, "approval_id")
	scope := callJSON(t, a.apiConn(t),
		`SELECT work.local_approval_readonly_scope($1,$2,$3::uuid)`,
		a.org, a.subject, approvalID)
	tools, _ := scope["tool_set"].([]any)
	if len(tools) != 1 || tools[0] != "workspace.read" ||
		scope["resource_selector_hash"] != a.selectorHash ||
		scope["grant_id"] != a.grantID || scope["grant_revision"] != "1" {
		t.Fatalf("readonly scope = %#v", scope)
	}
	if got := mustScalar(t, a.apiConn(t), `SELECT has_table_privilege('work_api', 'work.local_action', 'SELECT')::text`); got != "false" {
		t.Fatalf("work_api local_action SELECT = %s, want false", got)
	}
	expectCode(t, a.apiConn(t), "actor_mismatch",
		"SELECT work.local_approval_readonly_scope($1,$2,$3::uuid)",
		a.org, "another-subject", approvalID)
	mustExec(t, a.admin, "UPDATE work.approval SET status = 'approved' WHERE id = "+quoteLiteral(approvalID))
	if got := mustScalar(t, a.apiConn(t), "SELECT coalesce(work.local_approval_readonly_scope("+
		quoteLiteral(a.org)+", "+quoteLiteral(a.subject)+", "+quoteLiteral(approvalID)+")::text, 'null')"); got != "null" {
		t.Fatalf("non-pending scope = %s, want null", got)
	}
}
