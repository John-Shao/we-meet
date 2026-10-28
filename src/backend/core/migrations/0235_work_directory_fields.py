import django.core.validators
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0234_remove_work_grant_permissions"),
    ]

    operations = [
        migrations.AddField(
            model_name="organization",
            name="home_region",
            field=models.CharField(
                default="cn-north",
                max_length=64,
                validators=[django.core.validators.RegexValidator("^[a-z0-9-]{3,64}$")],
                verbose_name="Work home region",
            ),
        ),
        migrations.AddField(
            model_name="organization",
            name="directory_revision",
            field=models.PositiveBigIntegerField(
                default=1,
                help_text="Organization-wide directory sequence; every organization or membership change advances it.",
                verbose_name="directory revision",
            ),
        ),
        migrations.AddField(
            model_name="membership",
            name="work_seat",
            field=models.BooleanField(
                default=False,
                help_text="Explicit entitlement; directory membership alone does not grant it.",
                verbose_name="Work seat",
            ),
        ),
        migrations.AddField(
            model_name="membership",
            name="directory_revision",
            field=models.PositiveBigIntegerField(
                default=1,
                help_text="Organization directory revision at this member's last change.",
                verbose_name="directory revision",
            ),
        ),
        migrations.RunSQL(
            sql="""
            CREATE OR REPLACE FUNCTION core_bump_directory_revision()
            RETURNS trigger AS $$
            BEGIN
              NEW.directory_revision := OLD.directory_revision + 1;
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            CREATE OR REPLACE FUNCTION core_stamp_membership_directory_revision()
            RETURNS trigger AS $$
            DECLARE
              next_revision bigint;
            BEGIN
              IF TG_OP = 'UPDATE'
                 AND OLD.organization_id IS DISTINCT FROM NEW.organization_id THEN
                UPDATE meet_organization
                   SET directory_revision = directory_revision
                 WHERE id = OLD.organization_id;
              END IF;
              UPDATE meet_organization
                 SET directory_revision = directory_revision
               WHERE id = NEW.organization_id
              RETURNING directory_revision INTO next_revision;
              NEW.directory_revision := next_revision;
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            CREATE OR REPLACE FUNCTION core_bump_org_on_membership_delete()
            RETURNS trigger AS $$
            BEGIN
              UPDATE meet_organization
                 SET directory_revision = directory_revision
               WHERE id = OLD.organization_id;
              RETURN OLD;
            END;
            $$ LANGUAGE plpgsql;

            CREATE TRIGGER core_organization_directory_revision
              BEFORE UPDATE ON meet_organization
              FOR EACH ROW EXECUTE FUNCTION core_bump_directory_revision();

            CREATE TRIGGER core_membership_directory_revision
              BEFORE INSERT OR UPDATE ON meet_membership
              FOR EACH ROW EXECUTE FUNCTION core_stamp_membership_directory_revision();

            CREATE TRIGGER core_membership_delete_directory_revision
              BEFORE DELETE ON meet_membership
              FOR EACH ROW EXECUTE FUNCTION core_bump_org_on_membership_delete();

            UPDATE meet_organization o
               SET directory_revision = directory_revision
             WHERE o.directory_revision < COALESCE(
               (SELECT MAX(m.directory_revision)
                  FROM meet_membership m
                 WHERE m.organization_id = o.id),
               0
             );
            """,
            reverse_sql="""
            DROP TRIGGER IF EXISTS core_organization_directory_revision ON meet_organization;
            DROP TRIGGER IF EXISTS core_membership_directory_revision ON meet_membership;
            DROP TRIGGER IF EXISTS core_membership_delete_directory_revision ON meet_membership;
            DROP FUNCTION IF EXISTS core_bump_org_on_membership_delete();
            DROP FUNCTION IF EXISTS core_stamp_membership_directory_revision();
            DROP FUNCTION IF EXISTS core_bump_directory_revision();
            """,
        ),
    ]
