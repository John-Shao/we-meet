from django.db import migrations

TABLES = (
    "voiceprintconsent",
    "voiceprintdeletionjob",
    "voiceprintsourceremoval",
    "voiceprintcontributionremoval",
    "voiceprintsample",
    "voiceprintprofile",
    "user",
    "membership",
    "organization",
    "meetingrecord",
    "meetingsession",
    "voiceprintsamplingtrack",
)

TABLE_NAMES = {
    "user": "meet_user",
    "membership": "meet_membership",
    "organization": "meet_organization",
    "meetingrecord": "meet_meeting_record",
    "meetingsession": "meet_meeting_session",
}

FUNCTION = """
CREATE FUNCTION public.we_meet_voiceprint_write_fence()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE before_row jsonb := to_jsonb(OLD); after_row jsonb := to_jsonb(NEW);
    protected text[]; item text; relevant boolean := false;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.core_voiceprintjournalcheckpoint WHERE id=1) THEN
        IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;
    CASE TG_TABLE_NAME
    WHEN 'core_voiceprintdeletionjob' THEN
        protected := ARRAY['owner_id','organization_id','expected_version','revoked_generation'];
    WHEN 'core_voiceprintsourceremoval' THEN
        protected := ARRAY['kind','source_uuid','source_session_id','track_digest'];
    WHEN 'core_voiceprintcontributionremoval' THEN
        protected := ARRAY['sample_uuid','profile_uuid','owner_uuid','organization_uuid','generation','templates'];
    ELSE protected := NULL;
    END CASE;
    IF protected IS NOT NULL THEN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'voiceprint_journal_immutable_proof'; END IF;
        IF TG_OP='UPDATE' THEN
            FOREACH item IN ARRAY protected LOOP
                IF before_row->item IS DISTINCT FROM after_row->item THEN
                    RAISE EXCEPTION 'voiceprint_journal_immutable_proof';
                END IF;
            END LOOP;
        ELSE relevant := true;
        END IF;
    ELSE
        CASE TG_TABLE_NAME
        WHEN 'core_voiceprintconsent' THEN
            IF TG_OP='DELETE' THEN
                relevant := NOT EXISTS (
                    SELECT 1 FROM public.core_voiceprintdeletionjob j
                    WHERE j.owner_id=OLD.user_id AND j.organization_id IS NOT DISTINCT FROM OLD.organization_id
                    AND j.revoked_generation>OLD.generation
                );
            ELSIF TG_OP='INSERT' THEN relevant := true;
            ELSE
                relevant := (before_row->'user_id',before_row->'organization_id',before_row->'version',
                    before_row->'generation',before_row->'allow_enrollment',before_row->'allow_accumulation',
                    before_row->'allow_identification') IS DISTINCT FROM
                    (after_row->'user_id',after_row->'organization_id',after_row->'version',
                    after_row->'generation',after_row->'allow_enrollment',after_row->'allow_accumulation',
                    after_row->'allow_identification');
            END IF;
        WHEN 'core_voiceprintsample' THEN
            IF TG_OP='UPDATE' AND OLD.status IN ('rejected','expired','deleted')
              AND NEW.status NOT IN ('rejected','expired','deleted') THEN
                RAISE EXCEPTION 'voiceprint_journal_terminal_sample';
            END IF;
            IF TG_OP='DELETE' THEN
                relevant := OLD.status NOT IN ('rejected','expired','deleted')
                  AND NOT EXISTS (SELECT 1 FROM public.core_voiceprintcontributionremoval r WHERE r.sample_uuid=OLD.id)
                  AND NOT EXISTS (SELECT 1 FROM public.core_voiceprintprofile p
                    JOIN public.core_voiceprintconsent c ON c.id=p.consent_id
                    JOIN public.core_voiceprintdeletionjob j ON j.owner_id=c.user_id
                    AND j.organization_id IS NOT DISTINCT FROM c.organization_id
                    WHERE p.id=OLD.profile_id AND j.revoked_generation>OLD.generation);
            ELSE
                relevant := NEW.status IN ('rejected','expired','deleted')
                  AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status);
            END IF;
        WHEN 'core_voiceprintprofile' THEN
            IF TG_OP='DELETE' THEN
                relevant := OLD.status<>'deleted' AND octet_length(OLD.encrypted_key)>0;
            ELSIF TG_OP='UPDATE' THEN
                relevant := OLD.generation IS DISTINCT FROM NEW.generation
                  OR (OLD.status<>'deleted' AND NEW.status='deleted')
                  OR (octet_length(OLD.encrypted_key)>0 AND octet_length(NEW.encrypted_key)=0);
            END IF;
        WHEN 'meet_user' THEN
            IF TG_OP<>'INSERT' THEN
                relevant := EXISTS (SELECT 1 FROM public.core_voiceprintconsent WHERE user_id=OLD.id)
                  AND (TG_OP='DELETE' OR OLD.is_active IS DISTINCT FROM NEW.is_active
                    OR OLD.is_device IS DISTINCT FROM NEW.is_device);
            END IF;
        WHEN 'meet_membership' THEN
            relevant := EXISTS (SELECT 1 FROM public.core_voiceprintconsent c
              WHERE (c.user_id,c.organization_id) IN (
                ((before_row->>'user_id')::uuid,(before_row->>'organization_id')::uuid),
                ((after_row->>'user_id')::uuid,(after_row->>'organization_id')::uuid)))
              AND (TG_OP<>'UPDATE' OR
                (before_row->'user_id',before_row->'organization_id',before_row->'status') IS DISTINCT FROM
                (after_row->'user_id',after_row->'organization_id',after_row->'status'));
        WHEN 'meet_organization' THEN
            IF TG_OP<>'INSERT' THEN
                relevant := EXISTS (SELECT 1 FROM public.core_voiceprintconsent WHERE organization_id=OLD.id)
                  AND (TG_OP='DELETE' OR OLD.is_active IS DISTINCT FROM NEW.is_active
                    OR OLD.settings->'voiceprint' IS DISTINCT FROM NEW.settings->'voiceprint');
            END IF;
        WHEN 'meet_meeting_record' THEN
            IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN
                relevant := NOT EXISTS (SELECT 1 FROM public.core_voiceprintsourceremoval
                    WHERE kind='record' AND source_uuid=OLD.id);
            END IF;
        WHEN 'meet_meeting_session' THEN
            IF TG_OP='DELETE' THEN
                relevant := NOT EXISTS (SELECT 1 FROM public.core_voiceprintsourceremoval
                    WHERE kind='session' AND source_uuid=OLD.id);
            END IF;
        WHEN 'core_voiceprintsamplingtrack' THEN
            IF TG_OP='DELETE' THEN
                relevant := NOT EXISTS (SELECT 1 FROM public.core_voiceprintsourceremoval
                    WHERE kind='track' AND source_uuid=OLD.id);
            END IF;
        ELSE RAISE EXCEPTION 'voiceprint_journal_unknown_table';
        END CASE;
    END IF;
    IF relevant AND current_setting('we_meet.voiceprint_mutation',true) IS DISTINCT FROM '1' THEN
        RAISE EXCEPTION 'voiceprint_journal_transaction_required';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END
$$;
"""


class Migration(migrations.Migration):
    dependencies = [("core", "0218_voiceprint_journal_checkpoint")]
    operations = [
        migrations.RunSQL(
            FUNCTION
            + "\n".join(
                f"CREATE TRIGGER vp_journal_fence BEFORE INSERT OR UPDATE OR DELETE ON public.{TABLE_NAMES.get(table, 'core_' + table)} "
                "FOR EACH ROW EXECUTE FUNCTION public.we_meet_voiceprint_write_fence();"
                for table in TABLES
            ),
            "\n".join(
                f"DROP TRIGGER vp_journal_fence ON public.{TABLE_NAMES.get(table, 'core_' + table)};"
                for table in TABLES
            )
            + "\nDROP FUNCTION public.we_meet_voiceprint_write_fence();",
        ),
    ]
