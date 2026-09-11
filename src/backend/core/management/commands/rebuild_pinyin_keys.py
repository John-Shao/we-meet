"""Recompute the directory's derived pinyin columns for every user.

为什么需要这个入口(而不是「迁移里回填过一次就够了」):

``full_name_pinyin`` / ``full_name_initial`` / ``search_key`` 是 **save() 维护**的派生列,
迁移 ``0144`` / ``0145`` 各回填过一次 —— 一次性。可是**旧代码也写这几列**:

- 打上 ``0144`` 之前的镜像,``User.save()`` 会写出**没有桶类前缀**的
  ``full_name_pinyin``(新格式是 ``0zhangsan`` / ``11001``);
- 打上 ``0145`` 之前的镜像根本不知道 ``search_key`` 这个字段,新建/改名的行在那一列
  留下空串。

滚动发布的窗口里这正是现状:migrate 是 Helm 的 pre-upgrade hook,旧 Pod 在迁移提交
之后、被替换之前仍在服务,这期间任何一个用户被改名或新建,那一行的键就是旧格式。
后果不是报错而是**静默错位**:

- 排序键少了 ``0`` / ``1`` 前缀,而目录是 ``ORDER BY full_name_pinyin, full_name``;
  在 ``en_US.utf8`` 下数字排在字母前,于是这个人**排到整个名册的第一行**;
- ``search_key`` 是空串,拼音搜索(``q=ye``)永远搜不到他。

而迁移已经标记为已应用,不会有任何代码再去修这两列 —— 唯一会自愈的路径是「有人再
保存一次这个用户」。所以留一个可以随时重跑、幂等的入口:发布后在 backend 容器里跑
一次 ``--check`` 确认没有残留;真有残留就 ``--dry-run`` 看一眼、再正式跑一次。

    python manage.py rebuild_pinyin_keys --check      # 只报告,有残留则以退出码 1 结束
    python manage.py rebuild_pinyin_keys --dry-run    # 只报告
    python manage.py rebuild_pinyin_keys              # 修

算法复用 ``core/services/pinyin.py``(与运行时同一份,不另抄一遍),只写**真的算错**
的行,并按批 ``bulk_update``。
"""

from django.core.management.base import BaseCommand
from django.db import transaction

from core.models import User
from core.services.pinyin import pinyin_initial, pinyin_search_key, pinyin_sort_key

#: 一批写多少行。仅影响往返次数,不改变语义(bulk_update 是逐批一条 UPDATE)。
DEFAULT_BATCH_SIZE = 500

#: `--dry-run` 最多逐行打印几条。真实的残留通常是个位数(只可能是滚动发布窗口里
#: 动过的那几个账号);大组织里万一真的整表都旧,逐行打印会把日志刷爆,而总数才是
#: 有用的信息。
MAX_REPORTED_ROWS = 20


class Command(BaseCommand):
    help = "Recompute User.full_name_pinyin / full_name_initial / search_key."

    def add_arguments(self, parser):
        parser.add_argument(
            "--batch-size",
            type=int,
            default=DEFAULT_BATCH_SIZE,
            help=f"Rows per bulk_update (default {DEFAULT_BATCH_SIZE}).",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report the rows that would change, write nothing.",
        )
        parser.add_argument(
            "--check",
            action="store_true",
            help="Like --dry-run, but exit 1 when any row is stale (post-deploy gate).",
        )

    def handle(self, *args, **options):
        batch_size = options["batch_size"]
        if batch_size < 1:
            batch_size = DEFAULT_BATCH_SIZE
        dry_run = options["dry_run"] or options["check"]

        total = 0
        stale = 0
        batch = []
        # 把要写的那几列一起 select 出来:`.only()` 里漏掉谁,谁就会在下面按行触发
        # 一次额外查询(派生列每行都读)。
        rows = User.objects.only(
            "id",
            "full_name",
            "short_name",
            "full_name_pinyin",
            "full_name_initial",
            "search_key",
        ).iterator(chunk_size=batch_size)

        for user in rows:
            total += 1
            expected_sort = pinyin_sort_key(user.full_name)
            expected_initial = pinyin_initial(user.full_name)
            expected_search = pinyin_search_key(user.full_name, user.short_name)
            if (
                user.full_name_pinyin == expected_sort
                and user.full_name_initial == expected_initial
                and user.search_key == expected_search
            ):
                continue
            stale += 1
            if dry_run:
                if stale <= MAX_REPORTED_ROWS:
                    self.stdout.write(
                        f"  stale user={user.id} name={user.full_name!r} "
                        f"sort={user.full_name_pinyin!r}->{expected_sort!r} "
                        f"search={user.search_key!r}->{expected_search!r}"
                    )
                elif stale == MAX_REPORTED_ROWS + 1:
                    self.stdout.write("  ... (further rows not listed)")
                continue
            user.full_name_pinyin = expected_sort
            user.full_name_initial = expected_initial
            user.search_key = expected_search
            batch.append(user)
            if len(batch) >= batch_size:
                self._flush(batch)
                batch = []
        if batch:
            self._flush(batch)

        if dry_run:
            self.stdout.write(
                self.style.WARNING(
                    f"{'Stale' if stale else 'No stale'} rows: {stale} of {total} "
                    "need rebuilding."
                )
            )
        else:
            self.stdout.write(
                self.style.SUCCESS(f"Rebuilt {stale} of {total} user row(s).")
            )
        if options["check"] and stale:
            raise SystemExit(1)

    @staticmethod
    def _flush(batch):
        """一批一个短事务:失败时不至于把整表回填回滚掉(重跑是幂等的)。"""
        with transaction.atomic():
            User.objects.bulk_update(
                batch,
                ["full_name_pinyin", "full_name_initial", "search_key"],
            )
