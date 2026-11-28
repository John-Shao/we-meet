-- 0092: enforce the finite ExecutionProfile bounds required by the local-run contract.
SET ROLE work_owner;

ALTER TABLE work.execution_profile_revision
  ADD CONSTRAINT execution_profile_revision_request_bytes_bound
  CHECK (max_request_bytes <= 262144);

ALTER TABLE work.execution_profile_revision
  ADD CONSTRAINT execution_profile_revision_context_tokens_bound
  CHECK (context_tokens <= 9007199254740991);

ALTER TABLE work.execution_profile_revision
  ADD CONSTRAINT execution_profile_revision_output_tokens_bound
  CHECK (max_output_tokens <= 9007199254740991);

ALTER TABLE work.execution_profile_revision
  ADD CONSTRAINT execution_profile_revision_output_within_context
  CHECK (max_output_tokens <= context_tokens);

ALTER TABLE work.execution_profile_revision
  ADD CONSTRAINT execution_profile_revision_turns_bound
  CHECK (max_turns <= 9007199254740991);

RESET ROLE;
