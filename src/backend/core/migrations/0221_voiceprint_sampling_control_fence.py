from django.db import migrations

SQL = """
CREATE FUNCTION public.we_meet_voiceprint_control_fence()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.core_voiceprintjournalcheckpoint WHERE id=1)
       AND (TG_OP<>'UPDATE' OR
         (OLD.participation_id,OLD.revision,OLD.paused,OLD.shared_microphone,OLD.device_group)
         IS DISTINCT FROM
         (NEW.participation_id,NEW.revision,NEW.paused,NEW.shared_microphone,NEW.device_group)) THEN
        IF current_setting('we_meet.voiceprint_mutation',true) IS DISTINCT FROM '1' THEN
            RAISE EXCEPTION 'voiceprint_journal_transaction_required';
        END IF;
        PERFORM set_config('we_meet.voiceprint_control_dirty','1',true);
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END
$$;
CREATE TRIGGER vp_journal_control_fence BEFORE INSERT OR UPDATE OR DELETE
ON public.core_voiceprintsamplingcontrol
FOR EACH ROW EXECUTE FUNCTION public.we_meet_voiceprint_control_fence();
"""


class Migration(migrations.Migration):
    dependencies = [("core", "0220_voiceprint_guarded_bulk_paths")]
    operations = [
        migrations.RunSQL(
            SQL,
            "DROP TRIGGER vp_journal_control_fence ON public.core_voiceprintsamplingcontrol;"
            "DROP FUNCTION public.we_meet_voiceprint_control_fence();",
        ),
    ]
