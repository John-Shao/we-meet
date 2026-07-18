"""P1-4 M3 评测 harness:全局搜索 AI 问答的 20 问健康度评测。

对指定用户跑内置(或自定义)题库,逐问调 ``GlobalAskService.ask()``,
记录:各源状态 / 引用数 / 已用引用 / degraded / 耗时 / 期望源是否召回 /
``[n]`` 标记合法性,汇总成 markdown 报告。无 golden answer 比对(需人工
标注,见设计文档 §7 M3)——本 harness 盯的是**召回健康度 + 标记纪律 +
延迟**三件事,pro vs lite 对比跑两遍换 ``--endpoint`` 即可。

用法:
    # 默认题库(内置 20 问),默认 LLM 链(GLOBAL_ASK_LLM_ENDPOINT 回落现网 ep)
    python manage.py ask_eval --user someone@example.com

    # pro vs lite 对比:同一用户各跑一遍,报告横向对比
    python manage.py ask_eval --user 13800000000 --endpoint ep-pro-xxx --output pro.md
    python manage.py ask_eval --user 13800000000 --endpoint ep-lite-xxx --output lite.md

    # 自定义题库(JSON:[{"id","question","expect_sources":["transcripts",...]}])
    python manage.py ask_eval --user u@x.com --questions my20.json

只读业务数据;会真实调用 Ark LLM(计费),熔断/降级逻辑与线上一致。
"""

from __future__ import annotations

import json
import re
import time

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q

from core import models
from core.services.global_ask import GlobalAskService

_MARK_RE = re.compile(r"\[(\d{1,2})\]")

# 内置 20 问:通用问法按「期望源」分布 字幕6/日历4/纪要3/IM3/跨源2/负例2。
# 期望源=该问法理应召回的源(sources[s] == "ok");负例期望全空走罐头。
_DEFAULT_QUESTIONS: list[dict] = [
    # ---- 会议字幕(transcripts)×6
    {"id": "t1", "question": "最近的会议里讨论了哪些重要决定?", "expect_sources": ["transcripts"]},
    {"id": "t2", "question": "上次会议谁发言最多,主要讲了什么?", "expect_sources": ["transcripts"]},
    {"id": "t3", "question": "会议中有没有提到预算或成本相关的话题?", "expect_sources": ["transcripts"]},
    {"id": "t4", "question": "最近的会上分配了哪些任务给谁?", "expect_sources": ["transcripts"]},
    {"id": "t5", "question": "有没有会议讨论过上线或发布计划?", "expect_sources": ["transcripts"]},
    {"id": "t6", "question": "最近会议里提出的风险和问题有哪些?", "expect_sources": ["transcripts"]},
    # ---- 日历(calendar)×4
    {"id": "c1", "question": "我接下来一周有什么日程安排?", "expect_sources": ["calendar"]},
    {"id": "c2", "question": "下一个周会是什么时候?", "expect_sources": ["calendar"]},
    {"id": "c3", "question": "最近有没有和评审相关的日程?", "expect_sources": ["calendar"]},
    {"id": "c4", "question": "这个月还有哪些会议邀请?", "expect_sources": ["calendar"]},
    # ---- 纪要(summaries)×3
    {"id": "s1", "question": "上次会议的纪要结论是什么?", "expect_sources": ["summaries"]},
    {"id": "s2", "question": "会议纪要里记录了哪些待办事项?", "expect_sources": ["summaries"]},
    {"id": "s3", "question": "帮我总结一下最近一次会议纪要的要点。", "expect_sources": ["summaries"]},
    # ---- IM(im)×3
    {"id": "i1", "question": "聊天里有人发过会议链接或会议号吗?", "expect_sources": ["im"]},
    {"id": "i2", "question": "群里最近讨论过什么安排?", "expect_sources": ["im"]},
    {"id": "i3", "question": "有没有人在消息里提到文档或资料?", "expect_sources": ["im"]},
    # ---- 跨源 ×2
    {"id": "x1", "question": "关于下次评审,会议、日程和聊天里分别有什么信息?", "expect_sources": ["calendar"]},
    {"id": "x2", "question": "最近围绕项目进度都有哪些讨论和安排?", "expect_sources": []},
    # ---- 负例 ×2(期望四源全空 → 罐头回答,不调 LLM)
    {"id": "n1", "question": "量子引力场中的超弦紧化维度是多少?", "expect_sources": [], "expect_canned": True},
    {"id": "n2", "question": "zzzz乱码词组xqjvk不存在的东西", "expect_sources": [], "expect_canned": True},
]

_CANNED_MARKER = "没有找到"  # _EMPTY_ANSWER 的稳定子串(罐头判定)


class Command(BaseCommand):
    """Run the 20-question health eval against GlobalAskService."""

    help = "P1-4 全局搜索 AI 问答评测(20 问健康度 + 标记纪律 + 延迟)"

    def add_arguments(self, parser):
        parser.add_argument("--user", required=True, help="email / phone / User pk")
        parser.add_argument(
            "--endpoint",
            default="",
            help="临时覆盖 LLM ep(pro/lite 对比);缺省走 settings 链",
        )
        parser.add_argument(
            "--questions", default="", help="自定义题库 JSON 路径(缺省内置 20 问)"
        )
        parser.add_argument(
            "--output", default="", help="markdown 报告输出路径(缺省打印 stdout)"
        )

    # ------------------------------------------------------------------ util

    def _find_user(self, ident: str):
        qs = models.User.objects.filter(
            Q(email__iexact=ident) | Q(phone=ident)
        )
        user = qs.first()
        if user is None:
            try:
                user = models.User.objects.filter(pk=ident).first()
            except Exception:  # noqa: BLE001 — 非 UUID 形式
                user = None
        if user is None:
            raise CommandError(f"user not found: {ident}")
        return user

    def _build_service(self, endpoint: str) -> GlobalAskService:
        if not endpoint:
            return GlobalAskService()
        from django.conf import settings

        from core.services.llm_client import LLMClient

        api_key = getattr(settings, "ARK_API_KEY", None) or ""
        if not api_key:
            raise CommandError("ARK_API_KEY not configured — cannot override endpoint")
        kwargs = {"api_key": api_key, "model": endpoint}
        base_url = getattr(settings, "ARK_BASE_URL", None) or None
        if base_url:
            kwargs["base_url"] = base_url
        return GlobalAskService(llm=LLMClient(**kwargs))

    # ------------------------------------------------------------------ main

    def handle(self, *args, **options):
        user = self._find_user(str(options["user"]).strip())
        questions = _DEFAULT_QUESTIONS
        if options["questions"]:
            with open(options["questions"], encoding="utf-8") as fh:
                questions = json.load(fh)

        service = self._build_service(str(options["endpoint"]).strip())
        rows: list[dict] = []
        for q in questions:
            started = time.monotonic()
            try:
                result = service.ask(user=user, question=q["question"])
            except Exception as exc:  # noqa: BLE001 — 单问失败不拖垮整评
                rows.append(
                    {"q": q, "error": str(exc)[:200], "elapsed": time.monotonic() - started}
                )
                self.stderr.write(f"  ✗ {q['id']}: {exc}")
                continue
            elapsed = time.monotonic() - started
            citations = result.get("citations") or []
            used = result.get("citations_used") or []
            answer = result.get("answer") or ""
            sources = result.get("sources") or {}
            # 标记纪律:正文里的 [n] 全部落在 1..len(citations) 内。
            marks = [int(m) for m in _MARK_RE.findall(answer)]
            marks_ok = all(1 <= n <= len(citations) for n in marks) if marks else True
            expected = [s for s in q.get("expect_sources", []) if s]
            rows.append(
                {
                    "q": q,
                    "elapsed": elapsed,
                    "sources": sources,
                    "n_citations": len(citations),
                    "n_used": len(used),
                    "degraded": bool(result.get("degraded")),
                    "canned": _CANNED_MARKER in answer and not citations,
                    "marks_ok": marks_ok,
                    "expected_hit": all(sources.get(s) == "ok" for s in expected),
                    "answer_len": len(answer),
                    "model_used": result.get("model_used") or "",
                }
            )
            self.stdout.write(
                f"  ✓ {q['id']}: {elapsed:.1f}s cites={len(citations)} "
                f"used={len(used)} degraded={result.get('degraded')}"
            )

        report = self._render(user, rows, str(options["endpoint"]).strip())
        if options["output"]:
            with open(options["output"], "w", encoding="utf-8") as fh:
                fh.write(report)
            self.stdout.write(self.style.SUCCESS(f"report → {options['output']}"))
        else:
            self.stdout.write(report)

    # ---------------------------------------------------------------- report

    def _render(self, user, rows: list[dict], endpoint: str) -> str:
        ok_rows = [r for r in rows if "error" not in r]
        n = len(ok_rows) or 1
        avg = sum(r["elapsed"] for r in ok_rows) / n
        slowest = max((r["elapsed"] for r in ok_rows), default=0.0)
        hit = sum(1 for r in ok_rows if r["expected_hit"])
        with_expect = sum(1 for r in ok_rows if r["q"].get("expect_sources"))
        marks_bad = [r for r in ok_rows if not r["marks_ok"]]
        degraded = sum(1 for r in ok_rows if r["degraded"])
        canned_wrong = [
            r
            for r in ok_rows
            if r["q"].get("expect_canned") and not r["canned"]
        ]
        used_rate = sum(1 for r in ok_rows if r["n_used"] > 0 and not r["canned"])

        lines = [
            "# 全局搜索 AI 问答评测报告",
            "",
            f"- 用户:{user.email or user.phone or user.pk}",
            f"- LLM ep:{endpoint or '(settings 链缺省)'}",
            f"- 题数:{len(rows)}(异常 {len(rows) - len(ok_rows)})",
            f"- 期望源召回:{hit}/{with_expect}",
            f"- 平均耗时:{avg:.1f}s / 最慢 {slowest:.1f}s",
            f"- degraded:{degraded};标记违例:{len(marks_bad)};"
            f"罐头误放行:{len(canned_wrong)};引用使用率:{used_rate}/{n}",
            "",
            "| id | 耗时 | 引用 | 已用 | 期望源命中 | 标记 | degraded | 备注 |",
            "|----|-----:|-----:|-----:|:---:|:---:|:---:|------|",
        ]
        for r in rows:
            q = r["q"]
            if "error" in r:
                lines.append(f"| {q['id']} | {r['elapsed']:.1f}s | - | - | - | - | - | ERROR: {r['error'][:60]} |")
                continue
            note = "罐头" if r["canned"] else ""
            lines.append(
                f"| {q['id']} | {r['elapsed']:.1f}s | {r['n_citations']} | {r['n_used']} "
                f"| {'✓' if r['expected_hit'] else '✗'} | {'✓' if r['marks_ok'] else '✗'} "
                f"| {'!' if r['degraded'] else ''} | {note} |"
            )
        lines.append("")
        lines.append(
            "> 期望源召回=题目标注的源在本次回答中状态为 ok;标记=正文 [n] 全部落在引用区间;"
            "pro/lite 对比:换 --endpoint 再跑一遍对照本表。"
        )
        return "\n".join(lines)
