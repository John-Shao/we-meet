package db_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/testpg"
)

func TestMain(m *testing.M) {
	if testpg.AdminURL() == "" {
		os.Exit(m.Run())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err == nil {
		err = testpg.EnsureFixtures(ctx, admin)
		_ = admin.Close(ctx)
	}
	cancel()
	if err != nil {
		fmt.Fprintf(os.Stderr, "prepare test fixtures: %v\n", err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

func TestWithWorkContextScopesTenant(t *testing.T) {
	pool := newRLSPool(t)
	ctx := testContext(t)

	cases := []struct {
		name      string
		identity  workdb.Identity
		wantOrg   string
		wantCount int
	}{
		{"tenant a", workdb.Identity{OrgID: "org_a", SubjectID: "sub_a"}, "org_a", 1},
		{"tenant b", workdb.Identity{OrgID: "org_b", SubjectID: "sub_b"}, "org_b", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := workdb.WithWorkContext(ctx, pool, tc.identity, workdb.RoleAPI, workdb.Options{}, func(tx pgx.Tx) error {
				var user, orgID, subjectID string
				if err := tx.QueryRow(ctx,
					`SELECT current_user, current_setting('app.org_id'), current_setting('app.subject_id')`,
				).Scan(&user, &orgID, &subjectID); err != nil {
					return err
				}
				if user != "work_api" {
					return fmt.Errorf("current_user = %q, want work_api", user)
				}
				if orgID != tc.identity.OrgID || subjectID != tc.identity.SubjectID {
					return fmt.Errorf("context = %q/%q, want %q/%q", orgID, subjectID, tc.identity.OrgID, tc.identity.SubjectID)
				}

				var orgs, members int
				if err := tx.QueryRow(ctx, `SELECT count(*) FROM work.org`).Scan(&orgs); err != nil {
					return err
				}
				if err := tx.QueryRow(ctx, `SELECT count(*) FROM work.member`).Scan(&members); err != nil {
					return err
				}
				if orgs != tc.wantCount || members != tc.wantCount {
					return fmt.Errorf("visible orgs/members = %d/%d, want %d", orgs, members, tc.wantCount)
				}
				var visibleOrg string
				if err := tx.QueryRow(ctx, `SELECT id FROM work.org`).Scan(&visibleOrg); err != nil {
					return err
				}
				if visibleOrg != tc.wantOrg {
					return fmt.Errorf("visible org = %q, want %q", visibleOrg, tc.wantOrg)
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}

	var user string
	var org *string
	if err := pool.QueryRow(ctx, `SELECT current_user, current_setting('app.org_id', true)`).Scan(&user, &org); err != nil {
		t.Fatal(err)
	}
	if user != "work_app_test_login" {
		t.Fatalf("pooled connection role leaked: %q", user)
	}
	if org != nil && *org != "" {
		t.Fatalf("pooled connection org context leaked: %q", *org)
	}
}

func TestWithWorkContextIsolation(t *testing.T) {
	pool := newRLSPool(t)
	ctx := testContext(t)
	writer, err := testpg.Open(ctx, testpg.AdminURLFor(pool.Config().ConnConfig.Database))
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close(ctx)

	cases := []struct {
		name         string
		options      workdb.Options
		wantLevel    string
		wantReadOnly string
		wantRegion   string
	}{
		{"default", workdb.Options{}, "read committed", "off", "cn-east"},
		{"read only default", workdb.Options{ReadOnly: true}, "read committed", "on", "cn-east"},
		{"repeatable read", workdb.Options{ReadOnly: true, IsoLevel: pgx.RepeatableRead}, "repeatable read", "on", "cn-north"},
		{"explicit read committed", workdb.Options{ReadOnly: true, IsoLevel: pgx.ReadCommitted}, "read committed", "on", "cn-east"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := writer.Exec(ctx, `UPDATE work.org SET home_region = 'cn-north' WHERE id = 'org_a'`); err != nil {
				t.Fatal(err)
			}
			err := workdb.WithWorkContext(ctx, pool,
				workdb.Identity{OrgID: "org_a", SubjectID: "sub_a"},
				workdb.RoleAPI, tc.options,
				func(tx pgx.Tx) error {
					var level, readOnly, region string
					if err := tx.QueryRow(ctx, `
						SELECT current_setting('transaction_isolation'),
						       current_setting('transaction_read_only'), home_region
						FROM work.org WHERE id = 'org_a'`,
					).Scan(&level, &readOnly, &region); err != nil {
						return err
					}
					if level != tc.wantLevel || readOnly != tc.wantReadOnly || region != "cn-north" {
						return fmt.Errorf("initial isolation/read-only/region = %q/%q/%q, want %q/%q/cn-north",
							level, readOnly, region, tc.wantLevel, tc.wantReadOnly)
					}

					if _, err := writer.Exec(ctx, `UPDATE work.org SET home_region = 'cn-east' WHERE id = 'org_a'`); err != nil {
						return err
					}
					if err := tx.QueryRow(ctx, `SELECT home_region FROM work.org WHERE id = 'org_a'`).Scan(&region); err != nil {
						return err
					}
					if region != tc.wantRegion {
						return fmt.Errorf("second read = %q, want %q", region, tc.wantRegion)
					}
					return nil
				},
			)
			if err != nil {
				t.Fatal(err)
			}

			err = workdb.WithWorkContext(ctx, pool,
				workdb.Identity{OrgID: "org_a", SubjectID: "sub_a"},
				workdb.RoleAPI, workdb.Options{},
				func(tx pgx.Tx) error {
					var level, region string
					if err := tx.QueryRow(ctx, `
						SELECT current_setting('transaction_isolation'), home_region
						FROM work.org WHERE id = 'org_a'`,
					).Scan(&level, &region); err != nil {
						return err
					}
					if level != "read committed" || region != "cn-east" {
						return fmt.Errorf("new transaction isolation/region = %q/%q", level, region)
					}
					return nil
				},
			)
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestWithWorkContextCallbackErrorRollsBackContext(t *testing.T) {
	pool := newRLSPool(t)
	ctx := testContext(t)
	sentinel := errors.New("callback failed")
	err := workdb.WithWorkContext(ctx, pool,
		workdb.Identity{OrgID: "org_a", SubjectID: "sub_a"},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error { return sentinel },
	)
	if !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want callback error", err)
	}
	var user string
	if err := pool.QueryRow(ctx, `SELECT current_user`).Scan(&user); err != nil {
		t.Fatal(err)
	}
	if user != "work_app_test_login" {
		t.Fatalf("role leaked after rollback: %q", user)
	}
}

func TestWithWorkContextRejectsInvalidInput(t *testing.T) {
	cases := []struct {
		name     string
		identity workdb.Identity
		role     workdb.Role
		code     string
	}{
		{"missing org", workdb.Identity{SubjectID: "sub_a"}, workdb.RoleAPI, "invalid_identity"},
		{"missing subject", workdb.Identity{OrgID: "org_a"}, workdb.RoleAPI, "invalid_identity"},
		{"oversized identity", workdb.Identity{OrgID: strings.Repeat("a", 129), SubjectID: "sub_a"}, workdb.RoleAPI, "invalid_identity"},
		{"owner role", workdb.Identity{OrgID: "org_a", SubjectID: "sub_a"}, workdb.Role("work_owner"), "invalid_role"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := workdb.WithWorkContext(testContext(t), nil, tc.identity, tc.role, workdb.Options{}, func(pgx.Tx) error { return nil })
			var dbError *workdb.Error
			if !errors.As(err, &dbError) {
				t.Fatalf("error = %v, want db error %s", err, tc.code)
			}
			if dbError.Code != tc.code {
				t.Fatalf("code = %q, want %q", dbError.Code, tc.code)
			}
		})
	}
}

func newRLSPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	ctx := testContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_rls_test")
	_ = admin.Close(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		cleanupAdmin, err := testpg.Open(cleanupCtx, testpg.AdminURL())
		if err == nil {
			_ = testpg.DropDatabase(cleanupCtx, cleanupAdmin, dbName)
			_ = cleanupAdmin.Close(cleanupCtx)
		}
	})

	seedConn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	err = testpg.ExecRaw(ctx, seedConn, `
		INSERT INTO work.org (id, status, home_region)
		VALUES ('org_a', 'active', 'cn-north'), ('org_b', 'active', 'cn-east');
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES ('org_a', 'sub_a', 'active', 'owner', true),
		       ('org_b', 'sub_b', 'active', 'member', true);
	`)
	_ = seedConn.Close(ctx)
	if err != nil {
		t.Fatal(err)
	}

	pool, err := workdb.OpenPool(ctx, testpg.AppURL(dbName), "work-rls-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}
