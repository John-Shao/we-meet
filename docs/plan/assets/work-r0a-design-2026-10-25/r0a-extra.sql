-- R0a 新增：输入对象与 Task 元数据
-- 正文只存在 Content Store；本表只保留引用、哈希、大小与保留状态。

CREATE TABLE work.input_object (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES work.org(id),
  subject_id text NOT NULL,
  purpose text NOT NULL DEFAULT 'task_input' CHECK (purpose IN ('task_input')),
  content_ref text NOT NULL,
  content_hash text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes > 0),
  media_type text NOT NULL DEFAULT 'application/json',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'deleted')),
  task_id uuid,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, org_id)
);

-- 输入一次性：同哈希只复用尚未绑定任务的输入；提交时绑定 task_id，删除只粉碎本任务输入。
CREATE UNIQUE INDEX work_input_active_hash
  ON work.input_object(org_id, subject_id, content_hash, purpose)
  WHERE status = 'active' AND task_id IS NULL;

ALTER TABLE work.task ADD COLUMN input_id uuid NOT NULL;
ALTER TABLE work.task ADD COLUMN title text NOT NULL
  CHECK (length(title) BETWEEN 1 AND 200);
ALTER TABLE work.task
  ADD CONSTRAINT fk_task_input
  FOREIGN KEY (input_id, org_id)
  REFERENCES work.input_object(id, org_id);

CREATE UNIQUE INDEX work_input_one_task
  ON work.input_object(task_id) WHERE task_id IS NOT NULL;

CREATE INDEX work_task_owner_created
  ON work.task(org_id, owner_subject_id, created_at DESC);
