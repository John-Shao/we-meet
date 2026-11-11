-- 0039 (裁定 V1，EV86 的必须交付项): 把 mass-absence 的 access_epoch 抬升收敛到每事件一次，
-- 落在真实执行的那两个函数体上。
--
-- 现读机制：work.mark_members_absent(text, text[], boolean, bigint) 是 0008:268 建立的 4 参版
-- （0003 的 3 参版已被 0008:267 DROP，internal/directory/pg_test.go:518 钉着它不可调用）。它在游标
-- 循环里对每个缺席成员发一条 UPDATE work.member SET status='left', work_seat=false
-- （0008:360-365），这一条语句同时满足存活触发器 work.record_member_narrowing()
-- （0019:261 建立、0023:177 重写，触发器 member_narrowing_deny 在 0019:335）的两个分支：
-- 状态分支 0023:194-216 与席位分支 0023:218-251 各自 UPDATE work.org SET
-- access_epoch = access_epoch + 1 一次，所以一行成员 = 两次抬升。5 行的窄化事件实测
-- epoch +10，与 src/work/internal/migrate/r0b_governance_test.go:1200 断言的
-- epoch = epochBefore + 1 直接互斥；那个用例就是架构 §6.1 里 I1 的证据门（EV84–EV86）。
--
-- 0037 做的是同一件事，但它重写的是自己新加的 4/5 参 overload：body 引用的三张表与
-- work.org.member_epoch 列在 baseline 与 0003-0037 里零命中，全仓也没有调用方，所以那段去重从未
-- 被执行到；0038（卡片 H＝H1）已 DROP 那两个 overload。本增量把同一手法搬到现网真正在跑的
-- 0008 命令本体与 0023 触发器本体上，不改 0037/0038 任何一行历史。
--
-- 语义：一次窄化事件退休一个 epoch。事件产生者先抬一次（org 行在 0008:309-312 已 FOR UPDATE 持有，
-- 锁序不变），把抬升后的值以事务级 GUC work.mass_absence_epoch / work.mass_absence_epoch_org 交给
-- 触发器；触发器在同一事务、同一 org 的该次事件里读到它就不再抬，两支 deny 共用同一个 cutoff
-- （v_epoch - 1）。is_local=true 的设置随 COMMIT/ABORT 自动失效，异常路径不靠显式清理兜底；
-- 正常路径仍在循环后显式清空，让同一事务里的第二次事件自己抬。
--
-- 非批量路径逐字不变：没有 staging 时两支照旧各抬一次——internal/directory/recovery_pg_test.go:60
-- 断言的正是「每支 deny 各抬一次」（access_epoch >= 3）。唯一有界的差别：absent_count>0 而循环实际
-- 窄化 0 行（计数与 FOR UPDATE 之间被并发改掉）时，现在留下一次没有 deny 配套的抬升，旧写法留 0 次；
-- 没有 deny 的抬升不退休任何 Run，只抬高后续 admission 的 epoch，不放大成每行两次那样的偏差。
--
-- 权限面按 0008:398-399 与 0023:257 原样重述，签名不变，不新增 GRANT。两个重写都重述
-- SECURITY DEFINER 与 SET search_path = work, pg_catalog——#87 守卫读的就是这两项。
--
-- 半径：一个 increment + catalog + manifest 一条 + 两份手抄 (version, name) 清单 + verify 脚本一行；
-- 现网生效要等一次 rollout，本文件落地不等于部署。

SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.record_member_narrowing() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_epoch bigint;
  v_staged text;
  v_staged_org text;
  v_restriction_id uuid;
  v_source text;
  v_open_change boolean;
  v_intents bigint;
BEGIN
  IF OLD.status = NEW.status AND OLD.work_seat = NEW.work_seat THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.org_id', NEW.org_id, true);

  -- 0039: during a mass-absence batch the event owner has already moved the org
  -- epoch exactly once. Take that value; outside such a batch nothing is staged and
  -- each branch bumps per narrowing, which is what the sync recovery path expects.
  v_staged := NULLIF(current_setting('work.mass_absence_epoch', true), '');
  v_staged_org := NULLIF(current_setting('work.mass_absence_epoch_org', true), '');

  IF OLD.status = 'active' AND NEW.status IN ('suspended', 'left') THEN
    v_restriction_id := gen_random_uuid();
    IF v_staged IS NOT NULL AND v_staged_org = NEW.org_id THEN
      v_epoch := v_staged::bigint;
    ELSE
    UPDATE work.org SET access_epoch = access_epoch + 1, updated_at = now()
    WHERE id = NEW.org_id RETURNING access_epoch INTO v_epoch;
    END IF;
    INSERT INTO work.access_restriction
      (id, org_id, scope, subject_id, source, reason, epoch, host_revision,
       release_floor_revision)
    VALUES
      (v_restriction_id, NEW.org_id, 'member', NEW.subject_id, 'host_member',
       'member_' || NEW.status, v_epoch - 1, NEW.revision, NEW.revision);
    v_intents := work.queue_run_cancellations(
      NEW.org_id, v_restriction_id, v_epoch - 1, 'member_' || NEW.status,
      NEW.subject_id);
    PERFORM work.append_audit(
      NEW.org_id, NULL, 'access_restriction.created', 'access_restriction',
      v_restriction_id::text,
      jsonb_build_object('source', 'host_member', 'subject_id', NEW.subject_id,
                         'member_revision', NEW.revision,
                         'cutoff_access_epoch', v_epoch - 1,
                         'access_epoch', v_epoch,
                         'cancellation_intents', v_intents)
    );
  END IF;

  IF OLD.work_seat AND NOT NEW.work_seat THEN
    SELECT EXISTS (
      SELECT 1 FROM work.governance_change
      WHERE org_id = NEW.org_id
        AND target_kind = 'seat'
        AND target_id = NEW.subject_id
        AND state <> 'applied'
    ) INTO v_open_change;
    v_source := CASE WHEN v_open_change THEN 'work_seat_change' ELSE 'host_seat' END;
    v_restriction_id := gen_random_uuid();
    IF v_staged IS NOT NULL AND v_staged_org = NEW.org_id THEN
      v_epoch := v_staged::bigint;
    ELSE
    UPDATE work.org SET access_epoch = access_epoch + 1, updated_at = now()
    WHERE id = NEW.org_id RETURNING access_epoch INTO v_epoch;
    END IF;
    INSERT INTO work.access_restriction
      (id, org_id, scope, subject_id, source, reason, epoch, host_revision,
       release_floor_revision)
    VALUES
      (v_restriction_id, NEW.org_id, 'member', NEW.subject_id, v_source,
       'work_seat_lost', v_epoch - 1,
       CASE WHEN v_open_change THEN NULL ELSE NEW.revision END,
       -- §3.4: the seat floor is the person's already projected member revision. The
       -- projection row is being updated right now, so it is always available here.
       NEW.revision);
    v_intents := work.queue_run_cancellations(
      NEW.org_id, v_restriction_id, v_epoch - 1, 'work_seat_lost', NEW.subject_id);
    PERFORM work.append_audit(
      NEW.org_id, NULL, 'access_restriction.created', 'access_restriction',
      v_restriction_id::text,
      jsonb_build_object('source', v_source, 'subject_id', NEW.subject_id,
                         'member_revision', NEW.revision,
                         'cutoff_access_epoch', v_epoch - 1,
                         'access_epoch', v_epoch,
                         'cancellation_intents', v_intents)
    );
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION work.record_member_narrowing() FROM PUBLIC;

CREATE OR REPLACE FUNCTION work.mark_members_absent(
  p_org_id text,
  p_present_subjects text[],
  p_allow_mass_absence boolean,
  p_snapshot_revision bigint
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  member_row work.member%ROWTYPE;
  current_revision bigint;
  total_members integer;
  absent_count integer;
  threshold integer;
  affected integer := 0;
  -- 0039: the epoch this event retires, bumped once for the whole batch.
  v_epoch bigint;
BEGIN
  IF p_org_id IS NULL OR p_org_id = ''
     OR p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'directory_org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_present_subjects IS NULL THEN
    RAISE EXCEPTION 'invalid_request:present_subjects' USING ERRCODE = '22023';
  END IF;
  IF p_allow_mass_absence IS NULL THEN
    RAISE EXCEPTION 'invalid_request:mass_absence' USING ERRCODE = '22023';
  END IF;
  IF p_snapshot_revision IS NULL OR p_snapshot_revision < 1 THEN
    RAISE EXCEPTION 'invalid_request:snapshot_revision' USING ERRCODE = '22023';
  END IF;
  IF array_length(p_present_subjects, 1) > 10000 THEN
    RAISE EXCEPTION 'invalid_request:present_subjects' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_present_subjects) AS subject
    WHERE subject IS NULL OR subject !~ '^[A-Za-z0-9_.:@-]{1,128}$'
  ) THEN
    RAISE EXCEPTION 'invalid_request:subject_id' USING ERRCODE = '22023';
  END IF;

  SELECT o.revision INTO current_revision
  FROM work.org o
  WHERE o.id = p_org_id
  FOR UPDATE;
  IF current_revision IS NULL THEN
    RAISE EXCEPTION 'directory_org_missing' USING ERRCODE = 'P0001';
  END IF;
  IF p_snapshot_revision > current_revision THEN
    RAISE EXCEPTION 'directory_snapshot_ahead' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO total_members
  FROM work.member
  WHERE org_id = p_org_id
    AND status <> 'left'
    AND revision < p_snapshot_revision;
  SELECT count(*) INTO absent_count
  FROM work.member
  WHERE org_id = p_org_id
    AND status <> 'left'
    AND revision < p_snapshot_revision
    AND NOT (subject_id = ANY (p_present_subjects));
  threshold := GREATEST(10, CEIL(total_members * 0.20)::integer);

  IF NOT p_allow_mass_absence AND absent_count >= threshold THEN
    PERFORM work.append_audit(
      p_org_id, NULL, 'directory.member_absence_blocked', 'org', p_org_id,
      jsonb_build_object(
        'revision', p_snapshot_revision,
        'current_revision', current_revision,
        'absent', absent_count,
        'total', total_members,
        'threshold', threshold,
        'allow_mass_absence', false
      )
    );
    RETURN -1;
  END IF;
  IF absent_count = 0 THEN
    RETURN 0;
  END IF;

  -- 0039: one epoch bump per mass-absence event. The org row is already locked
  -- FOR UPDATE above, so this keeps the lock direction 0019:200-210 requires. The
  -- value is published transaction-locally so the narrowing trigger retires this
  -- one epoch for every row of the batch instead of bumping per branch per row.
  UPDATE work.org SET access_epoch = access_epoch + 1, updated_at = now()
  WHERE id = p_org_id RETURNING access_epoch INTO v_epoch;
  PERFORM set_config('work.mass_absence_epoch', v_epoch::text, true);
  PERFORM set_config('work.mass_absence_epoch_org', p_org_id, true);

  FOR member_row IN
    SELECT * FROM work.member
    WHERE org_id = p_org_id
      AND status <> 'left'
      AND revision < p_snapshot_revision
      AND NOT (subject_id = ANY (p_present_subjects))
    ORDER BY subject_id
    FOR UPDATE
  LOOP
    UPDATE work.member
    SET status = 'left',
        work_seat = false,
        revision = p_snapshot_revision,
        updated_at = now()
    WHERE id = member_row.id;
    PERFORM work.append_audit(
      p_org_id, NULL, 'directory.member_absent', 'member', member_row.subject_id,
      jsonb_build_object(
        'revision', p_snapshot_revision,
        'current_revision', current_revision,
        'previous_status', member_row.status,
        'work_seat_revoked', member_row.work_seat,
        'entitlement_lost', member_row.status = 'active' OR member_row.work_seat
      )
    );
    affected := affected + 1;
  END LOOP;

  -- 0039: retire the hand-off. A second event in the same transaction must bump
  -- for itself; an aborted transaction never reaches this and the transaction-local
  -- setting disappears with the rollback.
  PERFORM set_config('work.mass_absence_epoch', '', true);
  PERFORM set_config('work.mass_absence_epoch_org', '', true);

  PERFORM work.append_audit(
    p_org_id, NULL, 'directory.member_absence_applied', 'org', p_org_id,
    jsonb_build_object(
      'revision', p_snapshot_revision,
      'current_revision', current_revision,
      'absent', affected,
      'total', total_members,
      'threshold', threshold,
      'allow_mass_absence', p_allow_mass_absence
    )
  );
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION work.mark_members_absent(text, text[], boolean, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.mark_members_absent(text, text[], boolean, bigint) TO work_directory;

RESET ROLE;
