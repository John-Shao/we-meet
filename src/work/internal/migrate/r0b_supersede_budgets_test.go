package migrate

import (
	"encoding/json"
	"testing"
)

const supersedeBudgetsSQL = `SELECT work.run_supersede_budgets($1, $2::uuid, $3)`

func (a *actionFixture) supersedeBudgets(t *testing.T) map[string]any {
	t.Helper()
	conn := a.apiConnAs(t, a.subject)
	defer conn.Close(testContext(t))
	var raw []byte
	if err := conn.QueryRow(testContext(t), supersedeBudgetsSQL,
		a.org, a.runID, a.subject).Scan(&raw); err != nil {
		t.Fatalf("run_supersede_budgets: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("run_supersede_budgets returned non-object JSON: %s", raw)
	}
	return doc
}

func TestR0bSupersedeBudgetsSeparateTotalSequenceFromActiveBudget(t *testing.T) {
	a := newActionFixture(t, "org_72_supersede_budgets")
	worker := a.workerConn(t)
	old := idOf(t, a.prepare(t, worker, "tool:budget-ui", a.grantClass), "operation_id")
	for _, reason := range []string{
		"approval_expired", "approval_expired", "approval_expired",
		"reauthorized", "reauthorized",
	} {
		fields := []string{"none"}
		if reason == "reauthorized" {
			fields = []string{"grant"}
		}
		old = idOf(t, a.prepareSupersede(t, worker, old, reason, fields), "operation_id")
	}
	for range 2 {
		old = idOf(t, a.prepareSupersede(t, worker, old, "tool_params_changed", []string{"params"}), "operation_id")
	}

	doc := a.supersedeBudgets(t)
	steps, ok := doc["steps"].([]any)
	if !ok || len(steps) != 1 {
		t.Fatalf("budget document = %#v, want one step", doc)
	}
	step := steps[0].(map[string]any)
	if step["step_key"] != "tool:budget-ui" || step["supersede_no"] != float64(7) ||
		step["active_supersede_count"] != float64(2) || step["active_supersede_limit"] != float64(5) ||
		step["limit_reached"] != false {
		t.Fatalf("mixed budget = %#v, want total #7 with active 2/5", step)
	}

	for range 3 {
		old = idOf(t, a.prepareSupersede(t, worker, old, "tool_params_changed", []string{"params"}), "operation_id")
	}
	doc = a.supersedeBudgets(t)
	step = doc["steps"].([]any)[0].(map[string]any)
	if step["supersede_no"] != float64(10) || step["active_supersede_count"] != float64(5) ||
		step["limit_reached"] != true {
		t.Fatalf("full active budget = %#v, want total #10 with active 5/5", step)
	}
}

func TestR0bSupersedeBudgetsHideAnotherOwnersRun(t *testing.T) {
	a := newActionFixture(t, "org_72_supersede_budgets_private")
	conn := a.apiConnAs(t, "subject:not-the-owner")
	defer conn.Close(testContext(t))
	var raw []byte
	err := conn.QueryRow(testContext(t), supersedeBudgetsSQL,
		a.org, a.runID, "subject:not-the-owner").Scan(&raw)
	if err == nil {
		t.Fatal("another subject read the run's supersede budgets")
	}
}
