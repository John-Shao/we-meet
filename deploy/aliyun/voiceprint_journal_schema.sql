-- Install only in an independent, empty authority database as its operator.
-- Create the two LOGIN roles separately with privately managed passwords.
-- Application roles never own these tables/functions or receive direct DML.
BEGIN;
DO $$
BEGIN
    IF (SELECT count(*) FROM pg_catalog.pg_roles
        WHERE rolname IN ('voiceprint_journal_reader','voiceprint_journal_writer')) <> 2
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname IN ('voiceprint_journal_reader','voiceprint_journal_writer')
          AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication
            OR rolbypassrls OR NOT rolcanlogin))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
        JOIN pg_catalog.pg_roles r ON r.oid = m.member
        WHERE r.rolname IN ('voiceprint_journal_reader','voiceprint_journal_writer')) THEN
        RAISE EXCEPTION 'journal_roles_must_be_unprivileged';
    END IF;
END
$$;
CREATE SCHEMA voiceprint_journal;
REVOKE ALL ON SCHEMA voiceprint_journal FROM PUBLIC;
CREATE TABLE voiceprint_journal.heads (
    deployment uuid PRIMARY KEY,
    sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
    digest text NOT NULL DEFAULT repeat('0', 64) CHECK (digest ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX one_authority ON voiceprint_journal.heads ((true));
CREATE TABLE voiceprint_journal.entries (
    deployment uuid NOT NULL REFERENCES voiceprint_journal.heads(deployment),
    sequence bigint NOT NULL CHECK (sequence > 0),
    previous text NOT NULL CHECK (previous ~ '^[0-9a-f]{64}$'),
    digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    envelope bytea NOT NULL CHECK (octet_length(envelope) BETWEEN 128 AND 12582912),
    PRIMARY KEY (deployment, sequence)
);
CREATE FUNCTION voiceprint_journal.read_head(subject uuid)
RETURNS TABLE(sequence bigint, digest text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT h.sequence, h.digest FROM voiceprint_journal.heads h WHERE h.deployment = subject $$;
CREATE FUNCTION voiceprint_journal.read_current(subject uuid)
RETURNS TABLE(sequence bigint, previous text, digest text, envelope bytea)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$
    SELECT e.sequence, e.previous, e.digest, e.envelope
    FROM voiceprint_journal.heads h JOIN voiceprint_journal.entries e
      ON e.deployment = h.deployment AND e.sequence = h.sequence
    WHERE h.deployment = subject
$$;
CREATE FUNCTION voiceprint_journal.append_record(
    subject uuid, expected_sequence bigint, expected_digest text,
    payload bytea, payload_digest text
)
RETURNS TABLE(sequence bigint, digest text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE current_sequence bigint; current_digest text;
BEGIN
    SELECT h.sequence, h.digest INTO current_sequence, current_digest
      FROM voiceprint_journal.heads h WHERE h.deployment = subject FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'journal_not_initialized' USING ERRCODE = '42704';
    END IF;
    IF current_sequence IS DISTINCT FROM expected_sequence
      OR current_digest IS DISTINCT FROM expected_digest THEN
        RAISE EXCEPTION 'journal_conflict' USING ERRCODE = '40001';
    END IF;
    IF expected_sequence >= 9223372036854775806
      OR octet_length(payload) NOT BETWEEN 128 AND 12582912
      OR payload_digest IS DISTINCT FROM encode(sha256(payload), 'hex') THEN
        RAISE EXCEPTION 'journal_invalid' USING ERRCODE = '22023';
    END IF;
    INSERT INTO voiceprint_journal.entries VALUES (
        subject, current_sequence + 1, current_digest, payload_digest, payload
    );
    UPDATE voiceprint_journal.heads h SET sequence = current_sequence + 1,
      digest = payload_digest WHERE h.deployment = subject;
    RETURN QUERY SELECT current_sequence + 1, payload_digest;
END
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA voiceprint_journal FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA voiceprint_journal FROM PUBLIC;
GRANT USAGE ON SCHEMA voiceprint_journal TO voiceprint_journal_reader, voiceprint_journal_writer;
GRANT EXECUTE ON FUNCTION voiceprint_journal.read_head(uuid),
  voiceprint_journal.read_current(uuid)
  TO voiceprint_journal_reader, voiceprint_journal_writer;
GRANT EXECUTE ON FUNCTION voiceprint_journal.append_record(uuid,bigint,text,bytea,text)
  TO voiceprint_journal_writer;
COMMIT;
