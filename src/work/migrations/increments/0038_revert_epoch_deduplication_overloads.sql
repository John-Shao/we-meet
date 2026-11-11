-- 0038 (卡片 #101, H1 revert): 撤除 0037 添加的两个 record_member_narrowing overload。
--
-- 0037 首稿把 "epoch deduplication 性能优化（2N→N+1）" 当成 R0b 上线前的独立增量部署，
-- 生产 pg_proc 现在确有 3 行：0019/0023 触发器版 0 参 + 0037 手动版 4 参 + 0037 手动版
-- 5 参 `_with_intents`。三张 body 引用的表 work.org_member /
-- work.org_member_narrowing_event / work.org_member_intent_narrowing 与 work.org 的
-- member_epoch 列，在 baseline 0002 与 0003–0037 全部 increment 与 catalog 里零命中；
-- work.org 只有 access_epoch，没有 member_epoch。Go/TS 全仓 grep
-- record_member_narrowing 只命中 function_privilege_sweep_pg_test.go:135 的一行注释，
-- 注释自陈"EXECUTE-granted to work_owner alone and have no caller"。
--
-- 机制后果：plpgsql 在 CREATE OR REPLACE 时不解析函数体，CREATE 通过、catalog checksum
-- 与 ledger=37 都是真的，但 SELECT work.record_member_narrowing(uuid,uuid,text,jsonb)
-- 首次调用即 42P01 relation "work.org_member" does not exist——属"无实现面"而非"未测"。
--
-- 处置：0037 首稿是范围误判（"epoch dedup 独立增量" 未先问"表在不在、caller 有没有"，
-- memory feedback-verify-doc-knobs-wired 同族），撤回成本最低。DROP 两个 overload，
-- 0019/0023 0 参触发器版**保留不动**——那一个是 R0b governance-authority held surface
-- 成员（卡片 E=B 与 023:177 生效体），不属于本次撤回范围。
--
-- 半径：一个 increment + catalog + manifest 一条 + function_privilege_sweep 注释同步；
-- 零可观测行为变化（原本就无 caller）。不改 0037 文件本体，历史保留。

DROP FUNCTION work.record_member_narrowing(p_org_id UUID, p_member_id UUID, p_narrowing_type TEXT, p_details JSONB);
DROP FUNCTION work.record_member_narrowing_with_intents(p_org_id UUID, p_member_id UUID, p_narrowing_type TEXT, p_intent_ids UUID[], p_details JSONB);
