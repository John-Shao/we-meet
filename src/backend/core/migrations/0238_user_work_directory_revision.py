from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0237_work_governance_events"),
    ]

    operations = [
        migrations.RunSQL(
            sql="""
            CREATE FUNCTION core_stamp_user_directory_revision()
            RETURNS trigger AS $$
            DECLARE
              organization_record record;
            BEGIN
              IF OLD.is_active IS DISTINCT FROM NEW.is_active THEN
                FOR organization_record IN
                  SELECT DISTINCT organization_id
                  FROM meet_membership
                  WHERE user_id = NEW.id
                  ORDER BY organization_id
                LOOP
                  PERFORM 1
                  FROM meet_organization
                  WHERE id = organization_record.organization_id
                  FOR UPDATE;

                  UPDATE meet_membership
                  SET updated_at = now()
                  WHERE user_id = NEW.id
                    AND organization_id = organization_record.organization_id;
                END LOOP;
              END IF;
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            CREATE TRIGGER core_user_directory_revision
            AFTER UPDATE OF is_active ON meet_user
            FOR EACH ROW EXECUTE FUNCTION core_stamp_user_directory_revision();
            """,
            reverse_sql="""
            DROP TRIGGER core_user_directory_revision ON meet_user;
            DROP FUNCTION core_stamp_user_directory_revision();
            """,
        ),
    ]
